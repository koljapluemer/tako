import * as THREE from 'three';
import type { Collision } from '../collision';
import type { LoadedModel } from '../model';
import type { NavPoint } from '../nav/points';
import type { Sample } from '../samples';
import type { VersionSource } from '../versions';
import { Arc, CARD_H } from './arc';
import type { FeedbackSink } from './feedback';
import { MiniControls, PANEL_H, type LipPlacement } from './mini-controls';
import { MiniModel, type MiniInput } from './mini-model';
import { MAX_HEIGHT } from './mini-view';
import type { LimitedRay } from './panel';
import { Pedestal, TABLE_TOP } from './pedestal';

/** The model stands on the table, just clear of its top. */
const MODEL_HEIGHT = TABLE_TOP + 0.005;
const STAND_DISTANCE = 0.75;
/** Card bottoms clear the tallest model the table can hold. */
export const CARD_HEIGHT = TABLE_TOP + MAX_HEIGHT + 0.04 + CARD_H / 2;
/** Table radius bounds, and the margin left around the model's widest turn. */
export const TABLE_MIN = 0.22;
export const TABLE_MAX = 0.45;
const TABLE_MARGIN = 0.05;
/** The lip's face leans back from vertical, so it faces the eyes of someone standing at the table. */
export const LIP_TILT = THREE.MathUtils.degToRad(55);
const LIP_GAP = 0.012;
const WALL_RANGE = 40;

export type Placed = { position: THREE.Vector3; rotationY: number };

/** The table that fits a mini model which turns within `modelRadius`. */
export function tableRadius(modelRadius: number | null): number {
  return THREE.MathUtils.clamp((modelRadius ?? 0) + TABLE_MARGIN, TABLE_MIN, TABLE_MAX);
}

/**
 * `yaw` is the direction the user looks in when facing the station, as atan2(x, z); `radius` is the table's.
 * Front to back as seen by the user: the lip on the table's near edge, the model on the table, the cards above and behind.
 */
export function stationLayout(anchor: THREE.Vector3, yaw: number, radius: number) {
  const toward = (distance: number, height: number) => new THREE.Vector3(anchor.x - Math.sin(yaw) * distance, height, anchor.z - Math.cos(yaw) * distance);
  const stand = toward(STAND_DISTANCE, anchor.y);
  const y = anchor.y + CARD_HEIGHT;
  // The lip's back edge meets the table's rim; its face leans back towards the user.
  const back = radius + LIP_GAP;
  const lip: LipPlacement = {
    position: toward(back + (PANEL_H / 2) * Math.sin(LIP_TILT), anchor.y + TABLE_TOP - (PANEL_H / 2) * Math.cos(LIP_TILT) - LIP_GAP),
    rotationY: yaw + Math.PI,
    tilt: LIP_TILT,
  };
  return {
    stand,
    table: anchor.clone(),
    model: new THREE.Vector3(anchor.x, anchor.y + MODEL_HEIGHT, anchor.z),
    lip,
    arcCentre: new THREE.Vector3(stand.x, y, stand.z),
  };
}

/** The mini model on its table, with the revision cards behind it. There is at most one. */
export class Station {
  private mini: MiniModel;
  private controls: MiniControls;
  private arc: Arc;
  private pedestal: Pedestal;
  private collision: Collision | null = null;
  private opened = false;
  private anchor = new THREE.Vector3();
  private yaw = 0;
  private radius = TABLE_MIN;

  constructor(scene: THREE.Scene) {
    this.mini = new MiniModel(scene);
    this.controls = new MiniControls(scene, this.mini);
    this.controls.onClose = () => this.close();
    this.arc = new Arc(scene);
    this.pedestal = new Pedestal(scene);
  }

  set onPin(run: (point: NavPoint) => void) {
    this.mini.onCommit = run;
  }

  set onFeedback(sink: FeedbackSink) {
    this.controls.onFeedback = sink;
    this.arc.onFeedback = sink;
  }

  set onTip(run: (id: number, event: 'hover' | 'armed') => void) {
    this.mini.onTip = run;
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

  setNavigation(model: LoadedModel | null) {
    this.mini.setData(model);
  }

  /** Replaces any existing station. It turns to face the head once, and stays put. */
  place(anchor: THREE.Vector3, head: THREE.Vector3) {
    this.close();
    const dx = anchor.x - head.x;
    const dz = anchor.z - head.z;
    this.yaw = dx * dx + dz * dz > 0.01 ? Math.atan2(dx, dz) : 0;
    this.anchor.copy(anchor);
    this.radius = tableRadius(null);
    const layout = stationLayout(anchor, this.yaw, this.radius);
    this.mini.open(layout.model);
    this.pedestal.open(layout.table, this.radius);
    this.controls.open(layout.lip);
    void this.arc.open(layout.arcCentre, this.yaw);
    this.opened = true;
    this.fitTable();
  }

  close() {
    this.opened = false;
    this.arc.close();
    this.mini.close();
    this.controls.close();
    this.pedestal.close();
  }

  /** The table grows or shrinks to the model once it is built, and the lip follows its edge. */
  private fitTable() {
    const radius = tableRadius(this.mini.footprintRadius);
    if (radius === this.radius) return;
    this.radius = radius;
    this.pedestal.setRadius(radius);
    this.controls.move(stationLayout(this.anchor, this.yaw, radius).lip);
  }

  /** The list of versions, or which one is current, may have changed. */
  refresh() {
    void this.arc.refresh();
  }

  /** Keeps the station on the same bit of building when a revision shifts the origin. */
  translate(shift: THREE.Vector3) {
    if (!this.opened) return;
    this.anchor.add(shift);
    this.mini.translate(shift);
    this.controls.translate(shift);
    this.arc.translate(shift);
    this.pedestal.translate(shift);
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
  press(ray: THREE.Ray, id: number): boolean {
    if (!this.opened) return false;
    const pick = this.limited(ray);
    return this.controls.press(id, pick) || this.arc.press(pick) || this.mini.press(pick);
  }

  pressEnd(id: number) {
    this.controls.release(id);
  }

  /** Returns what each ray is on, for hover feedback: the lip first, then the cards, then the pins. */
  update({ rays, ...input }: Omit<MiniInput, 'picks'> & { rays: Array<{ id: number; ray: THREE.Ray }> }): Array<string | null> {
    if (!this.opened) return rays.map(() => null);
    this.fitTable();
    const picks = rays.map(({ ray }) => this.limited(ray));
    const lip = this.controls.update(rays, picks);
    const cards = this.arc.update(picks);
    const pins = this.mini.update({ ...input, picks });
    return rays.map((_, i) => lip[i] ?? cards[i] ?? pins[i]);
  }
}
