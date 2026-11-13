import * as THREE from 'three';
import type { Collision, NavMesh } from '../collision';
import type { DoorCell, DoorInfo } from '../model';
import type { Fade } from './fade';
import { STEP } from './landing';

const HEAD_RADIUS = 0.12;
const DOOR_FADE_NEAR = 0.6;
const DOOR_FADE_FAR = 1.2;
const OFF_FLOOR_DIM = 0.6;
const OFF_FLOOR_DELAY = 0.25;
/** Above step height, below the head: railings, parapets, furniture. */
const BODY_PROBE_HEIGHTS = [0.55, 0.95];
const BODY_RADIUS = 0.12;
const BODY_DIM = 0.35;
/** Someone who has walked clean through a wall shouldn't be left in the dark. */
const BLOCKED_RECOVERY = 2;
const DOWN = new THREE.Vector3(0, -1, 0);
const PROBES: Array<[number, number]> = [[0, 0], [0.15, 0], [-0.15, 0], [0, 0.15], [0, -0.15]];

const ray = new THREE.Ray();
const head = new THREE.Vector3();
const body = new THREE.Vector3();
const toHead = new THREE.Vector3();

/**
 * Natural Walking: the head is tracked 1:1 and this only makes the building
 * respond. The rig's Y follows the floor underfoot; the rig is never pushed
 * sideways, because the person's real position can't be overridden.
 */
export class Walking {
  private collision: Collision | null = null;
  private doorCells: DoorCell[] = [];
  private nav: NavMesh | null = null;
  private wallHint = 0;
  private lastClear: THREE.Vector3 | null = null;
  private blockedFor = 0;
  private offFloorFor = 0;
  /** Head XZ and floor height at the last spot that was on the floor and clear. */
  lastValid: THREE.Vector3 | null = null;
  floorY = 0;

  constructor(private rig: THREE.Group, private camera: THREE.Camera, private fade: Fade) {}

  setModel(collision: Collision, doorCells: DoorCell[]) {
    this.restoreDoors();
    this.collision = collision;
    this.doorCells = doorCells;
    this.nav = null;
    this.lastClear = null;
  }

  setNavigation(nav: NavMesh | null) {
    this.nav = nav;
  }

  /** After the rig has been moved on purpose (teleport, recentre, reload). */
  resetTracking(floorY: number) {
    this.floorY = floorY;
    this.rig.position.y = floorY;
    this.lastClear = null;
    this.blockedFor = 0;
    this.offFloorFor = 0;
  }

  /** Floor underfoot within step range of `nearY`, tolerating hairline gaps between slabs. */
  floorAt(x: number, z: number, nearY: number): number | null {
    if (!this.collision) return null;
    for (const [dx, dz] of PROBES) {
      ray.origin.set(x + dx, nearY + STEP + 0.05, z + dz);
      ray.direction.copy(DOWN);
      const hit = this.collision.raycastFloor(ray, 2 * STEP + 0.05);
      if (hit) return hit.point.y;
    }
    return this.navFloorAt(x, z, nearY);
  }

  /** Floors that aren't floor-class (proxies, for one), and door thresholds, are known only to the navmesh. */
  private navFloorAt(x: number, z: number, nearY: number): number | null {
    const surface = this.nav?.at(x, nearY, z, STEP + 0.05);
    if (!surface) return null;
    ray.origin.set(x, nearY + STEP + 0.05, z);
    ray.direction.copy(DOWN);
    return this.collision!.raycast(ray, 2 * STEP + 0.05)?.point.y ?? surface.y;
  }

  private inDoorway(x: number, z: number) {
    const margin = 0.2;
    return this.doorCells.some((cell) => cell.doors.some(({ box }) =>
      x > box.min.x - margin && x < box.max.x + margin && z > box.min.z - margin && z < box.max.z + margin
      && this.floorY + 1 > box.min.y && this.floorY < box.max.y));
  }

  private updateFloor(dt: number): boolean {
    const y = this.floorAt(head.x, head.z, this.floorY);
    if (y != null) {
      this.floorY = y;
      this.offFloorFor = 0;
      this.fade.set('edge', 0);
      return true;
    }
    if ((!this.collision?.hasFloor && !this.nav) || this.inDoorway(head.x, head.z)) {
      // Slabs often stop at the door opening; that isn't a ledge.
      this.fade.set('edge', 0);
      return false;
    }
    this.offFloorFor += dt;
    this.fade.set('edge', this.offFloorFor > OFF_FLOOR_DELAY ? OFF_FLOOR_DIM : 0);
    return false;
  }

  private updateWalls(dt: number): boolean {
    const collision = this.collision!;
    const distance = collision.distanceTo(head, HEAD_RADIUS);
    let crossed = false;
    if (this.lastClear) {
      toHead.subVectors(head, this.lastClear);
      const length = toHead.length();
      if (length > 1e-4) {
        ray.origin.copy(this.lastClear);
        ray.direction.copy(toHead).divideScalar(length);
        crossed = collision.raycast(ray, length) != null;
      }
    }

    if (crossed) {
      // In a thick wall the nearest surface can be out of range, so distance alone isn't enough.
      this.blockedFor += dt;
      if (this.blockedFor > BLOCKED_RECOVERY && distance >= HEAD_RADIUS) this.lastClear = head.clone();
      this.fade.set('wall', 1);
      this.wallHint = 1;
      return false;
    }
    this.blockedFor = 0;
    if (distance >= HEAD_RADIUS) {
      this.lastClear = head.clone();
      this.fade.set('wall', 0);
      this.wallHint = 0;
      return true;
    }
    const level = THREE.MathUtils.smoothstep(HEAD_RADIUS - distance, 0, HEAD_RADIUS * 0.7);
    this.fade.set('wall', level);
    this.wallHint = level;
    return false;
  }

  /** Low obstacles only warn: like walls, the user can't be pushed. */
  private updateBody(onFloor: boolean) {
    const collision = this.collision!;
    const blocked = onFloor && BODY_PROBE_HEIGHTS.some((height) => {
      body.set(head.x, this.floorY + height, head.z);
      return collision.distanceTo(body, BODY_RADIUS) < BODY_RADIUS;
    });
    this.fade.set('body', blocked ? BODY_DIM : 0);
    this.fade.showHint(Math.max(this.wallHint, blocked ? 1 : 0));
  }

  private updateDoors() {
    for (const cell of this.doorCells) {
      // Beyond the fade range every door is at full opacity, so the swap can't be seen.
      const near = cell.box.distanceToPoint(head) < DOOR_FADE_FAR;
      if (near !== cell.near) this.setCellNear(cell, near);
      if (!near) continue;
      for (const door of cell.doors) {
        const d = door.box.distanceToPoint(head);
        const k = 0.15 + 0.85 * THREE.MathUtils.smoothstep(d, DOOR_FADE_NEAR, DOOR_FADE_FAR);
        this.setDoorOpacity(door, door.baseOpacity * k);
      }
    }
  }

  private setCellNear(cell: DoorCell, near: boolean) {
    cell.near = near;
    cell.merged.forEach((mesh) => (mesh.visible = !near));
    cell.doors.forEach((door) => {
      door.mesh.visible = near;
      if (!near) this.setDoorOpacity(door, door.baseOpacity);
    });
  }

  private setDoorOpacity({ material, baseOpacity }: DoorInfo, opacity: number) {
    if (material.opacity === opacity) return;
    material.opacity = opacity;
    const transparent = baseOpacity < 1 || opacity < 1;
    if (material.transparent !== transparent) {
      material.transparent = transparent;
      // `transparent` is compiled into the shader; without this an opaque door keeps alpha 1.
      material.needsUpdate = true;
    }
    material.depthWrite = !transparent;
  }

  restoreDoors() {
    for (const cell of this.doorCells) {
      // Back to the desktop arrangement; the next VR frame re-evaluates each cell.
      this.setCellNear(cell, true);
      cell.near = null;
      cell.doors.forEach((d) => this.setDoorOpacity(d, d.baseOpacity));
    }
  }

  update(dt: number) {
    if (!this.collision) return;
    this.camera.getWorldPosition(head);
    const onFloor = this.updateFloor(dt);
    this.rig.position.y += (this.floorY - this.rig.position.y) * (1 - Math.exp(-dt / 0.05));
    const clear = this.updateWalls(dt);
    this.updateBody(onFloor);
    this.updateDoors();
    if (onFloor && clear) (this.lastValid ??= new THREE.Vector3()).set(head.x, this.floorY, head.z);
  }
}
