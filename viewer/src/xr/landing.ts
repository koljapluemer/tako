import * as THREE from 'three';
import type { Collision, Hit } from '../collision';
import type { StoreyInfo } from '../worker-protocol';

export const STEP = 0.35;
const BODY_RADIUS = 0.2;
const MAX_SLOPE_COS = Math.cos(THREE.MathUtils.degToRad(35));
const DOWN = new THREE.Vector3(0, -1, 0);

export type Landing = { name: string; position: THREE.Vector3 };

/** Can someone of this height stand here? Spheres start above step height so the floor itself doesn't count. */
export function isValidLanding(collision: Collision, hit: Hit, headHeight: number): boolean {
  if (hit.kind !== 'floor' || hit.normal.y < MAX_SLOPE_COS) return false;
  const top = hit.point.y + Math.max(headHeight, 1);
  const center = hit.point.clone();
  for (center.y = hit.point.y + STEP + BODY_RADIUS; center.y < top; center.y += BODY_RADIUS * 1.5) {
    if (collision.distanceTo(center, BODY_RADIUS) < BODY_RADIUS) return false;
  }
  center.y = top;
  return collision.distanceTo(center, BODY_RADIUS) >= BODY_RADIUS;
}

const ray = new THREE.Ray();

function probe(collision: Collision, terrain: Set<number>, x: number, y: number, z: number, headHeight: number): THREE.Vector3 | null {
  ray.origin.set(x, y + 0.5, z);
  ray.direction.copy(DOWN);
  const hit = collision.raycast(ray, 1);
  return hit && !terrain.has(hit.expressID) && isValidLanding(collision, hit, headHeight) ? hit.point : null;
}

function storeyLanding(collision: Collision, terrain: Set<number>, s: StoreyInfo): THREE.Vector3 | null {
  const CLEAR = 0.8;
  const HEAD = 1.7;
  for (const [x0, z0, x1, z1] of s.stairBoxes) {
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const ring: Array<[number, number]> = [
      [x0 - CLEAR, cz], [x1 + CLEAR, cz], [cx, z0 - CLEAR], [cx, z1 + CLEAR],
      [x0 - CLEAR, z0 - CLEAR], [x1 + CLEAR, z0 - CLEAR], [x0 - CLEAR, z1 + CLEAR], [x1 + CLEAR, z1 + CLEAR],
    ];
    for (const [x, z] of ring) {
      const p = probe(collision, terrain, x, s.floorY, z, HEAD);
      if (p) return p;
    }
  }
  // No usable stair: search the largest slab from its centre outward (the centre may be an atrium).
  const [x0, z0, x1, z1] = s.slabBox;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const grid: Array<[number, number]> = [];
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) grid.push([x0 + ((x1 - x0) * i) / 8, z0 + ((z1 - z0) * j) / 8]);
  }
  grid.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cz) - Math.hypot(b[0] - cx, b[1] - cz));
  for (const [x, z] of grid) {
    const p = probe(collision, terrain, x, s.floorY, z, HEAD);
    if (p) return p;
  }
  return null;
}

export function storeyLandings(collision: Collision, storeys: StoreyInfo[], terrain: Set<number>): Array<Landing & { elevation: number | null }> {
  return storeys.flatMap((s) => {
    const position = storeyLanding(collision, terrain, s);
    return position ? [{ name: s.name, position, elevation: s.elevation }] : [];
  });
}

/** Ground level is the storey nearest elevation 0; comparing magnitudes works in any file unit. */
export function spawnLanding(landings: Array<Landing & { elevation: number | null }>): Landing | null {
  if (!landings.length) return null;
  return landings.reduce((a, b) => (Math.abs(b.elevation ?? Infinity) < Math.abs(a.elevation ?? Infinity) ? b : a));
}
