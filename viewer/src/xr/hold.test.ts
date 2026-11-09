import { describe, expect, it } from 'vitest';
import { Hold, TapHold } from './hold';

describe('TapHold', () => {
  it('taps on an early release', () => {
    const button = new TapHold(800);
    expect(button.update(true, 0).tap).toBe(false);
    expect(button.update(true, 100).tap).toBe(false);
    expect(button.update(false, 200).tap).toBe(true);
    expect(button.update(false, 300).tap).toBe(false);
  });

  it('completes once on a long press, with no tap at release', () => {
    const button = new TapHold(800);
    button.update(true, 0);
    expect(button.update(true, 800).progress).toBe(1);
    expect(button.update(true, 900).progress).toBe(0);
    expect(button.update(false, 1000).tap).toBe(false);
  });

  it('does not tap if the press was blocked at any point', () => {
    const button = new TapHold(800);
    button.update(true, 0);
    button.update(true, 100, true);
    button.update(true, 200);
    expect(button.update(false, 300).tap).toBe(false);
    button.update(true, 400);
    expect(button.update(false, 500).tap).toBe(true);
  });
});

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
