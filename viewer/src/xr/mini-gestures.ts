export type Vec3 = [number, number, number];

// Provisional, to be tuned on a headset: see doc/vr-headset-checklist.md.
export const PIN_MIN_SPACING = 0.08;
export const PIN_CONTACT_RADIUS = 0.03;
export const PIN_ARM_DEPTH = 0.01;
export const PIN_SLIDE_OFF = 0.045;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

/** How far a hand has moved around the vertical axis through `centre`. */
export function turntableDelta(centre: Vec3, from: Vec3, to: Vec3): number {
  const before = Math.atan2(from[0] - centre[0], from[2] - centre[2]);
  const after = Math.atan2(to[0] - centre[0], to[2] - centre[2]);
  return wrap(after - before);
}

export type Placement = { position: Vec3; yaw: number; zoom: number };

/** The placement that keeps the model fixed relative to two hands as they move, turn and spread. */
export function twoHandPlacement(start: Placement, a0: Vec3, b0: Vec3, a1: Vec3, b1: Vec3): Placement {
  const spread = (p: Vec3, q: Vec3) => Math.hypot(q[0] - p[0], q[2] - p[2]);
  const heading = (p: Vec3, q: Vec3) => Math.atan2(q[0] - p[0], q[2] - p[2]);
  const before = spread(a0, b0);
  const after = spread(a1, b1);
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, start.zoom * (before > 1e-3 ? after / before : 1)));
  const ratio = zoom / start.zoom;
  const turn = before > 1e-3 && after > 1e-3 ? wrap(heading(a1, b1) - heading(a0, b0)) : 0;
  const mid0: Vec3 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2, (a0[2] + b0[2]) / 2];
  const mid1: Vec3 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2, (a1[2] + b1[2]) / 2];
  const [dx, dy, dz] = [start.position[0] - mid0[0], start.position[1] - mid0[1], start.position[2] - mid0[2]];
  const [sin, cos] = [Math.sin(turn), Math.cos(turn)];
  return {
    position: [mid1[0] + (dx * cos + dz * sin) * ratio, mid1[1] + dy * ratio, mid1[2] + (-dx * sin + dz * cos) * ratio],
    yaw: start.yaw + turn,
    zoom,
  };
}

export type PinEvent = 'hover' | 'armed' | 'commit' | 'cancel' | 'leave' | null;

/** Contact highlights, pressing in arms, lifting off commits, sliding away cancels. Offsets are from the pin's top. */
export class PinPress {
  private state: 'idle' | 'touching' | 'armed' | 'cancelled' = 'idle';

  get touching() {
    return this.state === 'touching' || this.state === 'armed';
  }

  /** `height`: tip above the pin top, negative when pressed in. `lateral`: sideways distance from its axis. */
  update(height: number, lateral: number): PinEvent {
    const clear = height > PIN_ARM_DEPTH;
    switch (this.state) {
      case 'idle':
        if (lateral < PIN_CONTACT_RADIUS && height <= 0 && height > -PIN_ARM_DEPTH * 2) {
          this.state = 'touching';
          return 'hover';
        }
        return null;
      case 'touching':
        if (lateral > PIN_SLIDE_OFF || clear) {
          this.state = 'idle';
          return 'leave';
        }
        if (height <= -PIN_ARM_DEPTH) {
          this.state = 'armed';
          return 'armed';
        }
        return null;
      case 'armed':
        if (lateral > PIN_SLIDE_OFF) {
          this.state = 'cancelled';
          return 'cancel';
        }
        if (height > 0) {
          this.state = 'idle';
          return 'commit';
        }
        return null;
      case 'cancelled':
        // Must leave entirely, or sliding back onto the pin would press it.
        if (clear) this.state = 'idle';
        return null;
    }
  }
}

export type PinCandidate = { x: number; z: number; level: number; importance: number };

/** Greedy by importance: a pin shows only if it isn't crowded at this zoom. */
export function visiblePins<T extends PinCandidate>(pins: T[], metresToModel: number, zoom: number, minSpacing = PIN_MIN_SPACING): T[] {
  const scale = metresToModel * zoom;
  const kept: T[] = [];
  for (const pin of [...pins].sort((a, b) => b.importance - a.importance)) {
    const crowded = kept.some((other) => other.level === pin.level && Math.hypot(other.x - pin.x, other.z - pin.z) * scale < minSpacing);
    if (!crowded) kept.push(pin);
  }
  return kept;
}
