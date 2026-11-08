import { describe, expect, it } from 'vitest';
import { CELL_SIZE_XZ, cellKey } from './render-cells';

const at = (x: number, y: number, z: number) => new Float32Array([x - 0.5, y, z, x + 0.5, y, z]);

describe('cellKey', () => {
  it('groups nearby chunks and separates distant ones', () => {
    expect(cellKey(at(1, 1, 1))).toBe(cellKey(at(2, 1, 2)));
    expect(cellKey(at(1, 1, 1))).not.toBe(cellKey(at(1 + CELL_SIZE_XZ, 1, 1)));
  });

  it('handles negative coordinates from origin-shifted models', () => {
    expect(cellKey(at(-1, 1, 1))).not.toBe(cellKey(at(1, 1, 1)));
  });
});
