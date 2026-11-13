import * as THREE from 'three';
import { CanvasPanel } from './panel';

export type Tool = 'pointer' | 'spray';
export type PanelButton = 'message' | 'go' | 'rev-prev' | 'rev-next' | 'pointer' | 'spray' | 'highlight-on' | 'highlight-off';
/** The revision on screen, and whether there is one either side of it. */
export type RevisionRow = { title: string; detail: string; prev: boolean; next: boolean };

const WIDTH = 0.15;
const HEIGHT = 0.18;
const PIXELS_PER_METRE = 3200;
/** Row boundaries, as fractions of the height from the top. */
const MESSAGE_END = 0.36;
const COMPASS_END = 0.52;
const REVISION_END = 0.68;
const TOOL_END = 0.84;
/** Width of each revision arrow, as a fraction of the panel. */
const ARROW = 0.2;
const LABEL = 0.34;
const SPLIT = (1 + LABEL) / 2;
/** Above the controller, tilted back towards the user's eyes; tune on the headset. */
const OFFSET = new THREE.Vector3(0, 0.1, 0);
const TILT = -Math.PI / 4;
const MESSAGE_FONT = '500 30px system-ui, sans-serif';
const MESSAGE_LINE = 38;
const MESSAGE_LINES = 4;
const MESSAGE_X = 34;
/** Height differences below this are the same level as far as the compass is concerned. */
const SAME_LEVEL = 1.5;
/** Where the compass dial sits, as fractions of the panel. */
const DIAL_U = 0.12;
const DIAL_V = (MESSAGE_END + COMPASS_END) / 2;

/** Which button is at (u, v), both 0 to 1 from the top left of the panel. */
export function buttonAt(u: number, v: number): PanelButton | null {
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  if (v < MESSAGE_END) return 'message';
  if (v < COMPASS_END) return 'go';
  if (v < REVISION_END) return u < ARROW ? 'rev-prev' : u > 1 - ARROW ? 'rev-next' : null;
  if (u < LABEL) return null;
  if (v < TOOL_END) return u < SPLIT ? 'pointer' : 'spray';
  return u < SPLIT ? 'highlight-on' : 'highlight-off';
}

/** Clockwise angle from the panel's "up" to the target, for a panel whose up and right axes are given in world space. */
export function compassAngle(toTarget: THREE.Vector3, up: THREE.Vector3, right: THREE.Vector3): number {
  return Math.atan2(toTarget.dot(right), toTarget.dot(up));
}

/** "12 m", or "12 m · 3 m up" when the target is on another level. */
export function distanceLabel(horizontal: number, rise: number): string {
  const along = `${Math.round(horizontal)} m`;
  if (Math.abs(rise) < SAME_LEVEL) return along;
  return `${along} · ${Math.round(Math.abs(rise))} m ${rise > 0 ? 'up' : 'down'}`;
}

/** Breaks text into lines that fit `width` pixels, ending the last with an ellipsis if it runs over. */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1]}…`;
  return kept;
}

const origin = new THREE.Vector3();
const toTarget = new THREE.Vector3();
const up = new THREE.Vector3();
const right = new THREE.Vector3();

/**
 * The panel on the left controller, read like a wristwatch: the agent's latest message, a compass to the latest change,
 * stepping between revisions, the tool, and the change highlight. Anchored to the hand, so it never trails behind the head.
 */
export class ControllerPanel {
  private panel = new CanvasPanel(WIDTH, HEIGHT, { pixelsPerMetre: PIXELS_PER_METRE });
  private needle: THREE.Mesh;
  private state = {
    tool: 'pointer' as Tool,
    highlight: true,
    message: null as { text: string; busy: boolean } | null,
    distance: null as string | null,
    revision: null as RevisionRow | null,
    hovered: null as PanelButton | null,
  };
  private drawn = '';
  onButton: (button: PanelButton) => void = () => {};

  constructor() {
    this.panel.mesh.position.copy(OFFSET);
    this.panel.mesh.rotation.x = TILT;
    const size = 0.009;
    const shape = new THREE.Shape([new THREE.Vector2(0, size), new THREE.Vector2(size * 0.6, -size * 0.7), new THREE.Vector2(0, -size * 0.35), new THREE.Vector2(-size * 0.6, -size * 0.7)]);
    this.needle = new THREE.Mesh(
      new THREE.ShapeGeometry(shape),
      // Keep this in the transparent render pass with the canvas panel; otherwise the
      // panel is composited afterward and its dark background washes the needle out.
      new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    );
    this.needle.position.set((DIAL_U - 0.5) * WIDTH, (0.5 - DIAL_V) * HEIGHT, 0.001);
    this.needle.renderOrder = this.panel.mesh.renderOrder + 1;
    this.needle.visible = false;
    this.panel.mesh.add(this.needle);
  }

  /** Puts the panel on this controller's grip; null hides it. */
  attach(grip: THREE.Object3D | null) {
    const { mesh } = this.panel;
    if (mesh.parent !== grip) {
      mesh.removeFromParent();
      grip?.add(mesh);
    }
    mesh.visible = grip != null;
  }

  setTool(tool: Tool) {
    this.state.tool = tool;
    this.draw();
  }

  setHighlight(on: boolean) {
    this.state.highlight = on;
    this.draw();
  }

  /** A busy message stays until replaced; any other can also be dismissed by pressing it. */
  setMessage(text: string | null, busy = false) {
    this.state.message = text == null ? null : { text, busy };
    this.draw();
  }

  setRevision(revision: RevisionRow | null) {
    this.state.revision = revision;
    this.draw();
  }

  get messageBusy() {
    return this.state.message?.busy ?? false;
  }

  private revisionEnabled(button: 'rev-prev' | 'rev-next') {
    const { revision } = this.state;
    return revision != null && (button === 'rev-prev' ? revision.prev : revision.next);
  }

  private buttonOn(ray: THREE.Ray): PanelButton | null {
    const hit = this.panel.hit(ray);
    return hit && buttonAt(hit.x / this.panel.canvasWidth, hit.y / this.panel.canvasHeight);
  }

  /** Returns true when the press belongs to the panel. */
  press(ray: THREE.Ray): boolean {
    if (!this.panel.hit(ray)) return false;
    const button = this.buttonOn(ray);
    if (button === 'message') {
      if (this.state.message && !this.state.message.busy) this.setMessage(null);
    } else if (button === 'go') {
      if (this.state.distance != null) this.onButton(button);
    } else if (button === 'rev-prev' || button === 'rev-next') {
      if (this.revisionEnabled(button)) this.onButton(button);
    } else if (button) this.onButton(button);
    return true;
  }

  /** Call every frame, after the controller has moved. `target` is the latest change, or null. */
  update(rays: THREE.Ray[], target: THREE.Vector3 | null) {
    const { mesh } = this.panel;
    if (!mesh.visible) return;
    this.needle.visible = target != null;
    let distance: string | null = null;
    if (target) {
      mesh.getWorldPosition(origin);
      toTarget.subVectors(target, origin);
      const rise = toTarget.y;
      toTarget.y = 0;
      up.set(0, 1, 0).transformDirection(mesh.matrixWorld);
      right.set(1, 0, 0).transformDirection(mesh.matrixWorld);
      this.needle.rotation.z = -compassAngle(toTarget, up, right);
      distance = distanceLabel(toTarget.length(), rise);
    }
    this.state.distance = distance;
    this.state.hovered = rays.map((ray) => this.buttonOn(ray)).find((b) => b != null) ?? null;
    this.draw();
  }

  private draw() {
    const { tool, highlight, message, distance, revision, hovered } = this.state;
    const key = JSON.stringify(this.state);
    if (key === this.drawn) return;
    this.drawn = key;
    const { ctx, canvasWidth: w, canvasHeight: h } = this.panel;
    const pad = 8;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(20,22,26,0.92)';
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 28);
    ctx.fill();
    ctx.textBaseline = 'middle';

    // Message: blue bar while the agent is still working.
    const messageH = MESSAGE_END * h;
    if (message) {
      ctx.fillStyle = message.busy ? '#35d0ff' : 'rgba(255,255,255,0.25)';
      ctx.beginPath();
      ctx.roundRect(14, 18, 8, messageH - 36, 4);
      ctx.fill();
      ctx.font = MESSAGE_FONT;
      ctx.textAlign = 'left';
      ctx.fillStyle = hovered === 'message' && !message.busy ? '#cfefff' : '#fff';
      const lines = wrap(ctx, message.text, w - MESSAGE_X - 2 * pad, MESSAGE_LINES);
      const top = (messageH - lines.length * MESSAGE_LINE) / 2;
      lines.forEach((line, i) => ctx.fillText(line, MESSAGE_X, top + MESSAGE_LINE * (i + 0.5), w - MESSAGE_X - 2 * pad));
    } else {
      ctx.font = MESSAGE_FONT;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillText('Hold Y or B to talk', MESSAGE_X, messageH / 2);
    }

    const button = (x0: number, x1: number, y0: number, y1: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(x0 + pad, y0 + pad, x1 - x0 - 2 * pad, y1 - y0 - 2 * pad, 16);
      ctx.fill();
    };
    const idle = (id: PanelButton, enabled = true) => (hovered === id && enabled ? 'rgba(60,90,110,0.95)' : 'rgba(255,255,255,0.08)');

    // Compass to the latest change; the needle is a mesh on top, so turning the wrist doesn't redraw.
    const c0 = MESSAGE_END * h;
    const c1 = COMPASS_END * h;
    button(0, w, c0, c1, idle('go', distance != null));
    ctx.strokeStyle = distance ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(DIAL_U * w, DIAL_V * h, (c1 - c0) / 2 - 2 * pad, 0, Math.PI * 2);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = '600 32px system-ui, sans-serif';
    ctx.fillStyle = distance ? '#fff' : 'rgba(255,255,255,0.35)';
    ctx.fillText(distance ?? 'No new change', 2 * DIAL_U * w, DIAL_V * h, w * 0.62);
    if (distance) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#35d0ff';
      ctx.fillText('Go ›', w - 3 * pad, DIAL_V * h);
    }

    const choice = (id: PanelButton, label: string, x0: number, x1: number, y0: number, y1: number, on: boolean) => {
      button(x0, x1, y0, y1, on ? '#35d0ff' : idle(id));
      ctx.fillStyle = on ? '#0b1a22' : '#fff';
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(label, (x0 + x1) / 2, (y0 + y1) / 2, x1 - x0 - 3 * pad);
    };
    const label = (text: string, y0: number, y1: number) => {
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '500 28px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(text, 2 * pad, (y0 + y1) / 2, w * LABEL - 3 * pad);
    };
    // Revisions: step back and forth from where you stand, to compare.
    const r1 = REVISION_END * h;
    const arrow = (id: 'rev-prev' | 'rev-next', glyph: string, x0: number, x1: number) => {
      const enabled = this.revisionEnabled(id);
      button(x0, x1, c1, r1, idle(id, enabled));
      ctx.fillStyle = enabled ? '#fff' : 'rgba(255,255,255,0.2)';
      ctx.font = '600 44px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(glyph, (x0 + x1) / 2, (c1 + r1) / 2);
    };
    arrow('rev-prev', '‹', 0, w * ARROW);
    arrow('rev-next', '›', w * (1 - ARROW), w);
    const middle = w / 2;
    const room = w * (1 - 2 * ARROW) - 2 * pad;
    ctx.textAlign = 'center';
    if (revision) {
      ctx.fillStyle = '#fff';
      ctx.font = '600 28px system-ui, sans-serif';
      ctx.fillText(revision.title, middle, c1 + (r1 - c1) * 0.36, room);
      ctx.fillStyle = revision.next ? 'rgba(255,255,255,0.6)' : '#35d0ff';
      ctx.font = '500 24px system-ui, sans-serif';
      ctx.fillText(revision.detail, middle, c1 + (r1 - c1) * 0.72, room);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '500 28px system-ui, sans-serif';
      ctx.fillText('No revisions', middle, (c1 + r1) / 2, room);
    }

    const t1 = TOOL_END * h;
    label('Tool', r1, t1);
    choice('pointer', 'Pointer', w * LABEL, w * SPLIT, r1, t1, tool === 'pointer');
    choice('spray', 'Spray', w * SPLIT, w, r1, t1, tool === 'spray');
    label('Highlight', t1, h);
    choice('highlight-on', 'On', w * LABEL, w * SPLIT, t1, h, highlight);
    choice('highlight-off', 'Off', w * SPLIT, w, t1, h, !highlight);
    this.panel.refresh();
  }
}
