import type * as THREE from 'three';
import type { Landing } from './landing';

export type Spot = Landing & { yaw?: number };

type State =
  | { phase: 'open'; best: Spot | null }
  | { phase: 'pinned'; best: Spot | null; pin: Spot };

/**
 * Where the user starts, and so where they return to.
 *
 * open:   nobody has been placed yet, and better spots may still arrive (the navmesh comes after the model).
 * pinned: the user was placed here, so this stays the start until they leave the session or the building.
 *
 * open --pin--> pinned --release--> open. Offers are remembered in both phases and only used when open.
 */
export class Spawn {
  private state: State = { phase: 'open', best: null };

  get phase() {
    return this.state.phase;
  }

  get spot(): Spot | null {
    return this.state.phase === 'pinned' ? this.state.pin : this.state.best;
  }

  offer(spot: Spot | null) {
    this.state = { ...this.state, best: spot };
  }

  /** Has no effect when already pinned: the first placement is the start. */
  pin(spot: Spot) {
    if (this.state.phase === 'pinned') return;
    this.state = { phase: 'pinned', best: this.state.best, pin: { ...spot, position: spot.position.clone() } };
  }

  release() {
    this.state = { phase: 'open', best: this.state.best };
  }

  /** A revision moved the model's origin. New offers already use the new origin, so only the pin moves. */
  translate(shift: THREE.Vector3) {
    if (this.state.phase === 'pinned') this.state.pin.position.add(shift);
  }
}
