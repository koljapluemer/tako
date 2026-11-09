import { describe, expect, it } from 'vitest';
import { openingsFreedBy } from './delete-targets';

describe('openingsFreedBy', () => {
  it('frees the opening of a deleted filling', () => {
    expect(openingsFreedBy([{ opening: 10, filling: 1 }], new Set([1]))).toEqual([10]);
  });

  it('keeps an opening that another filling still uses', () => {
    expect(openingsFreedBy([{ opening: 10, filling: 1 }, { opening: 10, filling: 2 }], new Set([1]))).toEqual([]);
  });

  it('frees a shared opening when all its fillings are deleted', () => {
    expect(openingsFreedBy([{ opening: 10, filling: 1 }, { opening: 10, filling: 2 }], new Set([1, 2]))).toEqual([10]);
  });

  it('leaves openings of untargeted fillings alone', () => {
    expect(openingsFreedBy([{ opening: 10, filling: 1 }], new Set([2]))).toEqual([]);
  });
});
