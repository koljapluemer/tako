import * as THREE from 'three';
import type { Sample } from '../samples';
import type { Landing } from './landing';
import { CanvasPanel } from './panel';

/** `inert` rows only display text; pressing one leaves the panel open. */
type Row = { label: string; dim?: boolean; inert?: boolean; run?: () => void };

const ROW = 110;
const PANEL_W = 0.62;
const PADDING = 20;

const forward = new THREE.Vector3();
const headPos = new THREE.Vector3();
const target = new THREE.Vector3();

function headingXZ(camera: THREE.Camera, out: THREE.Vector3) {
  camera.getWorldDirection(out);
  out.y = 0;
  if (out.lengthSq() < 1e-4) out.set(0, 0, -1);
  return out.normalize();
}

/** A small body-locked button that opens a storey list. Selected with plain `select`, so any input can use it. */
export class Menu {
  private button = new CanvasPanel(0.09, 0.09, 1400);
  private panel: CanvasPanel | null = null;
  private landings: Landing[] = [];
  private hovered = -1;
  private samples: Sample[] = [];
  private page: 'landings' | 'samples' = 'landings';
  private notice: { text: string; busy: boolean } | null = null;

  onChoose: (landing: Landing) => void = () => {};
  onSample: (sample: Sample) => void = () => {};

  constructor(private scene: THREE.Scene, private camera: THREE.Camera) {
    const { ctx, canvasWidth: size } = this.button;
    ctx.fillStyle = 'rgba(20,22,26,0.85)';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 3; i++) ctx.fillRect(size * 0.28, size * (0.34 + i * 0.14), size * 0.44, size * 0.06);
    this.button.refresh();
    scene.add(this.button.mesh);
  }

  setLandings(landings: Landing[]) {
    this.close();
    // Highest storey at the top, like a lift panel.
    this.landings = [...landings].reverse();
  }

  setSamples(samples: Sample[]) {
    this.samples = samples;
  }

  /** Shows one line of text in the panel; `busy` hides the Close row. A new model closes it. */
  showNotice(text: string, busy: boolean) {
    this.close();
    this.notice = { text, busy };
    this.open();
  }

  show(on: boolean) {
    this.button.mesh.visible = on;
    if (!on) this.close();
  }

  private draw() {
    const panel = this.panel!;
    const { ctx, canvasWidth: w, canvasHeight: h } = panel;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20,22,26,0.92)';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '500 52px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    this.rows().forEach(({ label, dim, inert }, i) => {
      if (i === this.hovered && !inert) {
        ctx.fillStyle = 'rgba(53,208,255,0.3)';
        ctx.fillRect(PADDING, PADDING + i * ROW, w - 2 * PADDING, ROW - 6);
      }
      ctx.fillStyle = dim ? '#aab' : '#fff';
      ctx.fillText(label, PADDING * 3, PADDING + i * ROW + ROW / 2, w - PADDING * 6);
    });
    panel.refresh();
  }

  private rows(): Row[] {
    const close: Row = { label: 'Close', dim: true };
    if (this.notice) return [{ label: this.notice.text, inert: true }, ...(this.notice.busy ? [] : [close])];
    if (this.page === 'samples') {
      return [
        ...this.samples.map((sample) => ({ label: sample.name, run: () => this.onSample(sample) })),
        { label: 'Back', dim: true, run: () => this.open() },
      ];
    }
    return [
      ...this.landings.map((landing) => ({ label: landing.name, run: () => this.onChoose(landing) })),
      ...(this.samples.length ? [{ label: 'Switch building', run: () => this.open('samples') }] : []),
      close,
    ];
  }

  private open(page: 'landings' | 'samples' = 'landings') {
    this.page = page;
    const height = (this.rows().length * ROW + 2 * PADDING) / 1000;
    const panel = new CanvasPanel(PANEL_W, height);
    this.panel = panel;
    this.hovered = -1;
    this.camera.getWorldPosition(headPos);
    headingXZ(this.camera, forward);
    panel.mesh.position.copy(headPos).addScaledVector(forward, 0.9);
    panel.mesh.position.y -= 0.12;
    panel.mesh.lookAt(headPos);
    panel.mesh.visible = true;
    this.scene.add(panel.mesh);
    this.draw();
  }

  close() {
    this.notice = null;
    if (!this.panel) return;
    this.scene.remove(this.panel.mesh);
    this.panel.dispose();
    this.panel = null;
  }

  private rowAt(ray: THREE.Ray) {
    const hit = this.panel?.hit(ray);
    if (!hit) return -1;
    const row = Math.floor((hit.y - PADDING) / ROW);
    return row >= 0 && row < this.rows().length ? row : -1;
  }

  /** Returns true when the press belongs to the menu. */
  press(ray: THREE.Ray): boolean {
    if (this.panel) {
      const row = this.rowAt(ray);
      if (row >= 0) {
        const item = this.rows()[row];
        if (item.inert) return true;
        this.close();
        item.run?.();
        return true;
      }
      if (this.panel.hit(ray)) return true;
    }
    if (this.button.hit(ray)) {
      if (this.panel) this.close();
      else this.open();
      return true;
    }
    return false;
  }

  update(dt: number, rays: THREE.Ray[]) {
    this.camera.getWorldPosition(headPos);
    headingXZ(this.camera, forward);
    target.copy(headPos).addScaledVector(forward, 0.42);
    target.y -= 0.6;
    const mesh = this.button.mesh;
    const follow = 1 - Math.exp(-dt / 0.35);
    mesh.position.lerp(target, follow);
    mesh.lookAt(headPos);

    if (this.panel) {
      const row = rays.reduce((found, ray) => (found >= 0 ? found : this.rowAt(ray)), -1);
      if (row !== this.hovered) {
        this.hovered = row;
        this.draw();
      }
    }
  }
}
