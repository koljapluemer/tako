import { describe, expect, it } from 'vitest';
import { fitScale, LONGEST_SIDE, MAX_HEIGHT } from './mini-view';

const buildings = [
  { name: 'no height', x: 10, z: 10, height: 0 },
  { name: 'house', x: 12, z: 8, height: 6 },
  { name: '300 m tower', x: 30, z: 30, height: 300 },
  { name: 'tiny footprint', x: 2, z: 2, height: 2.5 },
  { name: 'huge footprint', x: 500, z: 300, height: 10 },
];

describe.each(buildings)('$name', ({ x, z, height }) => {
  const scale = fitScale(x, z, height);

  it('fits its reserved space', () => {
    expect(Math.max(x, z) * scale).toBeLessThanOrEqual(LONGEST_SIDE + 1e-9);
    expect(height * scale).toBeLessThanOrEqual(MAX_HEIGHT + 1e-9);
  });

  it('fills one of the limits', () => {
    const filled = Math.max(Math.max(x, z, 1) * scale / LONGEST_SIDE, Math.max(height, 1) * scale / MAX_HEIGHT);
    expect(filled).toBeCloseTo(1, 9);
  });
});
