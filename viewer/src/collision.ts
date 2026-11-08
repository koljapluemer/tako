import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3, type Intersection } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { CollisionPart } from './worker-protocol';

export type Hit = {
  point: Vector3;
  /** Faces back toward the ray, regardless of the source geometry's winding. */
  normal: Vector3;
  kind: 'floor' | 'solid';
  expressID: number;
  distance: number;
};

class Part {
  private bvh: MeshBVH;
  private geometry = new BufferGeometry();

  constructor(private data: CollisionPart) {
    this.geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    this.bvh = MeshBVH.deserialize(data.bvh, this.geometry, { setIndex: true });
  }

  raycast(ray: Ray, far: number): Intersection | null {
    return this.bvh.raycastFirst(ray, DoubleSide, 0, far) as Intersection | null;
  }

  distanceTo(point: Vector3, max: number): number {
    const hit = this.bvh.closestPointToPoint(point, undefined, 0, max);
    return hit ? hit.distance : Infinity;
  }

  expressIdOf(faceIndex: number): number {
    const { rangeStarts, rangeIds } = this.data;
    let lo = 0;
    let hi = rangeStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rangeStarts[mid] <= faceIndex) lo = mid;
      else hi = mid - 1;
    }
    return rangeIds[lo];
  }

  dispose() {
    this.geometry.dispose();
  }
}

export class Collision {
  private floorPart: Part | null;
  private solidPart: Part | null;

  constructor(floor: CollisionPart | null, solid: CollisionPart | null) {
    this.floorPart = floor && new Part(floor);
    this.solidPart = solid && new Part(solid);
  }

  get hasFloor() {
    return this.floorPart != null;
  }

  private toHit(i: Intersection, part: Part, kind: Hit['kind'], ray: Ray): Hit {
    const normal = i.face!.normal.clone();
    if (normal.dot(ray.direction) > 0) normal.negate();
    return { point: i.point.clone(), normal, kind, expressID: part.expressIdOf(i.faceIndex!), distance: i.distance };
  }

  /** Nearest hit on anything that blocks a person. Doors and spaces are not in here. */
  raycast(ray: Ray, far: number): Hit | null {
    const f = this.floorPart?.raycast(ray, far) ?? null;
    const s = this.solidPart?.raycast(ray, far) ?? null;
    if (f && (!s || f.distance <= s.distance)) return this.toHit(f, this.floorPart!, 'floor', ray);
    if (s) return this.toHit(s, this.solidPart!, 'solid', ray);
    return null;
  }

  /** Ignores furniture and the like: only floor-class surfaces can carry someone. */
  raycastFloor(ray: Ray, far: number): Hit | null {
    const f = this.floorPart?.raycast(ray, far) ?? null;
    return f && this.toHit(f, this.floorPart!, 'floor', ray);
  }

  /** Distance to the nearest blocking surface; Infinity if none within `max`. */
  distanceTo(point: Vector3, max: number): number {
    return Math.min(this.floorPart?.distanceTo(point, max) ?? Infinity, this.solidPart?.distanceTo(point, max) ?? Infinity);
  }

  dispose() {
    this.floorPart?.dispose();
    this.solidPart?.dispose();
  }
}
