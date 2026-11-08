/// <reference lib="webworker" />
// Parses IFC off the main thread: a stalled frame in a headset is physically unpleasant.
import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { IFCBUILDINGSTOREY, IFCRELAGGREGATES, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCSITE, IfcAPI } from 'web-ifc';
import { classify, isDoor, isSlab, isStair } from './ifc-classes';
import type {
  Box2, CollisionPart, ElementInfo, LoadResult, RenderPart, Rgba, StoreyInfo, WorkerRequest, WorkerResponse,
} from './worker-protocol';

const api = new IfcAPI();
api.SetWasmPath('/wasm/', true);
const ready = api.Init(undefined, true); // single-threaded: no COOP/COEP headers needed

let openModel: number | null = null;

// --- geometry accumulation ---------------------------------------------------
type Chunk = { positions: Float32Array; normals: Float32Array; indices: Uint32Array; expressID: number };

function concat(chunks: Chunk[], withNormals: boolean) {
  const vertexCount = chunks.reduce((n, c) => n + c.positions.length / 3, 0);
  const indexCount = chunks.reduce((n, c) => n + c.indices.length, 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(withNormals ? vertexCount * 3 : 0);
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let i = 0;
  for (const c of chunks) {
    positions.set(c.positions, v * 3);
    if (withNormals) normals.set(c.normals, v * 3);
    for (let k = 0; k < c.indices.length; k++) indices[i + k] = c.indices[k] + v;
    v += c.positions.length / 3;
    i += c.indices.length;
  }
  return { positions, normals, indices };
}

/** Bakes a placement into world-space arrays, so meshes can be merged. */
function bake(verts: Float32Array, indices: Uint32Array, transform: number[], expressID: number): Chunk {
  const matrix = new Matrix4().fromArray(transform);
  const normalMatrix = new Matrix3().getNormalMatrix(matrix);
  const count = verts.length / 6;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const p = new Vector3();
  const n = new Vector3();
  for (let i = 0; i < count; i++) {
    p.set(verts[i * 6], verts[i * 6 + 1], verts[i * 6 + 2]).applyMatrix4(matrix);
    n.set(verts[i * 6 + 3], verts[i * 6 + 4], verts[i * 6 + 5]).applyMatrix3(normalMatrix).normalize();
    positions.set([p.x, p.y, p.z], i * 3);
    normals.set([n.x, n.y, n.z], i * 3);
  }
  const out = new Uint32Array(indices);
  // three flips winding for mirrored objects at draw time; baked geometry has to do it here.
  if (matrix.determinant() < 0) {
    for (let i = 0; i < out.length; i += 3) [out[i + 1], out[i + 2]] = [out[i + 2], out[i + 1]];
  }
  return { positions, normals, indices: out, expressID };
}

function buildCollision(chunks: Chunk[], transfer: Set<ArrayBuffer>): CollisionPart | null {
  if (!chunks.length) return null;
  const { positions, indices } = concat(chunks, false);
  const rangeStarts = new Uint32Array(chunks.length);
  const rangeIds = new Uint32Array(chunks.length);
  let triangle = 0;
  chunks.forEach((c, i) => {
    rangeStarts[i] = triangle;
    rangeIds[i] = c.expressID;
    triangle += c.indices.length / 3;
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  // `indirect` keeps triangle order intact, so faceIndex still maps through rangeStarts.
  const bvh = MeshBVH.serialize(new MeshBVH(geometry, { indirect: true }), { cloneBuffers: false });
  transfer.add(positions.buffer as ArrayBuffer);
  transfer.add(rangeStarts.buffer as ArrayBuffer);
  transfer.add(rangeIds.buffer as ArrayBuffer);
  if (bvh.index) transfer.add(bvh.index.buffer as ArrayBuffer);
  if (bvh.indirectBuffer) transfer.add(bvh.indirectBuffer.buffer as ArrayBuffer);
  bvh.roots.forEach((r) => transfer.add(r as ArrayBuffer));
  return { positions, bvh, rangeStarts, rangeIds };
}

// --- spatial structure ------------------------------------------------------
type Bounds = { min: Vector3; max: Vector3 };

function extend(map: Map<number, Bounds>, id: number, positions: Float32Array) {
  let b = map.get(id);
  if (!b) {
    b = { min: new Vector3(Infinity, Infinity, Infinity), max: new Vector3(-Infinity, -Infinity, -Infinity) };
    map.set(id, b);
  }
  const p = new Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    p.fromArray(positions, i);
    b.min.min(p);
    b.max.max(p);
  }
}

const refs = (v: unknown): number[] =>
  (Array.isArray(v) ? v : [v]).map((r) => (r as { value: number } | null)?.value).filter((n): n is number => n != null);

/** Maps every element to its storey, following aggregates (a stair contained in a storey owns its flights). */
function elementStoreys(modelID: number): Map<number, number> {
  const owner = new Map<number, number>();
  const contained = api.GetLineIDsWithType(modelID, IFCRELCONTAINEDINSPATIALSTRUCTURE);
  for (let i = 0; i < contained.size(); i++) {
    const rel = api.GetLine(modelID, contained.get(i));
    const [structure] = refs(rel.RelatingStructure);
    for (const el of refs(rel.RelatedElements)) owner.set(el, structure);
  }
  const aggregates = api.GetLineIDsWithType(modelID, IFCRELAGGREGATES);
  const parts: Array<[number, number[]]> = [];
  for (let i = 0; i < aggregates.size(); i++) {
    const rel = api.GetLine(modelID, aggregates.get(i));
    parts.push([refs(rel.RelatingObject)[0], refs(rel.RelatedObjects)]);
  }
  // A few passes cover nested aggregation; real files are at most a couple of levels deep.
  for (let pass = 0; pass < 4; pass++) {
    for (const [parent, children] of parts) {
      const storey = owner.get(parent);
      if (storey == null) continue;
      for (const c of children) if (!owner.has(c)) owner.set(c, storey);
    }
  }
  return owner;
}

const area = (b: Bounds) => (b.max.x - b.min.x) * (b.max.z - b.min.z);
const box2 = (b: Bounds): Box2 => [b.min.x, b.min.z, b.max.x, b.max.z];

function readStoreys(modelID: number, slabs: Map<number, Bounds>, stairs: Map<number, Bounds>): StoreyInfo[] {
  const owner = elementStoreys(modelID);
  const ids = api.GetLineIDsWithType(modelID, IFCBUILDINGSTOREY);
  const storeys: StoreyInfo[] = [];
  for (let i = 0; i < ids.size(); i++) {
    const id = ids.get(i);
    const line = api.GetLine(modelID, id);
    const mine = [...slabs].filter(([el]) => owner.get(el) === id).map(([, b]) => b);
    if (!mine.length) continue;
    const largest = mine.reduce((a, b) => (area(b) > area(a) ? b : a));
    storeys.push({
      name: line.LongName?.value || line.Name?.value || `Storey ${i + 1}`,
      elevation: typeof line.Elevation?.value === 'number' ? line.Elevation.value : null,
      floorY: largest.max.y,
      slabBox: box2(largest),
      stairBoxes: [...stairs].filter(([el]) => owner.get(el) === id).map(([, b]) => box2(b)),
    });
  }
  return storeys.sort((a, b) => a.floorY - b.floorY);
}

// --- requests ---------------------------------------------------------------
async function load(url: string, standaloneIds: number[]): Promise<{ result: LoadResult; transfer: Transferable[] }> {
  await ready;
  if (openModel != null) api.CloseModel(openModel);
  openModel = null;

  post({ type: 'progress', message: 'Downloading IFC…' });
  const data = new Uint8Array(await (await fetch(url, { cache: 'no-store' })).arrayBuffer());
  post({ type: 'progress', message: 'Parsing IFC…' });
  const modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });
  openModel = modelID;

  const standalone = new Set(standaloneIds);
  const batches = new Map<string, { color: Rgba; chunks: Chunk[] }>();
  const single: RenderPart[] = [];
  const floorChunks: Chunk[] = [];
  const solidChunks: Chunk[] = [];
  const slabs = new Map<number, Bounds>();
  const stairs = new Map<number, Bounds>();
  const terrain = new Set<number>();

  api.StreamAllMeshes(modelID, (flatMesh) => {
    const expressID = flatMesh.expressID;
    const type = api.GetLineType(modelID, expressID);
    const walk = classify(type, () => api.GetLine(modelID, expressID).PredefinedType?.value);
    const door = isDoor(type);
    if (type === IFCSITE) terrain.add(expressID);
    const placed = flatMesh.geometries;
    for (let i = 0; i < placed.size(); i++) {
      const pg = placed.get(i);
      const geom = api.GetGeometry(modelID, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const indices = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      geom.delete();
      const chunk = bake(verts, indices, Array.from(pg.flatTransformation), expressID);
      const color: Rgba = [pg.color.x, pg.color.y, pg.color.z, pg.color.w];

      if (door || standalone.has(expressID)) {
        single.push({ color, positions: chunk.positions, normals: chunk.normals, indices: chunk.indices, expressID, door });
      } else {
        const key = color.join(',');
        let batch = batches.get(key);
        if (!batch) batches.set(key, (batch = { color, chunks: [] }));
        batch.chunks.push(chunk);
      }

      if (walk === 'floor') floorChunks.push(chunk);
      else if (walk === 'solid') solidChunks.push(chunk);
      if (isSlab(type)) extend(slabs, expressID, chunk.positions);
      if (isStair(type)) extend(stairs, expressID, chunk.positions);
    }
  });

  post({ type: 'progress', message: 'Preparing model…' });
  const transfer = new Set<ArrayBuffer>();
  const render: RenderPart[] = [...batches.values()].map(({ color, chunks }) => ({
    color, ...concat(chunks, true), expressID: null, door: false,
  }));
  render.push(...single);
  for (const part of render) {
    transfer.add(part.positions.buffer as ArrayBuffer);
    transfer.add(part.normals.buffer as ArrayBuffer);
    transfer.add(part.indices.buffer as ArrayBuffer);
  }

  const result: LoadResult = {
    render,
    floor: buildCollision(floorChunks, transfer),
    solid: buildCollision(solidChunks, transfer),
    storeys: readStoreys(modelID, slabs, stairs),
    terrain: [...terrain],
    coordination: Array.from(api.GetCoordinationMatrix(modelID)),
  };
  return { result, transfer: [...transfer] };
}

const text = (v: unknown): string | null => {
  const value = (v as { value?: unknown } | null)?.value;
  return value == null || value === '' ? null : String(value);
};

async function inspect(expressID: number): Promise<ElementInfo | null> {
  if (openModel == null) return null;
  const modelID = openModel;
  const line = await api.properties.getItemProperties(modelID, expressID);
  // web-ifc's type lookups throw on types that have no property sets; fall back to the element's own.
  const materials = await api.properties.getMaterialsProperties(modelID, expressID, true, true)
    .catch(() => api.properties.getMaterialsProperties(modelID, expressID, true, false));
  const psets = await api.properties.getPropertySets(modelID, expressID, true, true)
    .catch(() => api.properties.getPropertySets(modelID, expressID, true, false));

  const materialNames = new Set<string>();
  const visit = (m: unknown) => {
    if (!m || typeof m !== 'object') return;
    const o = m as Record<string, unknown>;
    const direct = text(o.Name);
    if (direct && !o.MaterialLayers && !o.ForLayerSet && !o.Materials) materialNames.add(direct);
    for (const key of ['Material', 'MaterialLayers', 'ForLayerSet', 'Materials', 'MaterialConstituents']) {
      const v = o[key];
      if (Array.isArray(v)) v.forEach(visit);
      else visit(v);
    }
  };
  materials.forEach(visit);

  const properties: Array<[string, string]> = [];
  // Standardised Pset_*Common entries come first: they are what is comparable across authoring tools.
  const ordered = [...psets].sort((a, b) => Number(/^Pset_.*Common$/.test(text(b.Name) ?? '')) - Number(/^Pset_.*Common$/.test(text(a.Name) ?? '')));
  for (const set of ordered) {
    for (const p of (set.HasProperties ?? []) as Array<Record<string, unknown>>) {
      const name = text(p.Name);
      const value = text(p.NominalValue);
      if (name && value && !properties.some(([n]) => n === name)) properties.push([name, value]);
    }
  }

  return {
    expressID,
    ifcClass: api.GetNameFromTypeCode(api.GetLineType(modelID, expressID)),
    name: text(line.Name),
    materials: [...materialNames],
    properties: properties.slice(0, 8),
  };
}

function post(message: WorkerResponse, transfer: Transferable[] = []) {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

// One queue: an inspect must not run while a load is closing the model it reads.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  queue = queue.then(async () => {
    try {
      if (request.type === 'load') {
        const { result, transfer } = await load(request.url, request.standalone);
        post({ type: 'loaded', id: request.id, result }, transfer);
      } else {
        post({ type: 'inspected', id: request.id, info: await inspect(request.expressID) });
      }
    } catch (err) {
      post({ type: 'error', id: request.id, message: err instanceof Error ? err.message : String(err) });
    }
  });
};
