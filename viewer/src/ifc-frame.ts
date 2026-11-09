// Viewer geometry is Y-up metres, shifted by web-ifc's coordination matrix. Everything the agent reads is IFC world: Z-up metres.
import type { Vec3 } from './xr/paint-log';

export type Compass = 'north' | 'east' | 'south' | 'west';
/** Unit vector of true north in the IFC plan. */
export type North = [number, number];

const COMPASS: Compass[] = ['north', 'east', 'south', 'west'];

export function viewerToIfc([x, y, z]: Vec3, shift: Vec3): Vec3 {
  return [x - shift[0], shift[2] - z, y - shift[1]];
}

/** Viewer +z is IFC -y, so that axis's min and max trade places. */
export function viewerBoundsToIfc(min: Vec3, max: Vec3, shift: Vec3): { min: Vec3; max: Vec3 } {
  return { min: viewerToIfc([min[0], min[1], max[2]], shift), max: viewerToIfc([max[0], max[1], min[2]], shift) };
}

export function compassVector(direction: Compass, [nx, ny]: North): [number, number] {
  return { north: [nx, ny], east: [ny, -nx], south: [-nx, -ny], west: [-ny, nx] }[direction] as [number, number];
}

/** The compass direction closest to a plan vector. */
export function compassOf([x, y]: [number, number], north: North): Compass {
  const score = (direction: Compass) => {
    const [cx, cy] = compassVector(direction, north);
    return x * cx + y * cy;
  };
  return COMPASS.reduce((best, direction) => (score(direction) > score(best) ? direction : best));
}
