import * as THREE from 'three';
import type { NavMesh } from '../collision';
import type { NavLevel, NavPoint } from '../nav/points';
import { PinPress, turntableDelta, twoHandPlacement, visiblePins, type Placement, type Vec3 } from './mini-gestures';
import { CanvasPanel } from './panel';

const LONGEST_SIDE = 0.55;
const DISTANCE = 0.5;
const BELOW_HEAD = 0.55;
const LEVEL_GAP = 0.13;
const WALL_HEIGHT_M = 2.2;
const GRAB_MARGIN = 0.06;
const WELD = 0.05;
const STEM = 0.03;
const PIN_RADIUS = 0.012;
const RAY_SNAP = Math.sin(THREE.MathUtils.degToRad(5));
/** Late enough to draw over the whole building, early enough to stay under UI panels. */
const RENDER_ORDER = 8400;

const COLOR = { floor: 0xc9d4de, wall: 0x7d8a96, pin: 0x35d0ff, entrance: 0x7dff9b, stair: 0xffc14d, hover: 0xffffff, you: 0xff5a5a };

type Hand = { id: number; position: THREE.Vector3 };
type Pin = { point: NavPoint; mesh: THREE.Mesh; x: number; z: number; level: number; importance: number; press: Map<number, PinPress> };
export type MiniInput = {
  user: { x: number; y: number; z: number; yaw: number };
  grabs: Hand[];
  tips: Hand[];
  rays: THREE.Ray[];
};

const toVec = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];
const point = new THREE.Vector3();
const local = new THREE.Vector3();

function levelIndex(y: number, levels: NavLevel[]) {
  let best = 0;
  levels.forEach((level, i) => {
    if (Math.abs(level.y - y) < Math.abs(levels[best].y - y)) best = i;
  });
  return best;
}

/** Floor triangles, plus walls extruded from edges that only one triangle uses. */
function levelGeometry(positions: Float32Array, levels: NavLevel[]): Array<{ floors: number[]; walls: number[] }> {
  const out = levels.map(() => ({ floors: [] as number[], walls: [] as number[] }));
  const edges = levels.map(() => new Map<string, { count: number; a: Vec3; b: Vec3 }>());
  const weld = (p: Vec3) => `${Math.round(p[0] / WELD)},${Math.round(p[2] / WELD)}`;
  for (let t = 0; t < positions.length; t += 9) {
    const corners: Vec3[] = [0, 3, 6].map((o) => [positions[t + o], positions[t + o + 1], positions[t + o + 2]]);
    const level = levelIndex((corners[0][1] + corners[1][1] + corners[2][1]) / 3, levels);
    out[level].floors.push(...corners.flat());
    corners.forEach((a, i) => {
      const b = corners[(i + 1) % 3];
      const [ka, kb] = [weld(a), weld(b)];
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const edge = edges[level].get(key);
      if (edge) edge.count++;
      else edges[level].set(key, { count: 1, a, b });
    });
  }
  edges.forEach((map, level) => {
    for (const { count, a, b } of map.values()) {
      if (count !== 1) continue;
      const [ax, ay, az] = a;
      const [bx, by, bz] = b;
      const top = WALL_HEIGHT_M;
      out[level].walls.push(ax, ay, az, bx, by, bz, bx, by + top, bz, ax, ay, az, bx, by + top, bz, ax, ay + top, az);
    }
  });
  return out;
}

function material(color: number, opacity: number) {
  // `transparent` puts these after the building's own glass, whatever their opacity.
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: opacity >= 1 });
}

/**
 * The world in miniature. Built from the navmesh rather than the building, so it
 * stays cheap on any model. Clears depth before drawing: a nearby wall must not
 * cut through it, but it still needs depth of its own.
 */
export class MiniModel {
  private root = new THREE.Group();
  private content = new THREE.Group();
  private depthClear: THREE.Mesh;
  private marker: THREE.Mesh;
  private label = new CanvasPanel(0.2, 0.05);
  private levelMeshes: Array<{ floor: THREE.Mesh; walls: THREE.Mesh }> = [];
  private pins: Pin[] = [];
  private shown: Pin[] = [];
  private levels: NavLevel[] = [];
  private points: NavPoint[] = [];
  private nav: NavMesh | null = null;
  private origin = new THREE.Vector3();
  private scale = 1;
  private radius = LONGEST_SIDE / 2;
  private zoom = 1;
  private shownZoom = 0;
  private built = false;
  private currentLevel = -1;
  private grabs = new Map<number, THREE.Vector3>();
  private twoHand: { start: Placement; a: Vec3; b: Vec3; ids: [number, number] } | null = null;
  private lastGrab: THREE.Vector3 | null = null;
  private opened = false;

  private solidFloor = material(COLOR.floor, 1);
  private solidWall = material(COLOR.wall, 1);
  private ghostFloor = material(COLOR.floor, 0.18);
  private ghostWall = material(COLOR.wall, 0.12);

  onCommit: (point: NavPoint) => void = () => {};

  constructor(scene: THREE.Scene) {
    this.depthClear = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ transparent: true }));
    this.depthClear.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    this.depthClear.frustumCulled = false;
    this.depthClear.renderOrder = RENDER_ORDER - 1;
    this.depthClear.onBeforeRender = (renderer) => renderer.clearDepth();

    this.marker = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.035, 12).rotateX(-Math.PI / 2), material(COLOR.you, 1));
    this.marker.renderOrder = RENDER_ORDER + 2;

    this.label.mesh.renderOrder = RENDER_ORDER + 3;
    this.root.add(this.depthClear, this.content, this.marker);
    this.root.visible = false;
    scene.add(this.root, this.label.mesh);
  }

  get available() {
    return this.nav != null && this.levels.length > 0;
  }

  setData(nav: NavMesh | null, points: NavPoint[], levels: NavLevel[]) {
    this.nav = nav;
    this.points = points;
    this.levels = levels;
    this.built = false;
    if (this.opened) {
      if (this.available) this.build();
      else this.close();
    }
  }

  private clear() {
    for (const child of [...this.content.children]) {
      this.content.remove(child);
      (child as THREE.Mesh).geometry?.dispose();
    }
    this.pins.forEach(({ mesh }) => (mesh.material as THREE.Material).dispose());
    this.levelMeshes = [];
    this.pins = [];
    this.shown = [];
  }

  private build() {
    this.clear();
    const positions = this.nav!.positions;
    const box = new THREE.Box3();
    for (let i = 0; i < positions.length; i += 3) box.expandByPoint(point.set(positions[i], positions[i + 1], positions[i + 2]));
    const size = box.getSize(new THREE.Vector3());
    this.scale = LONGEST_SIDE / Math.max(size.x, size.z, 1);
    box.getCenter(this.origin);
    this.radius = Math.hypot(size.x, size.z) * this.scale / 2;

    levelGeometry(positions, this.levels).forEach(({ floors, walls }, level) => {
      const make = (values: number[]) => {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.transform(values, level), 3));
        const mesh = new THREE.Mesh(geometry, this.ghostFloor);
        mesh.renderOrder = RENDER_ORDER;
        this.content.add(mesh);
        return mesh;
      };
      this.levelMeshes.push({ floor: make(floors), walls: make(walls) });
    });

    const stem = new THREE.CylinderGeometry(PIN_RADIUS, PIN_RADIUS, 0.006, 16).translate(0, STEM, 0);
    const shaft = new THREE.CylinderGeometry(0.0015, 0.0015, STEM, 6).translate(0, STEM / 2, 0);
    const shape = new THREE.BufferGeometry().copy(stem);
    const merged = mergeTwo(shape, shaft);
    this.pins = this.points.map((p) => {
      const pinMaterial = material(p.type === 'entrance' ? COLOR.entrance : p.type === 'stair' ? COLOR.stair : COLOR.pin, 1);
      const mesh = new THREE.Mesh(merged, pinMaterial);
      mesh.renderOrder = RENDER_ORDER + 1;
      this.mapPoint(p.position[0], p.position[1], p.position[2], p.level, mesh.position);
      this.content.add(mesh);
      return { point: p, mesh, x: p.position[0], z: p.position[2], level: p.level, importance: p.importance, press: new Map() };
    });
    this.shownZoom = 0;
    this.currentLevel = -1;
    this.built = true;
  }

  /** Building metres to the model's own space, with levels pulled apart. */
  private mapPoint(x: number, y: number, z: number, level: number, out: THREE.Vector3) {
    const levelY = this.levels[level]?.y ?? 0;
    return out.set((x - this.origin.x) * this.scale, (y - levelY) * this.scale + level * LEVEL_GAP, (z - this.origin.z) * this.scale);
  }

  private transform(values: number[], level: number) {
    const out = new Float32Array(values.length);
    for (let i = 0; i < values.length; i += 3) {
      this.mapPoint(values[i], values[i + 1], values[i + 2], level, local);
      out.set([local.x, local.y, local.z], i);
    }
    return out;
  }

  /** The position is reset each time; the ray only picks the direction. */
  open(ray: THREE.Ray, head: THREE.Vector3) {
    if (!this.available) return;
    if (!this.built) this.build();
    const forward = point.copy(ray.direction).setY(0);
    if (forward.lengthSq() < 0.01) forward.set(0, 0, -1);
    forward.normalize();
    this.root.position.set(head.x + forward.x * DISTANCE, head.y - BELOW_HEAD, head.z + forward.z * DISTANCE);
    this.root.rotation.set(0, 0, 0);
    this.zoom = 1;
    this.root.scale.setScalar(1);
    this.grabs.clear();
    this.twoHand = null;
    this.lastGrab = null;
    this.root.visible = true;
    this.opened = true;
    this.shownZoom = 0;
  }

  close() {
    this.opened = false;
    this.root.visible = false;
    this.label.mesh.visible = false;
    this.grabs.clear();
    this.twoHand = null;
  }

  toggle(ray: THREE.Ray, head: THREE.Vector3) {
    if (this.opened) this.close();
    else this.open(ray, head);
  }

  /** Returns true when the hand is close enough to take hold of the model. */
  grabStart(id: number, position: THREE.Vector3): boolean {
    if (!this.opened) return false;
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
  press(ray: THREE.Ray): boolean {
    if (!this.opened) return false;
    let best: Pin | null = null;
    let bestDistance = Infinity;
    for (const pin of this.shown) {
      pin.mesh.getWorldPosition(point);
      const along = point.sub(ray.origin).dot(ray.direction);
      if (along <= 0) continue;
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
    this.close();
    this.onCommit(pin.point);
  }

  update({ user, grabs, tips, rays }: MiniInput) {
    if (!this.opened) return;
    this.applyGrabs(grabs);
    this.root.updateMatrixWorld(true);
    this.updateLevel(user);
    this.refreshPins();
    this.updateMarker(user);
    if (!this.updatePins(tips)) this.updateHover(rays);
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

  private updateLevel(user: MiniInput['user']) {
    const level = levelIndex(user.y, this.levels);
    if (level === this.currentLevel) return;
    this.currentLevel = level;
    this.levelMeshes.forEach(({ floor, walls }, i) => {
      floor.material = i === level ? this.solidFloor : this.ghostFloor;
      walls.material = i === level ? this.solidWall : this.ghostWall;
    });
  }

  private refreshPins() {
    if (this.zoom === this.shownZoom) return;
    this.shownZoom = this.zoom;
    this.shown = visiblePins(this.pins, this.scale, this.zoom);
    const visible = new Set(this.shown);
    for (const pin of this.pins) {
      pin.mesh.visible = visible.has(pin);
      // Buttons stay finger-sized however far the model is zoomed.
      pin.mesh.scale.setScalar(1 / this.zoom);
    }
  }

  private updateMarker({ x, y, z, yaw }: MiniInput['user']) {
    this.mapPoint(x, y, z, this.currentLevel, this.marker.position);
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
        const height = tip.position.y - (point.y + STEM);
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

  private updateHover(rays: THREE.Ray[]) {
    let best: Pin | null = null;
    for (const ray of rays) {
      for (const pin of this.shown) {
        pin.mesh.getWorldPosition(point);
        const along = point.sub(ray.origin).dot(ray.direction);
        if (along > 0 && Math.sqrt(Math.max(point.lengthSq() - along * along, 0)) / along < RAY_SNAP) best ??= pin;
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
    this.label.mesh.position.y += STEM + 0.05;
    this.label.mesh.rotation.y = this.root.rotation.y;
  }
}

function colorOf(point: NavPoint) {
  return point.type === 'entrance' ? COLOR.entrance : point.type === 'stair' ? COLOR.stair : COLOR.pin;
}

function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry) {
  const [ga, gb] = [a.toNonIndexed(), b.toNonIndexed()];
  const positions = new Float32Array(ga.attributes.position.count * 3 + gb.attributes.position.count * 3);
  positions.set(ga.attributes.position.array);
  positions.set(gb.attributes.position.array, ga.attributes.position.count * 3);
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return out;
}
