import { describe, expect, it } from 'vitest';
import { assembledHeight, fitScale, levelOffsets, LONGEST_SIDE, MAX_STACK, ROOM_ABOVE, stackDrop, stackHeight } from './mini-view';

const BASE_HEIGHT = 0.95;
const even = (count: number, step: number, from = 0) => Array.from({ length: count }, (_, i) => from + i * step);

const buildings: Array<{ name: string; x: number; z: number; ys: number[] }> = [
  { name: 'no levels', x: 10, z: 10, ys: [] },
  { name: 'one level', x: 12, z: 8, ys: [0] },
  { name: 'two levels', x: 30, z: 20, ys: [0, 3] },
  { name: 'sixty levels', x: 40, z: 40, ys: even(60, 3.5) },
  { name: 'uneven storeys', x: 25, z: 25, ys: [-3.2, 0, 6, 8.4, 20] },
  { name: '300 m tower', x: 30, z: 30, ys: even(80, 3.75) },
  { name: 'tiny footprint', x: 2, z: 2, ys: [0, 2.5] },
  { name: 'huge footprint', x: 500, z: 300, ys: [0, 5, 10] },
  { name: 'far below origin', x: 20, z: 20, ys: even(4, 3, -5000) },
];

describe.each(buildings)('$name', ({ x, z, ys }) => {
  const scale = fitScale(x, z, ys.length ? ys[ys.length - 1] - ys[0] : 0);

  it('fits the footprint', () => {
    expect(Math.max(x, z) * scale).toBeLessThanOrEqual(LONGEST_SIDE + 1e-9);
  });

  for (const spread of [0, 0.5, 1]) {
    it(`stays in its reserved space at spread ${spread}`, () => {
      const offsets = levelOffsets(ys, scale, spread);
      expect(offsets.every(Number.isFinite)).toBe(true);
      offsets.slice(1).forEach((offset, i) => expect(offset).toBeGreaterThan(offsets[i]));
      const height = stackHeight(offsets, scale);
      expect(height).toBeLessThanOrEqual(MAX_STACK + 1e-9);
      expect(BASE_HEIGHT - stackDrop(height)).toBeGreaterThan(0);
      expect(height - stackDrop(height)).toBeLessThanOrEqual(ROOM_ABOVE + 1e-9);
    });
  }

  it('keeps true storey ratios when assembled', () => {
    levelOffsets(ys, scale, 0).forEach((offset, i) => expect(offset).toBeCloseTo((ys[i] - ys[0]) * scale, 9));
  });

  if (ys.length > 1) {
    it('fills the stack at full spread', () => {
      expect(assembledHeight(ys, scale)).toBeLessThan(MAX_STACK);
      expect(stackHeight(levelOffsets(ys, scale, 1), scale)).toBeCloseTo(MAX_STACK, 9);
    });
  }
});
