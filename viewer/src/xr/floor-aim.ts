import * as THREE from 'three';
import type { Collision, Hit } from '../collision';
import { isValidLanding, type Reach } from './landing';
import { headYaw, pointerRay, stick, type Pointer } from './pointer';

const SPEED = 8;
const GRAVITY = 9.81;
const SEGMENTS = 40;
const STEP_TIME = 0.035;
const BALLISTIC_RANGE = 10;
const STRAIGHT_RANGE = 25;
const RIBBON_WIDTH = 0.018;
const STICK_FACING = 0.6;
const VALID = 0x35d0ff;
const INVALID = 0xff4d4d;

export type Destination = { point: THREE.Vector3; yaw: number | null };

export type Raycastable = Pick<Collision, 'raycast'>;
export type PathResult = { hit: Hit | null; last: number };
/** Fills `samples` from index 0 to the returned `last`, and stops at the first hit. */
export type AimPath = (from: THREE.Ray, collision: Raycastable, samples: THREE.Vector3[]) => PathResult;

const segment = new THREE.Vector3();
const stepRay = new THREE.Ray();

/** The arc a thrown object would take: lets the user reach floor they can't see directly. */
export const ballisticPath: AimPath = (from, collision, samples) => {
  const { origin, direction } = from;
  const velocity = direction.clone().multiplyScalar(SPEED);
  samples[0].copy(origin);
  for (let i = 1; i <= SEGMENTS; i++) {
    const t = i * STEP_TIME;
    const p = samples[i].set(
      origin.x + velocity.x * t,
      origin.y + velocity.y * t - 0.5 * GRAVITY * t * t,
      origin.z + velocity.z * t,
    );
    if (Math.hypot(p.x - origin.x, p.z - origin.z) > BALLISTIC_RANGE) return { hit: null, last: i - 1 };
    segment.subVectors(p, samples[i - 1]);
    const length = segment.length();
    stepRay.origin.copy(samples[i - 1]);
    stepRay.direction.copy(segment).divideScalar(length);
    const hit = collision.raycast(stepRay, length);
    if (hit) {
      p.copy(hit.point);
      return { hit, last: i };
    }
  }
  return { hit: null, last: SEGMENTS };
};

export const straightPath: AimPath = (from, collision, samples) => {
  const hit = collision.raycast(from, STRAIGHT_RANGE);
  samples[0].copy(from.origin);
  if (hit) samples[1].copy(hit.point);
  else from.at(STRAIGHT_RANGE, samples[1]);
  return { hit, last: 1 };
};

const headPos = new THREE.Vector3();
const side = new THREE.Vector3();
const toEye = new THREE.Vector3();
const gripPos = new THREE.Vector3();
const offset = new THREE.Vector3();
const ray = new THREE.Ray();

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
  return { group, ring, chevron, stand, ringMaterial, standMaterial };
}

export type FloorAimOptions = {
  path: AimPath;
  /** The aiming pointer's thumbstick chooses which way the destination faces. */
  facing: boolean;
  /** Preview a person standing at the destination. */
  stand: boolean;
};

/** Aims at floor between `begin` and `release`, which commits; the thumbstick can add a facing. */
export class FloorAim {
  private collision: Collision | null = null;
  private active: Pointer | null = null;
  private destination: { point: THREE.Vector3; valid: boolean } | null = null;
  private yaw: number | null = null;
  private ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private ribbonPositions = new Float32Array((SEGMENTS + 1) * 6);
  private samples = Array.from({ length: SEGMENTS + 1 }, () => new THREE.Vector3());
  private marker = buildMarker();
  /** Null until the navmesh arrives, or when none could be built. */
  reach: Reach | null = null;

  commit: (destination: Destination, pointer: Pointer) => void = () => {};

  constructor(scene: THREE.Scene, private camera: THREE.Camera, private floorY: () => number, private options: FloorAimOptions) {
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
    this.marker.chevron.visible = options.stand;
    scene.add(this.ribbon, this.marker.group);
  }

  get aiming() {
    return this.active != null;
  }

  setModel(collision: Collision) {
    this.collision = collision;
  }

  begin(pointer: Pointer) {
    if (this.active || !this.collision) return;
    this.active = pointer;
    this.yaw = null;
  }

  release(pointer: Pointer) {
    if (this.active !== pointer) return;
    const { destination, yaw } = this;
    this.cancel();
    if (destination?.valid) this.commit({ point: destination.point, yaw }, pointer);
  }

  abandon(pointer: Pointer) {
    if (this.active === pointer) this.cancel();
  }

  cancel() {
    this.active = null;
    this.destination = null;
    this.ribbon.visible = false;
    this.marker.group.visible = false;
  }

  private headHeight() {
    this.camera.getWorldPosition(headPos);
    return headPos.y - this.floorY();
  }

  private updateFacing(pointer: Pointer, heading: number) {
    if (!this.options.facing) return;
    const axes = stick(pointer.source);
    // Stick straight ahead means "face along the aim"; centring it keeps the last choice.
    if (axes && Math.hypot(axes[0], axes[1]) > STICK_FACING) this.yaw = heading + Math.atan2(-axes[0], -axes[1]);
  }

  private drawRibbon(pointer: Pointer, last: number, color: number) {
    // A transient pointer's ray starts at the eyes; start the visible path at the hand instead.
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
    group.rotation.y = this.yaw ?? headYaw(this.camera);
    const color = valid ? VALID : INVALID;
    ringMaterial.color.setHex(color);
    standMaterial.color.setHex(color);
    stand.visible = valid && this.options.stand;
    if (stand.visible) {
      const height = Math.max(this.headHeight(), 1);
      stand.scale.y = height / 1.26;
      stand.position.y = height / 2;
    }
  }

  update() {
    const pointer = this.active;
    if (!pointer || !this.collision) return;
    if (!pointer.ray.visible) return this.cancel();

    pointerRay(pointer, ray);
    const { hit, last } = this.options.path(ray, this.collision, this.samples);
    this.updateFacing(pointer, Math.atan2(-ray.direction.x, -ray.direction.z));
    const valid = hit != null && isValidLanding(this.collision, hit, this.headHeight(), this.reach);
    this.destination = hit && { point: hit.point, valid };
    this.drawRibbon(pointer, last, valid ? VALID : INVALID);
    this.drawMarker(hit, valid);
  }
}
