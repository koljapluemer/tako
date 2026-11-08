import * as THREE from 'three';
import type { Collision } from '../collision';
import { inspectElement, type DoorInfo } from '../model';
import type { ElementInfo } from '../worker-protocol';
import { CanvasPanel } from './panel';

const PICK_RANGE = 40;
const WIDTH = 0.6;
const HEIGHT = 0.5;
const raycaster = new THREE.Raycaster();
const headPos = new THREE.Vector3();

/** Point at an element and tap: what is it, what's it made of. */
export class Inspect {
  private panel = new CanvasPanel(WIDTH, HEIGHT);
  private collision: Collision | null = null;
  private doors: DoorInfo[] = [];
  private requestId = 0;

  constructor(scene: THREE.Scene, private camera: THREE.Camera) {
    scene.add(this.panel.mesh);
  }

  setModel(collision: Collision, doors: DoorInfo[]) {
    this.collision = collision;
    this.doors = doors;
    this.close();
  }

  close() {
    this.requestId++;
    this.panel.mesh.visible = false;
  }

  /** Taps on the open panel just dismiss it. */
  press(ray: THREE.Ray): boolean {
    if (!this.panel.hit(ray)) return false;
    this.close();
    return true;
  }

  private pick(ray: THREE.Ray): { point: THREE.Vector3; expressID: number } | null {
    const hit = this.collision?.raycast(ray, PICK_RANGE) ?? null;
    raycaster.ray.copy(ray);
    raycaster.far = hit ? hit.distance : PICK_RANGE;
    const door = raycaster.intersectObjects(this.doors.map((d) => d.mesh), false)[0];
    if (door) return { point: door.point, expressID: door.object.userData.expressID as number };
    return hit && { point: hit.point, expressID: hit.expressID };
  }

  async tap(ray: THREE.Ray) {
    const picked = this.pick(ray);
    if (!picked) return this.close();
    const id = ++this.requestId;
    let info: ElementInfo | null = null;
    try {
      info = await inspectElement(picked.expressID);
    } catch (err) {
      console.error(err);
    }
    if (id !== this.requestId || !info) return;
    this.draw(info);
    this.place(picked.point);
  }

  private place(point: THREE.Vector3) {
    const mesh = this.panel.mesh;
    this.camera.getWorldPosition(headPos);
    const toPoint = point.clone().sub(headPos);
    const distance = THREE.MathUtils.clamp(toPoint.length() - 0.2, 0.6, 1.4);
    mesh.position.copy(headPos).addScaledVector(toPoint.normalize(), distance);
    mesh.lookAt(headPos);
    mesh.visible = true;
  }

  private draw(info: ElementInfo) {
    const { ctx, canvasWidth: w, canvasHeight: h } = this.panel;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20,22,26,0.94)';
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'top';
    const left = 30;
    const max = w - 2 * left;
    let y = 26;
    ctx.fillStyle = '#35d0ff';
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillText(info.ifcClass, left, y, max);
    y += 48;
    ctx.fillStyle = '#fff';
    ctx.font = '500 40px system-ui, sans-serif';
    ctx.fillText(info.name ?? 'Unnamed', left, y, max);
    y += 62;
    ctx.font = '400 30px system-ui, sans-serif';
    if (info.materials.length) {
      ctx.fillStyle = '#dde';
      ctx.fillText(info.materials.join(', '), left, y, max);
      y += 50;
    }
    for (const [name, value] of info.properties) {
      if (y > h - 40) break;
      ctx.fillStyle = '#99a';
      ctx.fillText(name, left, y, max * 0.55);
      ctx.fillStyle = '#fff';
      ctx.fillText(value, left + max * 0.58, y, max * 0.42);
      y += 40;
    }
    this.panel.refresh();
  }
}
