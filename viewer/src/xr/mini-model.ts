import * as THREE from 'three';
import type { LoadedModel } from '../model';
import type { NavPoint } from '../nav/points';
import { PinPress, turntableDelta, twoHandPlacement, visiblePins, type Placement, type Vec3 } from './mini-gestures';
import { fitScale, LONGEST_SIDE } from './mini-view';
import { CanvasPanel, type LimitedRay } from './panel';

const GRAB_MARGIN = 0.06;
const PIN_RADIUS = 0.022;
const PIN_THICKNESS = 0.004;
/** Keeps the disc from z-fighting with the floor it sits on. */
const PIN_LIFT = 0.002;
const PIN_TOP = PIN_LIFT + PIN_THICKNESS;
const LABEL_HEIGHT = 0.08;
const RAY_SNAP = Math.sin(THREE.MathUtils.degToRad(5));
/** After the building's own glass, before UI panels. */
const RENDER_ORDER = 8400;

const COLOR = { pin: 0x35d0ff, entrance: 0x7dff9b, stair: 0xffc14d, hover: 0xffffff, you: 0xff5a5a };

type Hand = { id: number; position: THREE.Vector3 };
type Pin = { point: NavPoint; mesh: THREE.Mesh; x: number; z: number; level: number; importance: number; press: Map<number, PinPress> };
export type MiniInput = {
  user: { x: number; y: number; z: number; yaw: number };
  grabs: Hand[];
  tips: Hand[];
  picks: LimitedRay[];
};

const toVec = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const point = new THREE.Vector3();

function material(color: number, opacity: number) {
  // `transparent` puts these after the building's own glass, whatever their opacity.
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: opacity >= 1 });
}

/**
 * The world in miniature: the building's own meshes at a small scale, sharing their
 * geometry so it costs draw calls but no memory. It stands in the building like any
 * object: walls hide it.
 */
export class MiniModel {
  private root = new THREE.Group();
  private content = new THREE.Group();
  private marker: THREE.Mesh;
  private label = new CanvasPanel(0.2, 0.05);
  private building = new THREE.Group();
  private shells: Array<{ material: THREE.Material; opacity: number }> = [];
  private opacityValue = 1;
  private pinsOn = true;
  private pins: Pin[] = [];
  private shown: Pin[] = [];
  private source: LoadedModel | null = null;
  private origin = new THREE.Vector3();
  private scale = 1;
  private radius = LONGEST_SIDE / 2;
  private zoom = 1;
  private shownZoom = 0;
  private built = false;
  private grabs = new Map<number, THREE.Vector3>();
  private twoHand: { start: Placement; a: Vec3; b: Vec3; ids: [number, number] } | null = null;
  private lastGrab: THREE.Vector3 | null = null;
  private opened = false;

  onCommit: (point: NavPoint) => void = () => {};

  constructor(scene: THREE.Scene) {
    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.035, 12).rotateX(-Math.PI / 2), material(COLOR.you, 1));
    this.marker.renderOrder = RENDER_ORDER + 2;

    this.label.mesh.renderOrder = RENDER_ORDER + 3;
    this.root.add(this.building, this.content, this.marker);
    this.root.visible = false;
    scene.add(this.root, this.label.mesh);
  }

  private get available() {
    return this.source?.nav != null;
  }

  get opacity() {
    return this.opacityValue;
  }

  get pinsVisible() {
    return this.pinsOn;
  }

  /** Covers the building. Pins and the marker are controls, with their own toggle. */
  setOpacity(opacity: number) {
    this.opacityValue = opacity;
    for (const shell of this.shells) {
      shell.material.opacity = shell.opacity * opacity;
      shell.material.depthWrite = shell.material.opacity >= 1;
    }
  }

  setPinsVisible(on: boolean) {
    if (on === this.pinsOn) return;
    this.pinsOn = on;
    this.shownZoom = 0;
    this.highlight(null);
  }

  /** Stays open across a revision swap: empty until the new navmesh arrives. */
  setData(source: LoadedModel | null) {
    this.source = source;
    this.built = false;
    if (!this.opened) return;
    this.clear();
    this.grabs.clear();
    this.twoHand = null;
    this.lastGrab = null;
    this.showIfReady();
  }

  private showIfReady() {
    if (this.available && !this.built) this.build();
    this.root.visible = this.built;
  }

  private clear() {
    this.highlight(null);
    this.content.traverse((child) => (child as THREE.Mesh).geometry?.dispose());
    this.content.clear();
    // The geometry belongs to the building.
    this.building.clear();
    this.shells.forEach(({ material }) => material.dispose());
    this.shells = [];
    this.pins.forEach(({ mesh }) => (mesh.material as THREE.Material).dispose());
    this.pins = [];
    this.shown = [];
  }

  private build() {
    this.clear();
    const { group, points, doorCells } = this.source!;
    // Merged meshes already draw these; the individual ones are for fading up close.
    const doors = new Set<THREE.Object3D>(doorCells.flatMap((cell) => cell.doors.map((door) => door.mesh)));
    const meshes = group.children.filter((child) => !doors.has(child)) as THREE.Mesh[];

    const box = new THREE.Box3();
    for (const { geometry } of meshes) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      box.union(geometry.boundingBox!);
    }
    const size = box.getSize(new THREE.Vector3());
    this.scale = fitScale(size.x, size.z, size.y);
    box.getCenter(this.origin).setY(box.min.y);
    this.radius = Math.hypot(size.x, size.z) * this.scale / 2;
    this.building.scale.setScalar(this.scale);
    this.building.position.copy(this.origin).multiplyScalar(-this.scale);

    const clones = new Map<THREE.Material, THREE.Material>();
    for (const source of meshes) {
      // A change highlight may be showing on the mesh right now.
      const original = (source.userData.baseMaterial ?? source.material) as THREE.Material;
      let clone = clones.get(original);
      if (!clone) {
        clone = original.clone();
        // `transparent` puts these after the building's own glass, whatever their opacity.
        clone.transparent = true;
        clones.set(original, clone);
        this.shells.push({ material: clone, opacity: original.opacity });
      }
      const mesh = new THREE.Mesh(source.geometry, clone);
      // Glass draws over everything solid in the model.
      mesh.renderOrder = original.opacity < 1 ? RENDER_ORDER : RENDER_ORDER - 1;
      this.building.add(mesh);
    }
    this.setOpacity(this.opacityValue);

    const disc = new THREE.CylinderGeometry(PIN_RADIUS, PIN_RADIUS, PIN_THICKNESS, 32).translate(0, PIN_LIFT + PIN_THICKNESS / 2, 0);
    this.pins = points.map((p) => {
      const pinMaterial = material(p.type === 'entrance' ? COLOR.entrance : p.type === 'stair' ? COLOR.stair : COLOR.pin, 1);
      const mesh = new THREE.Mesh(disc, pinMaterial);
      mesh.renderOrder = RENDER_ORDER + 1;
      this.mapPoint(p.position[0], p.position[1], p.position[2], mesh.position);
      this.content.add(mesh);
      return { point: p, mesh, x: p.position[0], z: p.position[2], level: p.level, importance: p.importance, press: new Map() };
    });
    this.shownZoom = 0;
    this.built = true;
  }

  /** Building metres to the model's own space. */
  private mapPoint(x: number, y: number, z: number, out: THREE.Vector3) {
    return out.set(x, y, z).sub(this.origin).multiplyScalar(this.scale);
  }

  /** Aligned with the building, so directions in the model match the real ones. */
  open(position: THREE.Vector3) {
    this.root.position.copy(position);
    this.root.rotation.set(0, 0, 0);
    this.zoom = 1;
    this.root.scale.setScalar(1);
    this.grabs.clear();
    this.twoHand = null;
    this.lastGrab = null;
    this.opened = true;
    this.shownZoom = 0;
    this.showIfReady();
  }

  close() {
    this.opened = false;
    this.root.visible = false;
    this.highlight(null);
    this.grabs.clear();
    this.twoHand = null;
  }

  translate(shift: THREE.Vector3) {
    this.root.position.add(shift);
  }

  /** Returns true when the hand is close enough to take hold of the model. */
  grabStart(id: number, position: THREE.Vector3): boolean {
    if (!this.opened || !this.built) return false;
    if (Math.hypot(position.x - this.root.position.x, position.z - this.root.position.z) > this.radius * this.zoom + GRAB_MARGIN) return false;
    this.grabs.set(id, position.clone());
    this.twoHand = null;
    this.lastGrab = null;
    return true;
  }

  grabEnd(id: number) {
    if (!this.grabs.delete(id)) return;
    this.twoHand = null;
    this.lastGrab = null;
  }

  /** Ray fallback: snaps to the nearest pin in the pointing direction. */
  press({ ray, far }: LimitedRay): boolean {
    if (!this.opened) return false;
    let best: Pin | null = null;
    let bestDistance = Infinity;
    for (const pin of this.shown) {
      pin.mesh.getWorldPosition(point);
      const along = point.sub(ray.origin).dot(ray.direction);
      if (along <= 0 || along > far) continue;
      const sideways = Math.sqrt(Math.max(point.lengthSq() - along * along, 0));
      if (sideways / along < RAY_SNAP && sideways < bestDistance) {
        best = pin;
        bestDistance = sideways;
      }
    }
    if (!best) return false;
    this.commit(best);
    return true;
  }

  private commit(pin: Pin) {
    this.onCommit(pin.point);
  }

  update({ user, grabs, tips, picks }: MiniInput) {
    if (!this.opened || !this.built) return;
    this.applyGrabs(grabs);
    this.root.updateMatrixWorld(true);
    this.refreshPins();
    this.updateMarker(user);
    if (!this.updatePins(tips)) this.updateHover(picks);
  }

  private applyGrabs(hands: Hand[]) {
    const active = hands.filter((hand) => this.grabs.has(hand.id));
    if (active.length >= 2) {
      const [first, second] = active;
      if (!this.twoHand) {
        this.twoHand = {
          start: { position: toVec(this.root.position), yaw: this.root.rotation.y, zoom: this.zoom },
          a: toVec(first.position), b: toVec(second.position), ids: [first.id, second.id],
        };
      }
      const { start, a, b } = this.twoHand;
      const next = twoHandPlacement(start, a, b, toVec(first.position), toVec(second.position));
      this.root.position.set(...next.position);
      this.root.rotation.y = next.yaw;
      this.zoom = next.zoom;
      this.root.scale.setScalar(next.zoom);
    } else if (active.length === 1) {
      const position = active[0].position;
      if (this.lastGrab) this.root.rotation.y += turntableDelta(toVec(this.root.position), toVec(this.lastGrab), toVec(position));
      this.lastGrab = position.clone();
    }
  }

  private refreshPins() {
    if (this.zoom === this.shownZoom) return;
    this.shownZoom = this.zoom;
    this.shown = this.pinsOn ? visiblePins(this.pins, this.scale, this.zoom) : [];
    const visible = new Set(this.shown);
    for (const pin of this.pins) {
      pin.mesh.visible = visible.has(pin);
      // Buttons stay finger-sized however far the model is zoomed.
      pin.mesh.scale.setScalar(1 / this.zoom);
    }
  }

  private updateMarker({ x, y, z, yaw }: MiniInput['user']) {
    this.mapPoint(x, y, z, this.marker.position);
    this.marker.position.y += 0.02;
    this.marker.rotation.y = yaw;
    this.marker.scale.setScalar(1 / this.zoom);
  }

  /** Returns whether a fingertip is in contact with a pin. */
  private updatePins(tips: Hand[]) {
    let touched: Pin | null = null;
    for (const pin of this.shown) {
      pin.mesh.getWorldPosition(point);
      for (const tip of tips) {
        let press = pin.press.get(tip.id);
        if (!press) pin.press.set(tip.id, (press = new PinPress()));
        const height = tip.position.y - (point.y + PIN_TOP);
        const lateral = Math.hypot(tip.position.x - point.x, tip.position.z - point.z);
        const event = press.update(height, lateral);
        if (event === 'commit') {
          this.commit(pin);
          return true;
        }
        if (press.touching) touched = pin;
      }
    }
    this.highlight(touched);
    return touched != null;
  }

  private updateHover(picks: LimitedRay[]) {
    let best: Pin | null = null;
    for (const { ray, far } of picks) {
      for (const pin of this.shown) {
        pin.mesh.getWorldPosition(point);
        const along = point.sub(ray.origin).dot(ray.direction);
        if (along > 0 && along <= far && Math.sqrt(Math.max(point.lengthSq() - along * along, 0)) / along < RAY_SNAP) best ??= pin;
      }
    }
    this.highlight(best);
  }

  private highlighted: Pin | null = null;

  private highlight(pin: Pin | null) {
    if (pin === this.highlighted) {
      if (pin) this.placeLabel(pin);
      return;
    }
    if (this.highlighted) (this.highlighted.mesh.material as THREE.MeshBasicMaterial).color.setHex(colorOf(this.highlighted.point));
    this.highlighted = pin;
    this.label.mesh.visible = pin != null;
    if (!pin) return;
    (pin.mesh.material as THREE.MeshBasicMaterial).color.setHex(COLOR.hover);
    const { ctx, canvasWidth: w, canvasHeight: h } = this.label;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20,22,26,0.9)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = '500 32px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pin.point.name, w / 2, h / 2, w - 16);
    this.label.refresh();
    this.placeLabel(pin);
  }

  private placeLabel(pin: Pin) {
    pin.mesh.getWorldPosition(this.label.mesh.position);
    this.label.mesh.position.y += LABEL_HEIGHT;
    this.label.mesh.rotation.y = this.root.rotation.y;
  }
}

function colorOf(point: NavPoint) {
  return point.type === 'entrance' ? COLOR.entrance : point.type === 'stair' ? COLOR.stair : COLOR.pin;
}
