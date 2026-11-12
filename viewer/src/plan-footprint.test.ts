import { describe, expect, it } from 'vitest';
import { footprint } from './plan-footprint';

/** Corners of a length x thickness rectangle centred at (cx, cy), its long side at `degrees`. */
function rectangle(length: number, thickness: number, degrees: number, cx = 0, cy = 0): number[] {
  const r = (degrees * Math.PI) / 180;
  const ax = [Math.cos(r), Math.sin(r)];
  const px = [-ax[1], ax[0]];
  const out: number[] = [];
  for (const [a, p] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    out.push(cx + (a * length * ax[0]) / 2 + (p * thickness * px[0]) / 2, cy + (a * length * ax[1]) / 2 + (p * thickness * px[1]) / 2);
  }
  return out;
}

describe('footprint', () => {
  it('finds the long side of an axis-aligned box', () => {
    const f = footprint(rectangle(4, 0.3, 0, 10, -2));
    expect(f.axis[0]).toBeCloseTo(1);
    expect(f.axis[1]).toBeCloseTo(0);
    expect(f.length).toBeCloseTo(4);
    expect(f.thickness).toBeCloseTo(0.3);
    expect(f.centre[0]).toBeCloseTo(10);
    expect(f.centre[1]).toBeCloseTo(-2);
  });

  it('follows a rotated wall', () => {
    const f = footprint(rectangle(5, 0.25, 30, 1, 2));
    expect(f.axis[0]).toBeCloseTo(Math.cos(Math.PI / 6));
    expect(f.axis[1]).toBeCloseTo(Math.sin(Math.PI / 6));
    expect(f.length).toBeCloseTo(5);
    expect(f.thickness).toBeCloseTo(0.25);
    expect(f.centre[0]).toBeCloseTo(1);
    expect(f.centre[1]).toBeCloseTo(2);
  });

  it('gives the same axis sign whichever way the wall was drawn', () => {
    expect(footprint(rectangle(3, 0.2, 150)).axis).toEqual(footprint(rectangle(3, 0.2, -30)).axis);
    const vertical = footprint(rectangle(3, 0.2, -90)).axis;
    expect(vertical[0]).toBeCloseTo(0);
    expect(vertical[1]).toBeCloseTo(1);
  });

  it('measures a centre that is not the vertex mean', () => {
    // An extra vertex on one end pulls the mean, not the rectangle.
    const f = footprint([...rectangle(4, 0.2, 0), 2, 0, 2, 0.05]);
    expect(f.centre[0]).toBeCloseTo(0);
    expect(f.length).toBeCloseTo(4);
  });

  it('falls back to +x for a point', () => {
    const f = footprint([3, 4, 3, 4]);
    expect(f.axis).toEqual([1, 0]);
    expect(f.length).toBe(0);
    expect(f.centre).toEqual([3, 4]);
  });
});
