import * as THREE from 'three';
import type { Collision, NavMesh } from '../collision';
import type { NavLevel, NavPoint } from '../nav/points';
import type { Sample } from '../samples';
import type { VersionSource } from '../versions';
import { Arc, ARC_ANGLE_STEP, ARC_RADIUS } from './arc';
import { MiniModel, type MiniInput } from './mini-model';
import { CanvasPanel, type LimitedRay } from './panel';

const MODEL_HEIGHT = 0.95;
const STAND_DISTANCE = 0.7;
const CARD_HEIGHT = 1.45;
const BUTTON_W = 0.2;
const BUTTON_H = 0.09;
/** Just past the last of the arc's five slots, so scrolling never moves them. */
const BUTTON_SLOT = 3;
const WALL_RANGE = 40;

export type Placed = { position: THREE.Vector3; rotationY: number };

/** `yaw` is the direction the user looks in when facing the station, as atan2(x, z). */
export function stationLayout(anchor: THREE.Vector3, yaw: number) {
  const stand = new THREE.Vector3(anchor.x - Math.sin(yaw) * STAND_DISTANCE, anchor.y, anchor.z - Math.cos(yaw) * STAND_DISTANCE);
  const y = anchor.y + CARD_HEIGHT;
  const onArc = (angle: number): Placed => ({
    position: new THREE.Vector3(stand.x + Math.sin(angle) * ARC_RADIUS, y, stand.z + Math.cos(angle) * ARC_RADIUS),
    rotationY: angle + Math.PI,
  });
  return {
    stand,
    model: new THREE.Vector3(anchor.x, anchor.y + MODEL_HEIGHT, anchor.z),
    arcCentre: new THREE.Vector3(stand.x, y, stand.z),
    // Slots run towards smaller angles, left to right as seen by the user.
    switcher: onArc(yaw + BUTTON_SLOT * ARC_ANGLE_STEP),
    close: onArc(yaw - BUTTON_SLOT * ARC_ANGLE_STEP),
  };
}

class Button {
  readonly panel = new CanvasPanel(BUTTON_W, BUTTON_H, { pixelsPerMetre: 2000, depthTest: true });
  private hovered = false;

  constructor(scene: THREE.Scene, private label: string, readonly run: () => void) {
    scene.add(this.panel.mesh);
    this.draw();
  }

  place({ position, rotationY }: Placed) {
    const { mesh } = this.panel;
    mesh.position.copy(position);
    mesh.rotation.y = rotationY;
    mesh.updateMatrixWorld(true);
  }

  setLabel(label: string) {
    if (label === this.label) return;
    this.label = label;
    this.draw();
  }

  setHovered(hovered: boolean) {
    if (hovered === this.hovered) return;
    this.hovered = hovered;
    this.draw();
  }

  private draw() {
    const { ctx, canvasWidth: w, canvasHeight: h } = this.panel;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this.hovered ? 'rgba(40,70,90,0.95)' : 'rgba(20,22,26,0.92)';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, h / 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '500 64px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.label, w / 2, h / 2, w - 40);
    this.panel.refresh();
  }
}

/** The mini model and revision cards, anchored together on a spot of floor. There is at most one. */
export class Station {
  private mini: MiniModel;
  private arc: Arc;
  private close_: Button;
  private switcher: Button;
  private ring: THREE.Mesh;
  private collision: Collision | null = null;
  private opened = false;

  constructor(scene: THREE.Scene) {
    this.mini = new MiniModel(scene);
    this.arc = new Arc(scene);
    this.close_ = new Button(scene, 'Close', () => this.close());
    this.switcher = new Button(scene, 'Buildings', () => this.toggleList());
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.26, 0.3, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.ring.visible = false;
    scene.add(this.ring);
  }

  set onPin(run: (point: NavPoint) => void) {
    this.mini.onCommit = run;
  }

  set source(source: VersionSource) {
    this.arc.source = source;
  }

  setSamples(samples: Sample[], open: (sample: Sample) => void) {
    this.arc.setSamples(samples, open);
  }

  setCollision(collision: Collision) {
    this.collision = collision;
  }

  setNavigation(nav: NavMesh | null, points: NavPoint[], levels: NavLevel[]) {
    this.mini.setData(nav, points, levels);
  }

  /** Replaces any existing station. It turns to face the head once, and stays put. */
  place(anchor: THREE.Vector3, head: THREE.Vector3) {
    this.close();
    const dx = anchor.x - head.x;
    const dz = anchor.z - head.z;
    const yaw = dx * dx + dz * dz > 0.01 ? Math.atan2(dx, dz) : 0;
    const layout = stationLayout(anchor, yaw);
    this.mini.open(layout.model);
    void this.arc.open(layout.arcCentre, yaw);
    this.close_.place(layout.close);
    this.switcher.place(layout.switcher);
    this.switcher.setLabel('Buildings');
    this.ring.position.set(anchor.x, anchor.y + 0.012, anchor.z);
    this.setVisible(true);
    this.opened = true;
  }

  close() {
    this.opened = false;
    this.arc.close();
    this.mini.close();
    this.setVisible(false);
  }

  private setVisible(on: boolean) {
    this.close_.panel.mesh.visible = on;
    this.switcher.panel.mesh.visible = on;
    this.ring.visible = on;
  }

  private toggleList() {
    if (this.arc.showingBuildings) {
      this.arc.showVersions();
      this.switcher.setLabel('Buildings');
    } else {
      this.arc.showBuildings();
      this.switcher.setLabel('Revisions');
    }
  }

  /** The list of versions, or which one is current, may have changed. */
  refresh() {
    void this.arc.refresh();
  }

  /** Keeps the station on the same bit of building when a revision shifts the origin. */
  translate(shift: THREE.Vector3) {
    if (!this.opened) return;
    this.mini.translate(shift);
    this.arc.translate(shift);
    for (const { panel } of [this.close_, this.switcher]) {
      panel.mesh.position.add(shift);
      panel.mesh.updateMatrixWorld(true);
    }
    this.ring.position.add(shift);
  }

  grabStart(id: number, position: THREE.Vector3) {
    return this.mini.grabStart(id, position);
  }

  grabEnd(id: number) {
    this.mini.grabEnd(id);
  }

  /** Stops the ray at the first wall: what is hidden can't be pressed. */
  private limited(ray: THREE.Ray): LimitedRay {
    return { ray, far: this.collision?.raycast(ray, WALL_RANGE)?.distance ?? WALL_RANGE };
  }

  /** Returns true when the press belongs to the station. */
  press(ray: THREE.Ray): boolean {
    if (!this.opened) return false;
    const pick = this.limited(ray);
    for (const button of [this.close_, this.switcher]) {
      if (button.panel.hit(pick.ray, pick.far)) {
        button.run();
        return true;
      }
    }
    return this.arc.press(pick) || this.mini.press(pick);
  }

  update({ rays, ...input }: Omit<MiniInput, 'picks'> & { rays: THREE.Ray[] }) {
    if (!this.opened) return;
    const picks = rays.map((ray) => this.limited(ray));
    for (const button of [this.close_, this.switcher]) {
      button.setHovered(picks.some(({ ray, far }) => button.panel.hit(ray, far)));
    }
    this.arc.update(picks);
    this.mini.update({ ...input, picks });
  }
}
