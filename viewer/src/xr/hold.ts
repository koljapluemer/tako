type State =
  | { phase: 'idle' }
  | { phase: 'holding'; since: number }
  | { phase: 'spent' }; // completed, waiting for the button to come up

/** Press-and-hold timing: acts once per press, and only after an unbroken hold. */
export class Hold {
  private state: State = { phase: 'idle' };

  constructor(private ms: number) {}

  /**
   * Call every frame. Returns the progress from 0 up to 1, and is exactly 1 on the one frame the hold completes.
   * `blocked` restarts the timer but, unlike a release, doesn't allow a completed hold to fire again.
   */
  update(pressed: boolean, now: number, blocked = false): number {
    if (!pressed) {
      this.reset();
      return 0;
    }
    if (this.state.phase === 'spent') return 0;
    if (blocked) {
      this.reset();
      return 0;
    }
    if (this.state.phase === 'idle') this.state = { phase: 'holding', since: now };
    const progress = (now - this.state.since) / this.ms;
    if (progress < 1) return progress;
    this.state = { phase: 'spent' };
    return 1;
  }

  reset() {
    this.state = { phase: 'idle' };
  }
}
