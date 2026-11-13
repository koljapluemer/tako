// Small pure helpers behind the headset's sound and haptic feedback.
import type * as THREE from 'three';
import type { Cue } from './audio';

/** Where parts of the scene report what should be heard; `at` places the sound in the world. */
export type FeedbackSink = (cue: Cue, at?: THREE.Vector3) => void;

/** Reports when a hand's pointer moves onto a new target, so a hover can be felt once rather than continuously. */
export class HoverTracker {
  private last = new Map<unknown, { key: string | null; at: number }>();

  constructor(private cooldownMs = 80) {}

  /** True when `key` is a target this hand wasn't already on and the cooldown has passed. */
  update(hand: unknown, key: string | null, now: number): boolean {
    const previous = this.last.get(hand);
    if (previous?.key === key) return false;
    const fire = key != null && (!previous || now - previous.at >= this.cooldownMs);
    // Leaving a target does not restart the cooldown; only a felt hover does.
    this.last.set(hand, { key, at: fire ? now : previous?.at ?? -Infinity });
    return fire;
  }

  reset() {
    this.last.clear();
  }
}

/** How many multiples of `step` lie between two slider values. */
export function stepsCrossed(before: number, after: number, step: number): number {
  return Math.abs(Math.floor(after / step + 1e-9) - Math.floor(before / step + 1e-9));
}

/** Lets an action through at most once every `ms`. */
export class Throttle {
  private next = -Infinity;

  constructor(private ms: number) {}

  take(now: number): boolean {
    if (now < this.next) return false;
    this.next = now + this.ms;
    return true;
  }
}

/**
 * How a message on the wrist behaves. `working` and `progress` stay up until replaced; only `progress`
 * (the agent reporting a step) makes a sound. `info` is silent and can be dismissed.
 */
export type NoticeKind = 'working' | 'progress' | 'done' | 'error' | 'info';

/** Agent messages: `status` while working, `reply` when finished, `error` when it failed. */
export function noticeKind(type: 'status' | 'reply' | 'error'): NoticeKind {
  return type === 'status' ? 'progress' : type === 'reply' ? 'done' : 'error';
}

type Haptics = Gamepad & { hapticActuators?: Array<{ pulse?: (value: number, ms: number) => unknown }> };

export function haptic(source: XRInputSource | null | undefined, intensity = 0.4, ms = 40) {
  const pad = source?.gamepad as Haptics | undefined;
  try {
    pad?.hapticActuators?.[0]?.pulse?.(intensity, ms);
  } catch {
    // Haptics are a nicety; devices that refuse them lose nothing.
  }
}
