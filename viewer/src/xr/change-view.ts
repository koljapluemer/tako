import * as THREE from 'three';
import type { Destination } from './floor-aim';

const STAND_OFF = 2.5;
const DIRECTIONS = 8;
const EYE = 1.6;
const NAV_REACH = 1.5;
const FALLBACK_REACH = 30;

export type ViewQueries = {
  /** The nearest walkable point within `max`, or null. */
  nearest: (point: THREE.Vector3, max: number) => THREE.Vector3 | null;
  /** True when nothing blocks the line from `from` to `to`. */
  clear: (from: THREE.Vector3, to: THREE.Vector3) => boolean;
};

/** `yaw` as in `headYaw`: facing from `from` towards `to`. */
export function facing(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/**
 * A spot to stand that looks at `centre`: a few metres off it, walkable, with a clear line of sight.
 * Directions are tried starting from the user's side, so the jump is as short as it can be.
 */
export function changeView(centre: THREE.Vector3, floorY: number, user: THREE.Vector3, { nearest, clear }: ViewQueries): Destination | null {
  const start = Math.atan2(user.x - centre.x, user.z - centre.z);
  const eye = new THREE.Vector3();
  for (let i = 0; i < DIRECTIONS; i++) {
    // 0, +1, -1, +2, -2, …: alternate sides of the user's direction.
    const step = Math.ceil(i / 2) * (i % 2 ? 1 : -1);
    const angle = start + (step * 2 * Math.PI) / DIRECTIONS;
    const candidate = new THREE.Vector3(centre.x + Math.sin(angle) * STAND_OFF, floorY, centre.z + Math.cos(angle) * STAND_OFF);
    const spot = nearest(candidate, NAV_REACH);
    if (!spot) continue;
    eye.set(spot.x, spot.y + EYE, spot.z);
    if (clear(eye, centre)) return { point: spot, yaw: facing(spot, centre) };
  }
  const spot = nearest(new THREE.Vector3(centre.x, floorY, centre.z), FALLBACK_REACH);
  return spot && { point: spot, yaw: facing(spot, centre) };
}
