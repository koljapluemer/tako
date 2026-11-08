import { getNavMeshPositionsAndIndices, init } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';

export type Bounds = { min: [number, number, number]; max: [number, number, number] };
export type NavGeometry = { positions: Float32Array; indices: Uint32Array };

export type NavInput = NavGeometry & {
  /** Door leaves are not obstacles: each one gets a floor patch, because slabs often stop at the opening. */
  doors: Bounds[];
  /** These block a person but their tops are not somewhere to stand. */
  furniture: Bounds[];
};

/** Triangles in soup form, grouped so that `components[0]` is the largest connected walkable area. */
export type NavMeshData = { components: NavGeometry[] };

// Provisional, in metres: see doc/vr-headset-checklist.md.
const CELL = 0.15;
const CELL_HEIGHT = 0.05;
const AGENT_RADIUS = 0.2;
const AGENT_HEIGHT = 1.8;
// Recast's ledge filter compares the steps on both sides of a cell, so this must span two risers (~2 x 0.2 m).
const AGENT_CLIMB = 0.45;
const MAX_SLOPE_DEGREES = 40;
const MIN_REGION_M2 = 0.5;
const DOOR_PATCH_REACH = 0.4;
const FURNITURE_TOP_TOLERANCE = 0.15;
const WELD = 0.02;

let ready: Promise<void> | null = null;
export const initNavmesh = () => (ready ??= init());

export function boundsOf(positions: Float32Array): Bounds {
  const min: Bounds['min'] = [Infinity, Infinity, Infinity];
  const max: Bounds['max'] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    const axis = i % 3;
    min[axis] = Math.min(min[axis], positions[i]);
    max[axis] = Math.max(max[axis], positions[i]);
  }
  return { min, max };
}

/** Extends the geometry with an up-facing quad through each door, reaching past its thin side. */
function withDoorPatches({ positions, indices, doors }: NavInput): NavGeometry {
  const out = new Float32Array(positions.length + doors.length * 12);
  const outIndices = new Uint32Array(indices.length + doors.length * 6);
  out.set(positions);
  outIndices.set(indices);
  let vertex = positions.length / 3;
  let index = indices.length;
  doors.forEach(({ min, max }, i) => {
    const alongX = max[0] - min[0] >= max[2] - min[2];
    const x0 = min[0] - (alongX ? 0 : DOOR_PATCH_REACH);
    const x1 = max[0] + (alongX ? 0 : DOOR_PATCH_REACH);
    const z0 = min[2] - (alongX ? DOOR_PATCH_REACH : 0);
    const z1 = max[2] + (alongX ? DOOR_PATCH_REACH : 0);
    out.set([x0, min[1], z0, x0, min[1], z1, x1, min[1], z1, x1, min[1], z0], positions.length + i * 12);
    outIndices.set([vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3], index);
    vertex += 4;
    index += 6;
  });
  return { positions: out, indices: outIndices };
}

function onFurnitureTop(x: number, y: number, z: number, furniture: Bounds[]) {
  return furniture.some(({ min, max }) => x >= min[0] && x <= max[0] && z >= min[2] && z <= max[2]
    && Math.abs(y - max[1]) < FURNITURE_TOP_TOLERANCE);
}

/** Splits triangle soup into connected components, joining triangles that share a welded vertex. */
export function splitComponents(positions: ArrayLike<number>, indices: ArrayLike<number>): NavGeometry[] {
  // Neighbouring polygons share a vertex in plan, but each samples its own height there (notably on stairs).
  const columns = new Map<string, Array<{ y: number; id: number }>>();
  let count = 0;
  const weld = (vertex: number) => {
    const key = `${Math.round(positions[vertex * 3] / WELD)},${Math.round(positions[vertex * 3 + 2] / WELD)}`;
    const y = positions[vertex * 3 + 1];
    let column = columns.get(key);
    if (!column) columns.set(key, (column = []));
    const found = column.find((entry) => Math.abs(entry.y - y) <= AGENT_CLIMB);
    if (found) return found.id;
    column.push({ y, id: count });
    return count++;
  };
  const triangles = indices.length / 3;
  const welded = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) welded[i] = weld(indices[i]);

  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let t = 0; t < triangles; t++) {
    parent[find(welded[t * 3 + 1])] = find(welded[t * 3]);
    parent[find(welded[t * 3 + 2])] = find(welded[t * 3]);
  }

  const groups = new Map<number, { triangles: number[]; area: number }>();
  for (let t = 0; t < triangles; t++) {
    const root = find(welded[t * 3]);
    let group = groups.get(root);
    if (!group) groups.set(root, (group = { triangles: [], area: 0 }));
    group.triangles.push(t);
    const [a, b, c] = [indices[t * 3] * 3, indices[t * 3 + 1] * 3, indices[t * 3 + 2] * 3];
    // Plan area is what matters for "the main floor", and is not inflated by steps.
    group.area += Math.abs((positions[b] - positions[a]) * (positions[c + 2] - positions[a + 2]) - (positions[c] - positions[a]) * (positions[b + 2] - positions[a + 2])) / 2;
  }

  return [...groups.values()].sort((a, b) => b.area - a.area).map((group) => {
    const out = new Float32Array(group.triangles.length * 9);
    group.triangles.forEach((t, i) => {
      for (let corner = 0; corner < 3; corner++) {
        const v = indices[t * 3 + corner] * 3;
        out.set([positions[v], positions[v + 1], positions[v + 2]], i * 9 + corner * 3);
      }
    });
    return { positions: out, indices: Uint32Array.from({ length: group.triangles.length * 3 }, (_, i) => i) };
  });
}

/** Walkability comes from the geometry alone. Returns null when nothing walkable can be derived. */
export function buildNavmesh(input: NavInput): NavMeshData | null {
  const { positions, indices } = withDoorPatches(input);
  if (!indices.length) return null;
  const { success, navMesh } = generateSoloNavMesh(positions, indices, {
    cs: CELL,
    ch: CELL_HEIGHT,
    walkableSlopeAngle: MAX_SLOPE_DEGREES,
    walkableHeight: Math.ceil(AGENT_HEIGHT / CELL_HEIGHT),
    walkableClimb: Math.floor(AGENT_CLIMB / CELL_HEIGHT),
    walkableRadius: Math.ceil(AGENT_RADIUS / CELL),
    minRegionArea: Math.ceil(MIN_REGION_M2 / (CELL * CELL)),
    mergeRegionArea: Math.ceil(4 / (CELL * CELL)),
    maxEdgeLen: 40,
    maxSimplificationError: 1.3,
    maxVertsPerPoly: 6,
    // Both in voxels: the generator scales them, and a sample distance under 0.9 m crashes Recast's detail step.
    detailSampleDist: 6,
    detailSampleMaxError: 1,
  });
  if (!success) return null;
  const [navPositions, navIndices] = getNavMeshPositionsAndIndices(navMesh);
  navMesh.destroy();

  const kept: number[] = [];
  for (let t = 0; t < navIndices.length; t += 3) {
    const [a, b, c] = [navIndices[t] * 3, navIndices[t + 1] * 3, navIndices[t + 2] * 3];
    const x = (navPositions[a] + navPositions[b] + navPositions[c]) / 3;
    const y = (navPositions[a + 1] + navPositions[b + 1] + navPositions[c + 1]) / 3;
    const z = (navPositions[a + 2] + navPositions[b + 2] + navPositions[c + 2]) / 3;
    if (!onFurnitureTop(x, y, z, input.furniture)) kept.push(navIndices[t], navIndices[t + 1], navIndices[t + 2]);
  }
  if (!kept.length) return null;
  return { components: splitComponents(navPositions, kept) };
}
