import type { Bounds, NavGeometry } from './navmesh';

export type NavPointType = 'entrance' | 'stair' | 'room' | 'junction' | 'door';

export type NavPoint = {
  id: string;
  name: string;
  type: NavPointType;
  position: [number, number, number];
  yaw: number;
  level: number;
  importance: number;
  /** GlobalId of the door this point belongs to, when there is one. */
  anchor: string | null;
};

export type NavLevel = { y: number; name: string };
export type NavDoor = { bounds: Bounds; globalId: string | null; exterior: boolean };
export type NavSpace = { bounds: Bounds; name: string };
export type PointsInput = {
  components: NavGeometry[];
  doors: NavDoor[];
  spaces: NavSpace[];
  storeys: Array<{ name: string; floorY: number }>;
  /** The previous revision's points, so they hold still across edits. */
  previous?: NavPoint[];
};
export type PointsResult = { points: NavPoint[]; levels: NavLevel[] };

// Provisional, in metres: these want tuning across the corpus and on a headset, never against the bundled samples.
const MIN_CELL = 0.25;
const MAX_CELL = 0.35;
const MAX_NODES = 250_000;
const CLIMB = 0.45;
const SAME_SURFACE = 0.3;
const MIN_COMPONENT_M2 = 5;
const MIN_LEVEL_M2 = 8;
const LEVEL_GAP = 1.5;
const ON_LEVEL = 0.4;
const SADDLE_RATIO = 0.75;
const JUNCTION_MAX_HALF_WIDTH = 1.5;
const JUNCTION_CLUSTER = 1.5;
const DOOR_PROBE = 1.2;
const M2_PER_POINT = 40;
const MIN_POINTS = 3;
export const MAX_POINTS = 24;
/** Smaller watershed basins are fragments such as stair treads, not somewhere anyone would go. */
const MIN_ROOM_M2 = 4;
/** Paired doors, or two flights landing together, are one place to a visitor. */
const SAME_PLACE = 1.5;
const MAX_CANDIDATES = 300;
const RADIUS_MAX = 30;
const STABLE_RADIUS = 1.5;
const STABLE_WALKABLE = 0.5;
const FACING_RAYS = 16;
const TYPE_WEIGHT: Record<NavPointType, number> = { entrance: 1, stair: 0.9, room: 0.5, junction: 0.4, door: 0.3 };
const STEPS: Array<[number, number]> = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

type Graph = {
  cell: number;
  count: number;
  x: Float32Array; y: Float32Array; z: Float32Array;
  ix: Int32Array; iz: Int32Array;
  /** 8 per node, in STEPS order, -1 where there is no walkable neighbour. */
  next: Int32Array;
  columns: Map<string, number[]>;
};

const columnKey = (ix: number, iz: number) => `${ix},${iz}`;

function planArea(p: Float32Array) {
  let area = 0;
  for (let i = 0; i < p.length; i += 9) area += Math.abs((p[i + 3] - p[i]) * (p[i + 8] - p[i + 2]) - (p[i + 6] - p[i]) * (p[i + 5] - p[i + 2])) / 2;
  return area;
}

function buildGraph(components: NavGeometry[]): Graph | null {
  const kept = components.filter((c) => planArea(c.positions) >= MIN_COMPONENT_M2);
  const area = kept.reduce((sum, c) => sum + planArea(c.positions), 0);
  if (!area) return null;
  const cell = Math.min(MAX_CELL, Math.max(MIN_CELL, Math.sqrt(area / MAX_NODES)));

  const columns = new Map<string, number[]>();
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const ixs: number[] = [];
  const izs: number[] = [];
  const add = (ix: number, iz: number, y: number) => {
    const key = columnKey(ix, iz);
    let column = columns.get(key);
    if (!column) columns.set(key, (column = []));
    if (column.some((node) => Math.abs(ys[node] - y) < SAME_SURFACE)) return;
    column.push(xs.length);
    xs.push((ix + 0.5) * cell); ys.push(y); zs.push((iz + 0.5) * cell); ixs.push(ix); izs.push(iz);
  };

  for (const { positions: p } of kept) {
    for (let t = 0; t < p.length; t += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = [p[t], p[t + 1], p[t + 2], p[t + 3], p[t + 4], p[t + 5], p[t + 6], p[t + 7], p[t + 8]];
      const denominator = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(denominator) < 1e-9) continue;
      const i0 = Math.floor(Math.min(ax, bx, cx) / cell);
      const i1 = Math.floor(Math.max(ax, bx, cx) / cell);
      const k0 = Math.floor(Math.min(az, bz, cz) / cell);
      const k1 = Math.floor(Math.max(az, bz, cz) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let k = k0; k <= k1; k++) {
          const [x, z] = [(i + 0.5) * cell, (k + 0.5) * cell];
          const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / denominator;
          const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / denominator;
          if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
          add(i, k, u * ay + v * by + (1 - u - v) * cy);
        }
      }
    }
  }

  const count = xs.length;
  const next = new Int32Array(count * 8).fill(-1);
  for (let node = 0; node < count; node++) {
    STEPS.forEach(([dx, dz], direction) => {
      const column = columns.get(columnKey(ixs[node] + dx, izs[node] + dz));
      if (!column) return;
      let best = -1;
      let bestDy = CLIMB;
      for (const other of column) {
        const dy = Math.abs(ys[other] - ys[node]);
        if (dy <= bestDy) { best = other; bestDy = dy; }
      }
      next[node * 8 + direction] = best;
    });
  }
  return {
    cell, count, columns, next,
    x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs),
    ix: Int32Array.from(ixs), iz: Int32Array.from(izs),
  };
}

class Heap {
  private items: Array<[number, number]> = [];
  get size() { return this.items.length; }
  push(priority: number, value: number) {
    const a = this.items;
    a.push([priority, value]);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent][0] <= a[i][0]) break;
      [a[parent], a[i]] = [a[i], a[parent]];
      i = parent;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const stepLength = (direction: number, cell: number) => (direction % 2 ? cell * Math.SQRT2 : cell);

/** Walking distance outward from the sources, up to `limit`. */
function flood(graph: Graph, sources: number[], limit: number): Float32Array {
  const distance = new Float32Array(graph.count).fill(Infinity);
  const heap = new Heap();
  for (const source of sources) {
    distance[source] = 0;
    heap.push(0, source);
  }
  while (heap.size) {
    const [d, node] = heap.pop();
    if (d > distance[node]) continue;
    for (let direction = 0; direction < 8; direction++) {
      const other = graph.next[node * 8 + direction];
      if (other < 0) continue;
      const candidate = d + stepLength(direction, graph.cell);
      if (candidate < distance[other] && candidate <= limit) {
        distance[other] = candidate;
        heap.push(candidate, other);
      }
    }
  }
  return distance;
}

function distanceField(graph: Graph) {
  const boundary: number[] = [];
  for (let node = 0; node < graph.count; node++) {
    for (let direction = 0; direction < 8; direction += 2) {
      if (graph.next[node * 8 + direction] < 0) { boundary.push(node); break; }
    }
  }
  return flood(graph, boundary, Infinity);
}

function findLevels(graph: Graph, storeys: PointsInput['storeys']): NavLevel[] {
  const bins = new Map<number, number>();
  for (let node = 0; node < graph.count; node++) {
    const bin = Math.round(graph.y[node] * 10);
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  const minNodes = MIN_LEVEL_M2 / (graph.cell * graph.cell);
  const chosen: Array<{ y: number; nodes: number }> = [];
  for (const [bin, nodes] of [...bins].filter(([, n]) => n >= minNodes).sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    const y = bin / 10;
    if (chosen.every((level) => Math.abs(level.y - y) >= LEVEL_GAP)) chosen.push({ y, nodes });
  }
  return chosen.sort((a, b) => a.y - b.y).map(({ y }, index) => {
    const storey = storeys.reduce<PointsInput['storeys'][number] | null>((best, s) => (
      Math.abs(s.floorY - y) < ON_LEVEL + 0.2 && (!best || Math.abs(s.floorY - y) < Math.abs(best.floorY - y)) ? s : best
    ), null);
    return { y, name: storey?.name ?? `Level ${index + 1}` };
  });
}

/** Watershed from the widest points inward; a narrow neck such as a door keeps two sides apart. */
function findRegions(graph: Graph, field: Float32Array) {
  const order = Array.from({ length: graph.count }, (_, i) => i).sort((a, b) => (
    field[b] - field[a] || graph.ix[a] - graph.ix[b] || graph.iz[a] - graph.iz[b] || graph.y[a] - graph.y[b]
  ));
  const label = new Int32Array(graph.count).fill(-1);
  const parent: number[] = [];
  const peakNode: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (const node of order) {
    const touching = new Set<number>();
    for (let direction = 0; direction < 8; direction++) {
      const other = graph.next[node * 8 + direction];
      if (other >= 0 && label[other] >= 0) touching.add(find(label[other]));
    }
    if (!touching.size) {
      label[node] = parent.length;
      parent.push(parent.length);
      peakNode.push(node);
      continue;
    }
    const roots = [...touching].sort((a, b) => field[peakNode[b]] - field[peakNode[a]] || a - b);
    label[node] = roots[0];
    for (const root of roots.slice(1)) {
      if (field[node] >= SADDLE_RATIO * field[peakNode[root]]) parent[root] = roots[0];
    }
  }
  const compact = new Map<number, number>();
  const region = new Int32Array(graph.count);
  for (let node = 0; node < graph.count; node++) {
    const root = find(label[node]);
    if (!compact.has(root)) compact.set(root, compact.size);
    region[node] = compact.get(root)!;
  }
  const peaks: number[] = [];
  const sizes: number[] = new Array(compact.size).fill(0);
  for (const [root, id] of compact) peaks[id] = peakNode[root];
  for (let node = 0; node < graph.count; node++) sizes[region[node]]++;
  return { region, peaks, sizes, count: compact.size };
}

/** Brandes on the unweighted region adjacency graph, normalised to 0-1. */
function betweenness(adjacent: Array<Set<number>>): number[] {
  const n = adjacent.length;
  const score = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s++) {
    const stack: number[] = [];
    const predecessors: number[][] = Array.from({ length: n }, () => []);
    const paths = new Array<number>(n).fill(0);
    const depth = new Array<number>(n).fill(-1);
    paths[s] = 1;
    depth[s] = 0;
    const queue = [s];
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head];
      stack.push(v);
      for (const w of [...adjacent[v]].sort((a, b) => a - b)) {
        if (depth[w] < 0) { depth[w] = depth[v] + 1; queue.push(w); }
        if (depth[w] === depth[v] + 1) { paths[w] += paths[v]; predecessors[w].push(v); }
      }
    }
    const dependency = new Array<number>(n).fill(0);
    while (stack.length) {
      const w = stack.pop()!;
      for (const v of predecessors[w]) dependency[v] += (paths[v] / paths[w]) * (1 + dependency[w]);
      if (w !== s) score[w] += dependency[w];
    }
  }
  const max = Math.max(...score, 1e-9);
  return score.map((value) => value / max);
}

type Candidate = { node: number; type: NavPointType; region: number; anchor: string | null; name: string | null };

/** Ridge cells of the distance field whose ridge neighbours fall into three or more separate arcs. */
function findJunctions(graph: Graph, field: Float32Array): number[] {
  const ridge = new Uint8Array(graph.count);
  for (let node = 0; node < graph.count; node++) {
    for (let direction = 0; direction < 4; direction++) {
      const a = graph.next[node * 8 + direction];
      const b = graph.next[node * 8 + direction + 4];
      if ((a < 0 || field[a] <= field[node] + 1e-3) && (b < 0 || field[b] <= field[node] + 1e-3)) { ridge[node] = 1; break; }
    }
  }
  const out: number[] = [];
  for (let node = 0; node < graph.count; node++) {
    if (!ridge[node] || field[node] > JUNCTION_MAX_HALF_WIDTH) continue;
    let arcs = 0;
    for (let direction = 0; direction < 8; direction++) {
      const here = graph.next[node * 8 + direction];
      const previous = graph.next[node * 8 + ((direction + 7) % 8)];
      if (here >= 0 && ridge[here] && !(previous >= 0 && ridge[previous])) arcs++;
    }
    if (arcs >= 3) out.push(node);
  }
  const kept: number[] = [];
  for (const node of out) {
    if (kept.every((other) => Math.hypot(graph.x[node] - graph.x[other], graph.z[node] - graph.z[other]) > JUNCTION_CLUSTER || Math.abs(graph.y[node] - graph.y[other]) > CLIMB)) kept.push(node);
  }
  return kept;
}

function nodeNear(graph: Graph, x: number, y: number, z: number, radius: number): number {
  const reach = Math.ceil(radius / graph.cell);
  const ix = Math.floor(x / graph.cell);
  const iz = Math.floor(z / graph.cell);
  let best = -1;
  let bestDistance = radius;
  for (let i = ix - reach; i <= ix + reach; i++) {
    for (let k = iz - reach; k <= iz + reach; k++) {
      for (const node of graph.columns.get(columnKey(i, k)) ?? []) {
        if (Math.abs(graph.y[node] - y) > CLIMB) continue;
        const d = Math.hypot(graph.x[node] - x, graph.z[node] - z);
        if (d < bestDistance) { best = node; bestDistance = d; }
      }
    }
  }
  return best;
}

const levelOf = (y: number, levels: NavLevel[]) => levels.findIndex((level) => Math.abs(level.y - y) <= ON_LEVEL);

/** Cells off every level are stairs or ramps; each end of such a run is where a person arrives. */
function stairEnds(graph: Graph, levels: NavLevel[]): number[] {
  const off = new Uint8Array(graph.count);
  for (let node = 0; node < graph.count; node++) off[node] = levelOf(graph.y[node], levels) < 0 ? 1 : 0;
  const seen = new Uint8Array(graph.count);
  const ends: number[] = [];
  for (let start = 0; start < graph.count; start++) {
    if (!off[start] || seen[start]) continue;
    const touching = new Map<number, number[]>();
    const run = [start];
    seen[start] = 1;
    for (let head = 0; head < run.length; head++) {
      for (let direction = 0; direction < 8; direction++) {
        const other = graph.next[run[head] * 8 + direction];
        if (other < 0) continue;
        if (off[other]) {
          if (!seen[other]) { seen[other] = 1; run.push(other); }
        } else {
          const level = levelOf(graph.y[other], levels);
          if (!touching.has(level)) touching.set(level, []);
          touching.get(level)!.push(other);
        }
      }
    }
    // A run touching one level is a bump in the floor, not a way between levels.
    if (touching.size < 2) continue;
    for (const level of [...touching.keys()].sort((a, b) => a - b)) {
      const cells = touching.get(level)!;
      const cx = cells.reduce((sum, n) => sum + graph.x[n], 0) / cells.length;
      const cz = cells.reduce((sum, n) => sum + graph.z[n], 0) / cells.length;
      ends.push(cells.reduce((best, n) => (Math.hypot(graph.x[n] - cx, graph.z[n] - cz) < Math.hypot(graph.x[best] - cx, graph.z[best] - cz) ? n : best)));
    }
  }
  return ends;
}

function doorCandidates(graph: Graph, region: Int32Array, doors: NavDoor[], levels: NavLevel[]): Candidate[] {
  const out: Candidate[] = [];
  for (const { bounds: { min, max }, globalId, exterior } of doors) {
    const [cx, cz] = [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];
    const alongX = max[0] - min[0] >= max[2] - min[2];
    const [dx, dz] = alongX ? [0, DOOR_PROBE] : [DOOR_PROBE, 0];
    const centre = nodeNear(graph, cx, min[1], cz, 0.8);
    if (centre < 0) continue;
    const a = nodeNear(graph, cx + dx, min[1], cz + dz, 0.8);
    const b = nodeNear(graph, cx - dx, min[1], cz - dz, 0.8);
    const lowest = levelOf(graph.y[centre], levels) === 0;
    const opensOutside = a < 0 || b < 0;
    if ((opensOutside || exterior) && lowest) {
      out.push({ node: centre, type: 'entrance', region: region[centre], anchor: globalId, name: 'Entrance' });
    } else if (a >= 0 && b >= 0 && region[a] !== region[b]) {
      out.push({ node: centre, type: 'door', region: region[centre], anchor: globalId, name: 'Doorway' });
    }
  }
  return out;
}

/** Faces the longest open line of sight, so the user arrives looking into the space. */
function facing(graph: Graph, node: number): number {
  let bestYaw = 0;
  let bestLength = -1;
  for (let ray = 0; ray < FACING_RAYS; ray++) {
    const yaw = (ray / FACING_RAYS) * Math.PI * 2;
    const [dx, dz] = [-Math.sin(yaw), -Math.cos(yaw)];
    let length = 0;
    let y = graph.y[node];
    for (let step = 1; step < 200; step++) {
      const column = graph.columns.get(columnKey(
        Math.floor((graph.x[node] + dx * step * graph.cell) / graph.cell),
        Math.floor((graph.z[node] + dz * step * graph.cell) / graph.cell),
      ));
      const next = column?.find((other) => Math.abs(graph.y[other] - y) <= CLIMB);
      if (next == null) break;
      y = graph.y[next];
      length = step;
    }
    if (length > bestLength) { bestLength = length; bestYaw = yaw; }
  }
  return bestYaw > Math.PI ? bestYaw - 2 * Math.PI : bestYaw;
}

function onePerPlace(graph: Graph, candidates: Candidate[]): Candidate[] {
  const kept: Candidate[] = [];
  for (const candidate of candidates) {
    const duplicate = (candidate.type === 'entrance' || candidate.type === 'stair') && kept.some((other) => (
      other.type === candidate.type
      && Math.abs(graph.y[other.node] - graph.y[candidate.node]) <= CLIMB
      && Math.hypot(graph.x[other.node] - graph.x[candidate.node], graph.z[other.node] - graph.z[candidate.node]) < SAME_PLACE
    ));
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}

/** Highest score first; anything within radius of a chosen point goes, except what must always stay. */
function eliminate(order: Candidate[], scored: number[], distances: Float32Array[], radius: number): number[] {
  const removed = new Uint8Array(order.length);
  const chosen: number[] = [];
  for (let i = 0; i < order.length; i++) {
    if (removed[i]) continue;
    chosen.push(i);
    for (let j = i + 1; j < order.length; j++) {
      if (scored[j] < TYPE_WEIGHT.stair && distances[i][order[j].node] < radius) removed[j] = 1;
    }
  }
  return chosen;
}

export function generatePoints({ components, doors, spaces, storeys, previous = [] }: PointsInput): PointsResult {
  const graph = buildGraph(components);
  if (!graph) return { points: [], levels: [] };
  const levels = findLevels(graph, storeys);
  const field = distanceField(graph);
  const { region, peaks, sizes, count: regionCount } = findRegions(graph, field);

  const adjacent: Array<Set<number>> = Array.from({ length: regionCount }, () => new Set());
  for (let node = 0; node < graph.count; node++) {
    for (let direction = 0; direction < 8; direction++) {
      const other = graph.next[node * 8 + direction];
      if (other >= 0 && region[other] !== region[node]) adjacent[region[node]].add(region[other]);
    }
  }
  const between = betweenness(adjacent);
  const maxSize = Math.max(...sizes);

  const spaceName = (node: number) => spaces.find(({ bounds: { min, max } }) => (
    graph.x[node] >= min[0] && graph.x[node] <= max[0] && graph.z[node] >= min[2] && graph.z[node] <= max[2]
    && graph.y[node] >= min[1] - 0.5 && graph.y[node] <= max[1]
  ))?.name ?? null;

  const candidates: Candidate[] = onePerPlace(graph, [
    ...doorCandidates(graph, region, doors, levels),
    ...stairEnds(graph, levels).map((node): Candidate => ({ node, type: 'stair', region: region[node], anchor: null, name: 'Stairs' })),
    ...peaks.flatMap((node, id): Candidate[] => (
      sizes[id] * graph.cell * graph.cell >= MIN_ROOM_M2 ? [{ node, type: 'room', region: id, anchor: null, name: spaceName(node) }] : []
    )),
    ...findJunctions(graph, field).map((node): Candidate => ({ node, type: 'junction', region: region[node], anchor: null, name: 'Junction' })),
  ]);

  const scoreOf = (c: Candidate) => {
    const base = TYPE_WEIGHT[c.type];
    // Entrances and stair ends outrank any combination of the other terms, which is how they stay.
    if (base >= TYPE_WEIGHT.stair) return base + 1;
    return base * 0.5 + 0.2 * Math.sqrt(sizes[c.region] / maxSize) + 0.2 * between[c.region];
  };

  const points: NavPoint[] = [];
  const roomCounts = new Map<number, number>();
  levels.forEach((level, levelIndex) => {
    const onLevel = candidates.filter((c) => Math.abs(graph.y[c.node] - level.y) <= ON_LEVEL)
      .map((c) => ({ c, score: scoreOf(c) }))
      .sort((a, b) => b.score - a.score || graph.ix[a.c.node] - graph.ix[b.c.node] || graph.iz[a.c.node] - graph.iz[b.c.node])
      .slice(0, MAX_CANDIDATES);
    if (!onLevel.length) return;
    const order = onLevel.map(({ c }) => c);
    const scored = onLevel.map(({ score }) => score);
    const distances = order.map((c) => flood(graph, [c.node], RADIUS_MAX));
    let levelNodes = 0;
    for (let node = 0; node < graph.count; node++) if (Math.abs(graph.y[node] - level.y) <= ON_LEVEL) levelNodes++;
    const target = Math.max(MIN_POINTS, Math.min(MAX_POINTS, Math.round((levelNodes * graph.cell * graph.cell) / M2_PER_POINT)));

    let [low, high] = [0.5, RADIUS_MAX];
    let chosen = eliminate(order, scored, distances, low);
    for (let iteration = 0; iteration < 10; iteration++) {
      const radius = (low + high) / 2;
      const attempt = eliminate(order, scored, distances, radius);
      if (attempt.length >= target) { chosen = attempt; low = radius; } else { high = radius; }
    }

    // Areas with no walking route between them can't eliminate each other, so the radius alone can't bound the count.
    for (const index of chosen.slice(0, Math.max(MAX_POINTS, chosen.filter((i) => scored[i] >= TYPE_WEIGHT.stair).length))) {
      const c = order[index];
      let name = c.name;
      if (!name) {
        const next = (roomCounts.get(levelIndex) ?? 0) + 1;
        roomCounts.set(levelIndex, next);
        name = `Room ${next}`;
      }
      points.push({
        id: c.anchor ?? `${c.type}:${graph.ix[c.node]},${graph.iz[c.node]},${levelIndex}`,
        name,
        type: c.type,
        position: [graph.x[c.node], graph.y[c.node], graph.z[c.node]],
        yaw: facing(graph, c.node),
        level: levelIndex,
        importance: scored[index],
        anchor: c.anchor,
      });
    }
  });
  return { points: stabilise(previous, points, ([x, y, z]) => nodeNear(graph, x, y, z, STABLE_WALKABLE) >= 0), levels };
}

/**
 * Keeps points from jumping between revisions: a door keeps its identity through
 * its GlobalId, anything else settles on the previous point of its type close by.
 * `walkable` guards against holding on to a spot the edit removed.
 */
export function stabilise(previous: NavPoint[], next: NavPoint[], walkable: (position: NavPoint['position']) => boolean): NavPoint[] {
  const used = new Set<string>();
  return next.map((point) => {
    const match = previous.find((old) => !used.has(old.id) && (point.anchor
      ? old.anchor === point.anchor
      : !old.anchor && old.type === point.type && old.level === point.level
        && Math.hypot(old.position[0] - point.position[0], old.position[2] - point.position[2]) < STABLE_RADIUS));
    if (!match) return point;
    used.add(match.id);
    // A door follows its element; other points hold still if they can.
    if (point.anchor || !walkable(match.position)) return { ...point, id: match.id, name: match.name };
    return { ...point, id: match.id, name: match.name, position: match.position, yaw: match.yaw };
  });
}
