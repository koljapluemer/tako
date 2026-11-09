import { describe, expect, it } from 'vitest';
import { LABEL_END, PANEL_H, PANEL_W, rowAt, rowBox, TRACK_END, TRACK_START, trackValue, trackX } from './mini-controls';

describe('panel layout', () => {
  it('stacks the rows inside the panel without overlap', () => {
    const rows = [0, 1].map(rowBox);
    expect(rows[0].top).toBeGreaterThan(0);
    expect(rows[1].bottom).toBeLessThan(PANEL_H);
    expect(rows[0].bottom).toBeCloseTo(rows[1].top, 9);
  });

  it('keeps labels and controls in separate columns inside the panel', () => {
    expect(LABEL_END).toBeLessThan(TRACK_START);
    expect(TRACK_END).toBeLessThan(PANEL_W);
  });

  it('finds rows only in the control column', () => {
    expect(rowAt(TRACK_START, rowBox(1).centre)).toBe(1);
    expect(rowAt(LABEL_END, rowBox(1).centre)).toBe(-1);
    expect(rowAt(TRACK_START, 0)).toBe(-1);
    expect(rowAt(TRACK_START, PANEL_H)).toBe(-1);
  });
});

describe('track values', () => {
  it('clamps past either end', () => {
    expect(trackValue(-5)).toBe(0);
    expect(trackValue(5)).toBe(1);
  });

  it('reaches the full range and round-trips', () => {
    expect(trackValue(TRACK_START)).toBe(0);
    expect(trackValue(TRACK_END)).toBe(1);
    expect(trackValue(trackX(0.3))).toBeCloseTo(0.3, 9);
  });
});
