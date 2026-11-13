import { describe, expect, it } from 'vitest';
import { HoverTracker, noticeKind, stepsCrossed, Throttle } from './feedback';

describe('HoverTracker', () => {
  it('fires once when a hand moves onto a target', () => {
    const hover = new HoverTracker(80);
    expect(hover.update('right', 'a', 0)).toBe(true);
    expect(hover.update('right', 'a', 16)).toBe(false);
    expect(hover.update('right', null, 32)).toBe(false);
  });

  it('keeps hands apart', () => {
    const hover = new HoverTracker(80);
    expect(hover.update('left', 'a', 0)).toBe(true);
    expect(hover.update('right', 'a', 0)).toBe(true);
  });

  it('skips targets swept past within the cooldown', () => {
    const hover = new HoverTracker(80);
    expect(hover.update('right', 'a', 0)).toBe(true);
    expect(hover.update('right', 'b', 30)).toBe(false);
    expect(hover.update('right', 'c', 60)).toBe(false);
    expect(hover.update('right', 'd', 100)).toBe(true);
  });

  it('does not restart the cooldown on leaving', () => {
    const hover = new HoverTracker(80);
    hover.update('right', 'a', 0);
    hover.update('right', null, 70);
    expect(hover.update('right', 'a', 90)).toBe(true);
  });
});

describe('stepsCrossed', () => {
  it('counts step boundaries in either direction', () => {
    expect(stepsCrossed(0.05, 0.08, 0.1)).toBe(0);
    expect(stepsCrossed(0.05, 0.12, 0.1)).toBe(1);
    expect(stepsCrossed(0.95, 0.05, 0.1)).toBe(9);
  });

  it('counts landing exactly on a step', () => {
    expect(stepsCrossed(0.25, 0.3, 0.1)).toBe(1);
    expect(stepsCrossed(0.3, 0.3, 0.1)).toBe(0);
  });
});

describe('Throttle', () => {
  it('lets one through per interval', () => {
    const throttle = new Throttle(4000);
    expect(throttle.take(0)).toBe(true);
    expect(throttle.take(3999)).toBe(false);
    expect(throttle.take(4000)).toBe(true);
  });
});

describe('noticeKind', () => {
  it('maps agent message types', () => {
    expect(noticeKind('status')).toBe('progress');
    expect(noticeKind('reply')).toBe('done');
    expect(noticeKind('error')).toBe('error');
  });
});
