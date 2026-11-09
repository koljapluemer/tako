import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Spawn, type Spot } from './spawn';

const spot = (x: number, name = 'spot'): Spot => ({ name, position: new THREE.Vector3(x, 0, 0) });

describe('Spawn', () => {
  it('uses the latest offer until someone is placed', () => {
    const spawn = new Spawn();
    expect(spawn.spot).toBeNull();
    spawn.offer(spot(1));
    spawn.offer(spot(2));
    expect(spawn.phase).toBe('open');
    expect(spawn.spot?.position.x).toBe(2);
  });

  it('keeps the placed spot when the navmesh offers a better one later', () => {
    const spawn = new Spawn();
    spawn.offer(spot(1));
    spawn.pin(spawn.spot!);
    spawn.offer(spot(2, 'Entrance'));
    expect(spawn.phase).toBe('pinned');
    expect(spawn.spot?.position.x).toBe(1);
  });

  it('keeps the first pin', () => {
    const spawn = new Spawn();
    spawn.pin(spot(1));
    spawn.pin(spot(2));
    expect(spawn.spot?.position.x).toBe(1);
  });

  it('goes back to the best offer on release', () => {
    const spawn = new Spawn();
    spawn.offer(spot(1));
    spawn.pin(spawn.spot!);
    spawn.offer(spot(2, 'Entrance'));
    spawn.release();
    expect(spawn.phase).toBe('open');
    expect(spawn.spot?.name).toBe('Entrance');
  });

  it('moves only the pin with an origin shift, leaving the offered spot alone', () => {
    const spawn = new Spawn();
    const offered = spot(1);
    spawn.offer(offered);
    spawn.pin(offered);
    spawn.translate(new THREE.Vector3(5, 0, 0));
    expect(spawn.spot?.position.x).toBe(6);
    expect(offered.position.x).toBe(1);
    spawn.release();
    expect(spawn.spot?.position.x).toBe(1);
  });

  it('ignores an origin shift while open', () => {
    const spawn = new Spawn();
    spawn.offer(spot(1));
    spawn.translate(new THREE.Vector3(5, 0, 0));
    expect(spawn.spot?.position.x).toBe(1);
  });
});
