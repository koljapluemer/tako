import { handOf, type Hand, type Pointer } from './pointer';

const HOLD_MS = 200;

/** What a held trigger does. */
export interface Aim {
  readonly aiming: boolean;
  begin(pointer: Pointer): void;
  release(pointer: Pointer): void;
  abandon(pointer: Pointer): void;
}

type Press = { at: number; claimed: boolean; aim: Aim | null };

/**
 * Decides what a trigger press means. UI gets first refusal; otherwise a held
 * press starts that hand's aim and a short one does nothing.
 */
export class TriggerRouter {
  private presses = new Map<Pointer, Press>();
  /** Set while the user is being moved. */
  locked = false;
  claim: (pointer: Pointer) => boolean = () => false;

  constructor(private aims: Record<Hand, Aim>) {}

  down(pointer: Pointer, now = performance.now()) {
    this.presses.set(pointer, { at: now, claimed: this.claim(pointer), aim: null });
  }

  up(pointer: Pointer) {
    const press = this.presses.get(pointer);
    if (!press) return;
    this.presses.delete(pointer);
    press.aim?.release(pointer);
  }

  disconnected(pointer: Pointer) {
    this.presses.get(pointer)?.aim?.abandon(pointer);
    this.presses.delete(pointer);
  }

  update(now = performance.now()) {
    if (this.locked) return;
    for (const [pointer, press] of this.presses) {
      if (press.claimed || press.aim || now - press.at <= HOLD_MS) continue;
      press.aim = this.aims[handOf(pointer)];
      press.aim.begin(pointer);
    }
  }
}
