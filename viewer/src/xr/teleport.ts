import * as THREE from 'three';
import type { Collision, Hit } from '../collision';
import { isValidLanding } from './landing';

const SPEED = 8;
const GRAVITY = 9.81;
const SEGMENTS = 40;
const STEP_TIME = 0.035;
const MAX_RANGE = 10;
const RIBBON_WIDTH = 0.018;
const HOLD_MS = 200;
const STICK_ON = 0.7;
const STICK_OFF = 0.25;
const STICK_FACING = 0.6;
const VALID = 0x35d0ff;
const INVALID = 0xff4d4d;

export type Pointer = {
  index: number;
  ray: THREE.Group;
  grip: THREE.Group;
  source: XRInputSource | null;
  downAt: number | null;
  /** This press belongs to UI or has already become an aim. */
  consumed: boolean;
};

export type Destination = { point: THREE.Vector3; yaw: number | null };

const rayOrigin = new THREE.Vector3();
const rayDirection = new THREE.Vector3();
const headPos = new THREE.Vector3();
const segment = new THREE.Vector3();
const side = new THREE.Vector3();
const toEye = new THREE.Vector3();
const gripPos = new THREE.Vector3();
const offset = new THREE.Vector3();
const ray = new THREE.Ray();

export function pointerRay(pointer: Pointer, out: THREE.Ray): THREE.Ray {
  pointer.ray.getWorldPosition(out.origin);
  out.direction.set(0, 0, -1).transformDirection(pointer.ray.matrixWorld);
  return out;
}

/** Forward-facing heading of the head, in radians around +Y. */
export function headYaw(camera: THREE.Camera): number {
  const d = camera.getWorldDirection(new THREE.Vector3());
  return Math.atan2(-d.x, -d.z);
}

/** Thumbstick axes; xr-standard puts them at 2/3, some older mappings at 0/1. */
function stick(source: XRInputSource | null): [number, number] | null {
  const pad = source?.gamepad;
  if (!pad || source!.hand || source!.targetRayMode !== 'tracked-pointer') return null;
  const a = pad.axes;
  if (a.length >= 4 && (a[2] !== 0 || a[3] !== 0)) return [a[2], a[3]];
  if (a.length >= 2 && a.length < 4) return [a[0], a[1]];
  return a.length >= 4 ? [a[2], a[3]] : null;
}

function buildMarker() {
  const ringMaterial = new THREE.MeshBasicMaterial({ color: VALID, side: THREE.DoubleSide, transparent: true, opacity: 0.95 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.26, 40).rotateX(-Math.PI / 2), ringMaterial);

  const shape = new THREE.Shape();
  shape.moveTo(0, 0.17);
  shape.lineTo(-0.12, 0);
  shape.lineTo(-0.06, 0);
  shape.lineTo(0, 0.09);
  shape.lineTo(0.06, 0);
  shape.lineTo(0.12, 0);
  shape.closePath();
  const chevron = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2), ringMaterial);
  chevron.position.z = -0.31;

  const standMaterial = new THREE.MeshBasicMaterial({ color: VALID, transparent: true, opacity: 0.22, depthWrite: false });
  const stand = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 1, 4, 16), standMaterial);

  const group = new THREE.Group();
  group.add(ring, chevron, stand);
  group.visible = false;
  return { group, ring, stand, ringMaterial, standMaterial };
}

/**
 * Relocates the user when the building outgrows the room. Press-and-hold works
 * on every input type (controller trigger, hand pinch, Vision Pro's
 * transient-pointer); a thumbstick adds choosing which way to face.
 */
export class Teleport {
  private collision: Collision | null = null;
  private active: Pointer | null = null;
  private mode: 'hold' | 'stick' = 'hold';
  private destination: { point: THREE.Vector3; valid: boolean } | null = null;
  private stickYaw: number | null = null;
  private arcHeading = 0;
  private ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private ribbonPositions = new Float32Array((SEGMENTS + 1) * 6);
  private samples = Array.from({ length: SEGMENTS + 1 }, () => new THREE.Vector3());
  private marker = buildMarker();
  locked = false;

  /** First refusal on a press: UI claims it here. */
  claim: (pointer: Pointer) => boolean = () => false;
  tap: (pointer: Pointer) => void = () => {};
  commit: (destination: Destination, pointer: Pointer) => void = () => {};

  constructor(scene: THREE.Scene, private camera: THREE.Camera, private floorY: () => number) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.ribbonPositions, 3).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    this.ribbon = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: VALID, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
    this.ribbon.frustumCulled = false;
    this.ribbon.visible = false;
    this.ribbon.renderOrder = 8000;
    scene.add(this.ribbon, this.marker.group);
  }

  setModel(collision: Collision) {
    this.collision = collision;
  }

  selectStart(pointer: Pointer) {
    pointer.downAt = performance.now();
    pointer.consumed = this.claim(pointer);
  }

  selectEnd(pointer: Pointer) {
    const wasShort = pointer.downAt != null && !pointer.consumed;
    pointer.downAt = null;
    pointer.consumed = false;
    if (this.active === pointer && this.mode === 'hold') return this.release();
    if (wasShort && !this.active && !this.locked) this.tap(pointer);
  }

  disconnected(pointer: Pointer) {
    if (this.active === pointer) this.cancel();
    pointer.downAt = null;
    pointer.consumed = false;
  }

  cancel() {
    this.active = null;
    this.destination = null;
    this.ribbon.visible = false;
    this.marker.group.visible = false;
  }

  private release() {
    const pointer = this.active!;
    const destination = this.destination;
    const yaw = this.mode === 'stick' ? this.stickYaw : null;
    this.cancel();
    if (destination?.valid && !this.locked) this.commit({ point: destination.point, yaw }, pointer);
  }

  private start(pointer: Pointer, mode: 'hold' | 'stick') {
    this.active = pointer;
    this.mode = mode;
    this.stickYaw = null;
  }

  private headHeight() {
    this.camera.getWorldPosition(headPos);
    return headPos.y - this.floorY();
  }

  /** Steps the ballistic arc until it hits something. */
  private trace(pointer: Pointer): { hit: Hit | null; last: number } {
    pointerRay(pointer, ray);
    rayOrigin.copy(ray.origin);
    rayDirection.copy(ray.direction);
    this.arcHeading = Math.atan2(-rayDirection.x, -rayDirection.z);
    const velocity = rayDirection.clone().multiplyScalar(SPEED);
    this.samples[0].copy(rayOrigin);
    for (let i = 1; i <= SEGMENTS; i++) {
      const t = i * STEP_TIME;
      const p = this.samples[i].set(
        rayOrigin.x + velocity.x * t,
        rayOrigin.y + velocity.y * t - 0.5 * GRAVITY * t * t,
        rayOrigin.z + velocity.z * t,
      );
      if (Math.hypot(p.x - rayOrigin.x, p.z - rayOrigin.z) > MAX_RANGE) return { hit: null, last: i - 1 };
      segment.subVectors(p, this.samples[i - 1]);
      const length = segment.length();
      ray.origin.copy(this.samples[i - 1]);
      ray.direction.copy(segment).divideScalar(length);
      const hit = this.collision!.raycast(ray, length);
      if (hit) {
        p.copy(hit.point);
        return { hit, last: i };
      }
    }
    return { hit: null, last: SEGMENTS };
  }

  private drawRibbon(pointer: Pointer, last: number, color: number) {
    // A transient pointer's ray starts at the eyes; start the visible arc at the hand instead.
    offset.set(0, 0, 0);
    if (pointer.source?.targetRayMode === 'transient-pointer' && pointer.grip.visible) {
      pointer.grip.getWorldPosition(gripPos);
      offset.subVectors(gripPos, this.samples[0]);
    }
    this.camera.getWorldPosition(headPos);
    const out = this.ribbonPositions;
    for (let i = 0; i <= last; i++) {
      const p = this.samples[i];
      const next = this.samples[Math.min(i + 1, last)];
      const previous = this.samples[Math.max(i - 1, 0)];
      segment.subVectors(next, previous);
      toEye.subVectors(headPos, p);
      side.crossVectors(segment, toEye).normalize().multiplyScalar(RIBBON_WIDTH / 2);
      const blend = 1 - i / last;
      const x = p.x + offset.x * blend;
      const y = p.y + offset.y * blend;
      const z = p.z + offset.z * blend;
      out.set([x - side.x, y - side.y, z - side.z, x + side.x, y + side.y, z + side.z], i * 6);
    }
    const geometry = this.ribbon.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.setDrawRange(0, last * 6);
    this.ribbon.material.color.setHex(color);
    this.ribbon.visible = true;
  }

  private drawMarker(hit: Hit | null, valid: boolean) {
    const { group, stand, ringMaterial, standMaterial } = this.marker;
    if (!hit) {
      group.visible = false;
      return;
    }
    group.visible = true;
    group.position.copy(hit.point);
    group.position.y += 0.012;
    // Align to the surface only when it can be stood on; on a wall that would stand the ring upright.
    group.rotation.y = this.mode === 'stick' && this.stickYaw != null ? this.stickYaw : headYaw(this.camera);
    const color = valid ? VALID : INVALID;
    ringMaterial.color.setHex(color);
    standMaterial.color.setHex(color);
    stand.visible = valid;
    if (valid) {
      const height = Math.max(this.headHeight(), 1);
      stand.scale.y = height / 1.26;
      stand.position.y = height / 2;
    }
  }

  private pollStart() {
    if (this.locked) return;
    return (pointer: Pointer) => {
      if (this.active) return;
      const axes = stick(pointer.source);
      if (axes && axes[1] < -STICK_ON && pointer.downAt == null) this.start(pointer, 'stick');
      else if (pointer.downAt != null && !pointer.consumed && performance.now() - pointer.downAt > HOLD_MS) {
        pointer.consumed = true;
        this.start(pointer, 'hold');
      }
    };
  }

  update(pointers: Pointer[]) {
    if (!this.collision) return;
    const poll = this.pollStart();
    if (poll) pointers.forEach(poll);
    const pointer = this.active;
    if (!pointer) return;
    if (!pointer.ray.visible) return this.cancel();

    const { hit, last } = this.trace(pointer);
    if (this.mode === 'stick') {
      const axes = stick(pointer.source);
      const magnitude = axes ? Math.hypot(axes[0], axes[1]) : 0;
      if (axes && magnitude > STICK_FACING) {
        // Stick straight ahead means "face along the arc"; turning it turns the landing.
        this.stickYaw = this.arcHeading + Math.atan2(-axes[0], -axes[1]);
      }
      if (magnitude < STICK_OFF) {
        this.updateDestination(hit);
        return this.release();
      }
    }
    this.updateDestination(hit);
    const valid = this.destination?.valid ?? false;
    this.drawRibbon(pointer, last, valid ? VALID : INVALID);
    this.drawMarker(hit, valid);
  }

  private updateDestination(hit: Hit | null) {
    if (!hit) {
      this.destination = null;
      return;
    }
    this.destination = { point: hit.point, valid: isValidLanding(this.collision!, hit, this.headHeight()) };
  }
}
