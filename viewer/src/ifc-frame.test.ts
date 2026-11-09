import { describe, expect, it } from 'vitest';
import { compassOf, compassVector, viewerBoundsToIfc, viewerToIfc, type North } from './ifc-frame';
import type { Vec3 } from './xr/paint-log';

const shift: Vec3 = [-8, 0.5, 3];

describe('viewer to IFC', () => {
  it('undoes the shift and the axis swap', () => {
    const ifc: Vec3 = [1, 2, 3];
    expect(viewerToIfc([ifc[0] + shift[0], ifc[2] + shift[1], -ifc[1] + shift[2]], shift)).toEqual(ifc);
  });

  it('keeps min below max on every axis', () => {
    const { min, max } = viewerBoundsToIfc([0, 0, 0], [1, 2, 3], shift);
    min.forEach((value, axis) => expect(value).toBeLessThan(max[axis]));
  });
});

describe('compass', () => {
  const plusY: North = [0, 1];

  it('puts east clockwise from north', () => {
    expect(compassVector('east', plusY)).toEqual([1, -0]);
    expect(compassVector('west', plusY)).toEqual([-1, 0]);
  });

  it('names plan directions with +Y north', () => {
    expect(compassOf([0, 1], plusY)).toBe('north');
    expect(compassOf([1, 0], plusY)).toBe('east');
    expect(compassOf([0, -1], plusY)).toBe('south');
    expect(compassOf([-1, 0], plusY)).toBe('west');
  });

  it('follows a rotated true north', () => {
    expect(compassOf([0, 1], [1, 0])).toBe('west');
    expect(compassOf([1, 0], [1, 0])).toBe('north');
  });
});
