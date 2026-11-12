// An element's oriented plan rectangle, matching SpatialIndex._set_geometry in python/py/spatial.py.

export type Footprint = { axis: [number, number]; length: number; thickness: number; centre: [number, number] };

/** Principal horizontal direction of IFC plan points (x, y pairs) and the extents along and across it. */
export function footprint(xy: ArrayLike<number>): Footprint {
  const n = xy.length / 2;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xy[i * 2];
    my += xy[i * 2 + 1];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let spread = 0;
  for (let i = 0; i < n; i++) {
    const dx = xy[i * 2] - mx;
    const dy = xy[i * 2 + 1] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    spread = Math.max(spread, Math.abs(dx), Math.abs(dy));
  }
  let axis: [number, number] = [1, 0];
  if (n >= 2 && spread > 1e-6) {
    // Largest-eigenvalue eigenvector of the 2x2 covariance, as the first right singular vector of the centred points.
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    axis = [Math.cos(angle), Math.sin(angle)];
  }
  // Canonical sign so the same wall always yields the same axis.
  if (axis[0] < -1e-9 || (Math.abs(axis[0]) <= 1e-9 && axis[1] < 0)) axis = [-axis[0], -axis[1]];
  const perp: [number, number] = [-axis[1], axis[0]];
  let aMin = Infinity;
  let aMax = -Infinity;
  let pMin = Infinity;
  let pMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = xy[i * 2] - mx;
    const dy = xy[i * 2 + 1] - my;
    const a = dx * axis[0] + dy * axis[1];
    const p = dx * perp[0] + dy * perp[1];
    aMin = Math.min(aMin, a);
    aMax = Math.max(aMax, a);
    pMin = Math.min(pMin, p);
    pMax = Math.max(pMax, p);
  }
  const a = (aMax + aMin) / 2;
  const p = (pMax + pMin) / 2;
  return {
    axis,
    length: aMax - aMin,
    thickness: pMax - pMin,
    centre: [mx + axis[0] * a + perp[0] * p, my + axis[1] * a + perp[1] * p],
  };
}
