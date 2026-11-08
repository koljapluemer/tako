import type * as THREE from 'three';
import { CanvasPanel } from './panel';

const REDRAW_MS = 500;
const STORAGE_MS = 5000;
const LINE = 46;
const MB = 1024 * 1024;

type Memory = { usedJSHeapSize: number; jsHeapSizeLimit: number };

/** Measurement readout for headset budgeting; enabled with `?hud=1`, view-locked so it survives teleports. */
export class Hud {
  private panel = new CanvasPanel(0.3, 0.24, 1200);
  private frames: number[] = [];
  private last = 0;
  private redrawAt = 0;
  private storageAt = 0;
  private storage = 'n/a';

  constructor(private renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    this.panel.mesh.position.set(0.32, 0.2, -0.9);
    this.panel.mesh.visible = true;
    camera.add(this.panel.mesh);
  }

  static enabled() {
    return new URLSearchParams(location.search).get('hud') === '1';
  }

  update(now: number) {
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
    ];
    const { ctx, canvasWidth: w, canvasHeight: h } = panel;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#7dff9b';
    ctx.font = '500 34px monospace';
    ctx.textBaseline = 'middle';
    lines.forEach((line, i) => ctx.fillText(line, 16, 18 + LINE * i + LINE / 2, w - 32));
    panel.refresh();
  }
}
