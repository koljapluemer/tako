import * as THREE from 'three';
import type { MiniModel } from './mini-model';
import { CanvasPanel, type LimitedRay } from './panel';

export const PANEL_W = 0.44;
export const PANEL_H = 0.24;
const PAD = 0.02;
const ROW_COUNT = 3;
const ROW_H = (PANEL_H - 2 * PAD) / ROW_COUNT;
export const LABEL_END = 0.15;
const CONTROL_START = 0.17;
const CONTROL_END = PANEL_W - PAD;
const THUMB_RADIUS = 0.014;
export const TRACK_START = CONTROL_START + THUMB_RADIUS;
export const TRACK_END = CONTROL_END - THUMB_RADIUS;
const TRACK_H = 0.008;
const SWITCH_W = 0.07;
const SWITCH_H = 0.036;
const PIXELS_PER_METRE = 2000;

const COLOR = { active: 0x35d0ff, hover: 0xffffff, off: 0x9aa4ae, disabled: 0x555b63 };

export type Row = 'spread' | 'opacity' | 'pins';
const ROWS: Row[] = ['spread', 'opacity', 'pins'];
const LABELS: Record<Row, string> = { spread: 'Floors', opacity: 'Opacity', pins: 'Nav points' };

/** Row `index` in metres down from the panel's top. */
export function rowBox(index: number) {
  const top = PAD + index * ROW_H;
  return { top, bottom: top + ROW_H, centre: top + ROW_H / 2 };
}

/** The row at metres from the panel's top-left, or -1 outside the control column. */
export function rowAt(x: number, y: number): number {
  if (x < CONTROL_START || x > CONTROL_END) return -1;
  const index = Math.floor((y - PAD) / ROW_H);
  return index >= 0 && index < ROW_COUNT ? index : -1;
}

export function trackValue(x: number): number {
  return Math.max(0, Math.min(1, (x - TRACK_START) / (TRACK_END - TRACK_START)));
}

export function trackX(value: number): number {
  return TRACK_START + value * (TRACK_END - TRACK_START);
}

const knobGeometry = new THREE.CylinderGeometry(THUMB_RADIUS, THUMB_RADIUS, 0.008, 24).rotateX(Math.PI / 2).translate(0, 0, 0.004);

function part(geometry: THREE.BufferGeometry, order: number) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
  mesh.renderOrder = order;
  return mesh;
}

const colorOf = (mesh: THREE.Mesh) => (mesh.material as THREE.MeshBasicMaterial).color;

/** Floor spread, opacity and navigation points. Stays put beside the model; it doesn't turn with it. */
export class MiniControls {
  private panel = new CanvasPanel(PANEL_W, PANEL_H, { pixelsPerMetre: PIXELS_PER_METRE, depthTest: true });
  private fills = new Map<Row, THREE.Mesh>();
  private knobs = new Map<Row, THREE.Mesh>();
  private captured = new Map<number, Row>();
  private spreadEnabled = false;
  private plane = new THREE.Plane();
  private hitPoint = new THREE.Vector3();
  private normal = new THREE.Vector3();

  constructor(scene: THREE.Scene, private mini: MiniModel) {
    for (const row of ROWS) {
      const knob = part(knobGeometry, 9002);
      this.knobs.set(row, knob);
      this.panel.mesh.add(knob);
      if (row === 'pins') continue;
      const fill = part(new THREE.PlaneGeometry(1, TRACK_H).translate(0.5, 0, 0), 9001);
      this.fills.set(row, fill);
      this.panel.mesh.add(fill);
    }
    scene.add(this.panel.mesh);
    this.draw();
    this.sync();
  }

  get mesh() {
    return this.panel.mesh;
  }

  /** Metres from the top-left to the panel's own centred coordinates. */
  private place(mesh: THREE.Object3D, x: number, y: number, z: number) {
    mesh.position.set(x - PANEL_W / 2, PANEL_H / 2 - y, z);
  }

  private value(row: Row) {
    return row === 'spread' ? this.mini.spread : this.mini.opacity;
  }

  private sync() {
    ROWS.forEach((row, index) => {
      const { centre } = rowBox(index);
      const knob = this.knobs.get(row)!;
      if (row === 'pins') {
        const x = CONTROL_END - (this.mini.pinsVisible ? SWITCH_H / 2 : SWITCH_W - SWITCH_H / 2);
        this.place(knob, x, centre, 0.001);
        return;
      }
      const x = trackX(this.value(row));
      this.place(knob, x, centre, 0.001);
      const fill = this.fills.get(row)!;
      this.place(fill, TRACK_START, centre, 0.001);
      fill.scale.x = Math.max(x - TRACK_START, 1e-4);
    });
  }

  private draw() {
    const { ctx, canvasWidth: w, canvasHeight: h } = this.panel;
    const px = (metres: number) => metres * PIXELS_PER_METRE;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20,22,26,0.92)';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, px(0.02));
    ctx.fill();
    ctx.font = '500 44px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ROWS.forEach((row, index) => {
      const { centre } = rowBox(index);
      const dim = row === 'spread' && !this.spreadEnabled;
      ctx.fillStyle = dim ? '#667' : '#fff';
      ctx.fillText(LABELS[row], px(PAD), px(centre), px(LABEL_END - PAD));
      ctx.fillStyle = dim ? '#333840' : '#454c55';
      ctx.beginPath();
      if (row === 'pins') ctx.roundRect(px(CONTROL_END - SWITCH_W), px(centre - SWITCH_H / 2), px(SWITCH_W), px(SWITCH_H), px(SWITCH_H / 2));
      else ctx.roundRect(px(TRACK_START), px(centre - TRACK_H / 2), px(TRACK_END - TRACK_START), px(TRACK_H), px(TRACK_H / 2));
      ctx.fill();
    });
    this.panel.refresh();
  }

  open({ position, rotationY }: { position: THREE.Vector3; rotationY: number }) {
    const { mesh } = this.panel;
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    mesh.visible = true;
    mesh.updateMatrixWorld(true);
  }

  close() {
    this.panel.mesh.visible = false;
    this.captured.clear();
  }

  translate(shift: THREE.Vector3) {
    this.panel.mesh.position.add(shift);
    this.panel.mesh.updateMatrixWorld(true);
  }

  private rowHit(pick: LimitedRay): { row: Row | null; x: number } | null {
    const hit = this.panel.hit(pick.ray, pick.far);
    if (!hit) return null;
    const x = hit.x / PIXELS_PER_METRE;
    const index = rowAt(x, hit.y / PIXELS_PER_METRE);
    const row = index < 0 ? null : ROWS[index];
    return { row: row === 'spread' && !this.spreadEnabled ? null : row, x };
  }

  private set(row: Row, value: number) {
    if (row === 'spread') this.mini.setSpread(value);
    else this.mini.setOpacity(value);
    this.sync();
  }

  /** Returns true when the ray is on the panel, so nothing behind it gets the press. */
  press(id: number, pick: LimitedRay): boolean {
    const hit = this.rowHit(pick);
    if (!hit) return false;
    const { row, x } = hit;
    if (!row || [...this.captured.values()].includes(row)) return true;
    if (row === 'pins') {
      this.mini.setPinsVisible(!this.mini.pinsVisible);
      this.sync();
      return true;
    }
    this.captured.set(id, row);
    this.set(row, trackValue(x));
    return true;
  }

  release(id: number) {
    this.captured.delete(id);
  }

  /** The plane, not the mesh, so a drag survives the ray sliding off the panel. */
  private drag(row: Row, ray: THREE.Ray) {
    const { mesh } = this.panel;
    this.normal.set(0, 0, 1).transformDirection(mesh.matrixWorld);
    this.plane.setFromNormalAndCoplanarPoint(this.normal, mesh.getWorldPosition(this.hitPoint));
    if (!ray.intersectPlane(this.plane, this.hitPoint)) return;
    mesh.worldToLocal(this.hitPoint);
    this.set(row, trackValue(this.hitPoint.x + PANEL_W / 2));
  }

  update(rays: Array<{ id: number; ray: THREE.Ray }>, picks: LimitedRay[]) {
    if (!this.panel.mesh.visible) return;
    if (this.spreadEnabled !== this.mini.canSpread) {
      this.spreadEnabled = this.mini.canSpread;
      this.draw();
    }
    for (const { id, ray } of rays) {
      const row = this.captured.get(id);
      if (row) this.drag(row, ray);
    }
    const hovered = new Set<Row>(this.captured.values());
    for (const pick of picks) {
      const row = this.rowHit(pick)?.row;
      if (row) hovered.add(row);
    }
    for (const row of ROWS) {
      const disabled = row === 'spread' && !this.spreadEnabled;
      const base = disabled ? COLOR.disabled : row === 'pins' && !this.mini.pinsVisible ? COLOR.off : COLOR.active;
      colorOf(this.knobs.get(row)!).setHex(hovered.has(row) ? COLOR.hover : base);
      const fill = this.fills.get(row);
      if (fill) colorOf(fill).setHex(disabled ? COLOR.disabled : COLOR.active);
    }
  }
}
