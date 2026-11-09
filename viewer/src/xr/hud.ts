import type * as THREE from 'three';
import { CanvasPanel } from './panel';

const REDRAW_MS = 500;
const STORAGE_MS = 5000;
const LINE = 36;
const ERROR_COLUMNS = 34;
const ERROR_LINES = 6;
const MB = 1024 * 1024;

type Memory = { usedJSHeapSize: number; jsHeapSizeLimit: number };

/**
 * Measurement and debug readout, enabled with `?hud=1`. View-locked so it survives
 * teleports. While it is on, the fade to black is not drawn, so a dark view can be diagnosed.
 */
export class Hud {
  private panel = new CanvasPanel(0.5, 0.6, { pixelsPerMetre: 1200 });
  private lastError: string | null = null;
  private state: string[] = [];
  private frames: number[] = [];
  private last = 0;
  private redrawAt = 0;
  private storageAt = 0;
  private storage = 'n/a';

  constructor(private renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    this.panel.mesh.position.set(0.3, 0, -0.9);
    this.panel.mesh.visible = true;
    camera.add(this.panel.mesh);
    window.addEventListener('error', (e) => this.error(e.error ?? e.message));
    window.addEventListener('unhandledrejection', (e) => this.error(e.reason));
  }

  error(err: unknown) {
    this.lastError = err instanceof Error ? `${err.message} ${err.stack ?? ''}` : String(err);
  }

  static enabled() {
    return new URLSearchParams(location.search).get('hud') === '1';
  }

  update(now: number, state: string[]) {
    this.state = state;
    if (this.last) this.frames.push(now - this.last);
    this.last = now;
    if (now >= this.storageAt) {
      this.storageAt = now + STORAGE_MS;
      void this.readStorage();
    }
    if (now < this.redrawAt || !this.frames.length) return;
    this.redrawAt = now + REDRAW_MS;
    this.draw();
    this.frames.length = 0;
  }

  private async readStorage() {
    const estimate = await navigator.storage?.estimate?.().catch(() => null);
    if (estimate?.quota != null) this.storage = `${Math.round((estimate.usage ?? 0) / MB)} / ${Math.round(estimate.quota / MB)} MB`;
  }

  private draw() {
    const { frames, panel, renderer } = this;
    const average = frames.reduce((sum, ms) => sum + ms, 0) / frames.length;
    const memory = (performance as Performance & { memory?: Memory }).memory;
    const lines = [
      `frame ${average.toFixed(1)} ms (${Math.round(1000 / average)} fps)`,
      `worst ${Math.max(...frames).toFixed(1)} ms`,
      `calls ${renderer.info.render.calls}`,
      `tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k`,
      `geo ${renderer.info.memory.geometries} tex ${renderer.info.memory.textures}`,
      `heap ${memory ? `${Math.round(memory.usedJSHeapSize / MB)} / ${Math.round(memory.jsHeapSizeLimit / MB)} MB` : 'n/a'}`,
      `disk ${this.storage}`,
      ...this.state,
    ];
    const errors = (this.lastError?.match(new RegExp(`.{1,${ERROR_COLUMNS}}`, 'g')) ?? []).slice(0, ERROR_LINES);
    const { ctx, canvasWidth: w, canvasHeight: h } = panel;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#7dff9b';
    ctx.font = '500 28px monospace';
    ctx.textBaseline = 'middle';
    const row = (line: string, i: number) => ctx.fillText(line, 16, 18 + LINE * i + LINE / 2, w - 32);
    lines.forEach(row);
    ctx.fillStyle = '#ff7d7d';
    (errors.length ? errors : ['no errors']).forEach((line, i) => row(line, lines.length + i));
    panel.refresh();
  }
}
