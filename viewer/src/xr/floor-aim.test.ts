import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Hit } from '../collision';
import { ballisticPath, straightPath, type Raycastable } from './floor-aim';

const samples = () => Array.from({ length: 41 }, () => new THREE.Vector3());
const nothing: Raycastable = { raycast: () => null };

/** A floor at y = 0. */
const floor: Raycastable = {
  raycast(ray, far) {
    if (ray.direction.y >= 0) return null;
    const distance = -ray.origin.y / ray.direction.y;
    if (distance < 0 || distance > far) return null;
    return { point: ray.at(distance, new THREE.Vector3()), normal: new THREE.Vector3(0, 1, 0), kind: 'floor', expressID: 1, distance } satisfies Hit;
  },
};

const downwards = () => new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, -1).normalize());

describe('aim paths', () => {
  it('straight path ends at the hit, in a straight line', () => {
    const out = samples();
    const { hit, last } = straightPath(downwards(), floor, out);
    expect(last).toBe(1);
    expect(hit?.point.z).toBeCloseTo(-1);
    expect(out[1].y).toBeCloseTo(0);
  });

  it('straight path still draws when it hits nothing', () => {
    const out = samples();
    const { hit, last } = straightPath(downwards(), nothing, out);
    expect(hit).toBeNull();
    expect(out[last].length()).toBeGreaterThan(10);
  });

  it('ballistic path falls short of the straight line and stops at the hit', () => {
    const out = samples();
    const level = new THREE.Ray(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
    const { hit, last } = ballisticPath(level, floor, out);
    expect(hit).not.toBeNull();
    expect(out[last].y).toBeCloseTo(0);
    expect(last).toBeGreaterThan(1);
  });

  it('leaves the input ray untouched', () => {
    const ray = downwards();
    const before = ray.clone();
    ballisticPath(ray, floor, samples());
    expect(ray.equals(before)).toBe(true);
  });
});
