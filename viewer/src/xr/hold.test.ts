import { describe, expect, it } from 'vitest';
import { Hold } from './hold';

describe('Hold', () => {
  it('reports progress and completes after the full duration', () => {
    const hold = new Hold(800);
    expect(hold.update(true, 1000)).toBe(0);
    expect(hold.update(true, 1400)).toBeCloseTo(0.5);
    expect(hold.update(true, 1800)).toBe(1);
  });

  it('starts over after an early release', () => {
    const hold = new Hold(800);
    hold.update(true, 0);
    hold.update(true, 700);
    expect(hold.update(false, 750)).toBe(0);
    expect(hold.update(true, 800)).toBe(0);
    expect(hold.update(true, 1500)).toBeLessThan(1);
  });

  it('completes only once until the button is released', () => {
    const hold = new Hold(800);
    hold.update(true, 0);
    expect(hold.update(true, 800)).toBe(1);
    expect(hold.update(true, 900)).toBe(0);
    expect(hold.update(true, 5000)).toBe(0);
    hold.update(false, 5100);
    hold.update(true, 5200);
    expect(hold.update(true, 6000)).toBe(1);
  });

  it('restarts the timer while blocked', () => {
    const hold = new Hold(800);
    hold.update(true, 0);
    hold.update(true, 700);
    expect(hold.update(true, 750, true)).toBe(0);
    expect(hold.update(true, 800)).toBe(0);
    expect(hold.update(true, 1500)).toBeLessThan(1);
  });

  it('does not repeat when a block ends with the button still held', () => {
    const hold = new Hold(800);
    hold.update(true, 0);
    expect(hold.update(true, 800)).toBe(1);
    hold.update(true, 900, true);
    expect(hold.update(true, 2000)).toBe(0);
  });
});
