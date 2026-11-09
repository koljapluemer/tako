import * as THREE from 'three';
import { CanvasPanel } from './panel';

const PANEL_W = 0.62;
const PANEL_H = 0.15;

const forward = new THREE.Vector3();
const headPos = new THREE.Vector3();

/** The one place status can be shown in VR: the DOM status line can't be seen from the headset. */
export class Notice {
  private panel: CanvasPanel | null = null;
  private busy = false;

  constructor(private scene: THREE.Scene, private camera: THREE.Camera) {}

  /** A `busy` notice stays until replaced or cleared; any other can also be dismissed by pressing it. */
  show(text: string, busy: boolean) {
    this.close();
    this.busy = busy;
    const panel = new CanvasPanel(PANEL_W, PANEL_H);
    this.panel = panel;
    const { ctx, canvasWidth: w, canvasHeight: h } = panel;
    ctx.fillStyle = 'rgba(20,22,26,0.92)';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '500 52px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 60, h / 2, w - 120);
    panel.refresh();

    this.camera.getWorldPosition(headPos);
    this.camera.getWorldDirection(forward).setY(0);
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
    panel.mesh.position.copy(headPos).addScaledVector(forward.normalize(), 0.9);
    panel.mesh.position.y -= 0.12;
    panel.mesh.lookAt(headPos);
    panel.mesh.visible = true;
    this.scene.add(panel.mesh);
  }

  close() {
    if (!this.panel) return;
    this.scene.remove(this.panel.mesh);
    this.panel.dispose();
    this.panel = null;
  }

  /** Returns true when the press belongs to the notice. */
  press(ray: THREE.Ray): boolean {
    if (!this.panel?.hit(ray)) return false;
    if (!this.busy) this.close();
    return true;
  }
}
