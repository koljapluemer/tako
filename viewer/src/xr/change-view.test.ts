import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { changeView, facing } from './change-view';

const centre = new THREE.Vector3(0, 1, 0);
const anywhere = (p: THREE.Vector3) => p.clone();
const open = () => true;

describe('facing', () => {
  it('matches headYaw: 0 looks down −Z', () => {
    expect(facing(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1))).toBeCloseTo(0);
    expect(facing(new THREE.Vector3(0, 0, 0), new THREE.Vector3(-1, 0, 0))).toBeCloseTo(Math.PI / 2);
  });
});

describe('changeView', () => {
  it('stands on the user\'s side, facing the change', () => {
    const view = changeView(centre, 0, new THREE.Vector3(10, 0, 0), { nearest: anywhere, clear: open })!;
    expect(view.point.x).toBeCloseTo(2.5);
    expect(view.point.z).toBeCloseTo(0);
    expect(view.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('tries other sides when the view is blocked', () => {
    const clear = (from: THREE.Vector3) => from.x < -1;
    const view = changeView(centre, 0, new THREE.Vector3(10, 0, 0), { nearest: anywhere, clear })!;
    expect(view.point.x).toBeLessThan(-1);
    expect(view.yaw).toBeCloseTo(facing(view.point, centre));
  });

  it('falls back to the nearest walkable point when no view is clear', () => {
    const view = changeView(centre, 0, new THREE.Vector3(10, 0, 0), { nearest: anywhere, clear: () => false })!;
    expect(view.point.x).toBeCloseTo(0);
    expect(view.point.z).toBeCloseTo(0);
  });

  it('gives up without any walkable surface', () => {
    expect(changeView(centre, 0, new THREE.Vector3(10, 0, 0), { nearest: () => null, clear: open })).toBeNull();
  });
});
