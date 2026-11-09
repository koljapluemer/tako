/// <reference lib="webworker" />
// Parses IFC off the main thread: a stalled frame in a headset is physically unpleasant.
import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { boundsOf, buildNavmesh, initNavmesh, type Bounds as NavBounds, type NavInput } from './nav/navmesh';
import { generatePoints, type NavDoor, type NavLevel, type NavPoint, type NavSpace } from './nav/points';
import { cellKey } from './render-cells';
import {
  IFCBUILDINGSTOREY, IFCSPACE, IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM,
  IFCRELAGGREGATES, IFCRELCONTAINEDINSPATIALSTRUCTURE,
  IFCREAL, IFCRELDEFINESBYPROPERTIES, IFCRELDEFINESBYTYPE, IFCRELFILLSELEMENT, IFCRELVOIDSELEMENT, IFCSIUNIT, IFCSITE, IfcAPI,
} from 'web-ifc';
import { openingsFreedBy, type Filling } from './delete-targets';
import { classify, isDoor, isFurniture, isSlab, isStair } from './ifc-classes';
import {
  commitProject, importProject, listProjects, loadRevision, openProject, saveFocus, saveManifest,
  type HistoryEntry, type ProjectManifest,
} from './project-store';
import { kitHelp, runScript } from './python/client';
import { PROTOCOL_VERSION, type AgentQuery, type CommandResult, type DocumentCommand, type NavBuild, type TextReplacement } from './worker-protocol';
import type {
  Box2, CollisionPart, DocumentSummary, ElementInfo, LoadResult, RenderPart, RevisionInfo, Rgba, StoreyInfo,
  WorkerRequest, WorkerResponse,
} from './worker-protocol';

const api = new IfcAPI();
api.SetWasmPath('/wasm/', true);
const ready = api.Init(undefined, true); // single-threaded: no COOP/COEP headers needed

let openModel: number | null = null;
let manifest: ProjectManifest | null = null;
let history: HistoryEntry[] = [];

type SemanticFact = {
  id: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  storey: string | null;
  min: [number, number, number];
  max: [number, number, number];
  width: number;
  height: number;
  length: number;
  exterior: boolean;
  exteriorSource: 'geometry';
  facing: string | null;
  facingSource: 'geometry' | null;
};

let semanticFacts = new Map<number, SemanticFact>();
/** Why the last open failed; cleared by the next one that succeeds. */
let modelFailure: string | null = null;

/** Thrown without a stack in its message: the agent reads it and should act on it, not debug it. */
class ModelUnavailable extends Error {
  constructor() {
    super(modelFailure ?? 'no project is open');
  }
}

const errorText = (error: unknown) => {
  if (error instanceof ModelUnavailable) return error.message;
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
};

/** The only way to open a model: web-ifc signals failure by returning -1, which must never become `openModel`. */
function openIfc(data: Uint8Array, reason: string): number {
  const closed = openModel;
  if (closed != null) api.CloseModel(closed);
  openModel = null;
  const started = performance.now();
  let modelID = -1;
  let error: string | undefined;
  try {
    modelID = api.OpenModel(data, { COORDINATE_TO_ORIGIN: true });
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  }
  const ok = modelID >= 0;
  post({
    type: 'modelEvent',
    event: {
      at: new Date().toISOString(), reason, ok, ms: Math.round(performance.now() - started), bytes: data.byteLength,
      opened: ok ? modelID : null, closed, heap_bytes: api.wasmModule?.HEAPU8?.length ?? null, error,
    },
  });
  if (!ok) {
    semanticFacts = new Map();
    modelFailure = `The IFC model failed to open in the viewer (${reason}, ${data.byteLength} bytes${error ? `: ${error}` : ''}). `
      + 'Nothing can read or edit it until it opens again. Do not retry; ask the user to reload the page.';
    throw new ModelUnavailable();
  }
  modelFailure = null;
  openModel = modelID;
  return modelID;
}

/** Puts back the model a failed edit started from, without letting a failed restore hide why the edit failed. */
function restoreModel(data: Uint8Array, failure: string) {
  try {
    openIfc(data, 'restore after failed edit');
  } catch (error) {
    throw new Error(`${failure}\n${errorText(error)}`);
  }
}

const document = (): DocumentSummary => {
  if (!manifest) throw new ModelUnavailable();
  return { ...manifest, documentId: `${manifest.id}:${manifest.sourceFingerprint}` };
};

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
type PendingNavigation = NavInput & { doorInfo: NavDoor[]; spaces: NavSpace[]; storeys: StoreyInfo[] };
/** web-ifc's mesh stream leaves spaces out, so they are meshed one by one. Spaces are optional enrichment. */
function readSpaces(modelID: number): NavSpace[] {
  const out: NavSpace[] = [];
  const ids = api.GetLineIDsWithType(modelID, IFCSPACE);
  for (let i = 0; i < ids.size(); i++) {
    const id = ids.get(i);
    try {
      const line = api.GetLine(modelID, id);
      const name = text(line.LongName) ?? text(line.Name);
      if (!name) continue;
      const placed = api.GetFlatMesh(modelID, id).geometries;
      const baked: number[] = [];
      for (let g = 0; g < placed.size(); g++) {
        const geometry = api.GetGeometry(modelID, placed.get(g).geometryExpressID);
        const verts = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
        geometry.delete();
        baked.push(...bake(verts, indices, Array.from(placed.get(g).flatTransformation), id).positions);
      }
      if (baked.length) out.push({ bounds: boundsOf(new Float32Array(baked)), name });
    } catch {
      // A broken space costs its name and nothing else.
    }
  }
  return out;
}

/** A revision the viewer is showing from its cache; parsed only once something needs the IFC itself. */
let deferred: Uint8Array | null = null;

let navInput: PendingNavigation | null = null;
let navToken = 0;
/** Per project, so points from another building never anchor this one. */
let navPrevious: { project: string; points: NavPoint[] } | null = null;
const noNavigation: NavBuild = { mesh: null, points: [], levels: [] as NavLevel[] };

async function navigation(token: number): Promise<{ result: NavBuild; transfer: Transferable[] }> {
  if (token !== navToken || !navInput) return { result: noNavigation, transfer: [] };
  const input = navInput;
  navInput = null;
  await initNavmesh();
  const built = buildNavmesh(input);
  if (!built) return { result: noNavigation, transfer: [] };
  const project = manifest?.id ?? '';
  const { points, levels } = generatePoints({
    components: built.components, doors: input.doorInfo, spaces: input.spaces, storeys: input.storeys,
    previous: navPrevious?.project === project ? navPrevious.points : [],
  });
  navPrevious = { project, points };
  const transfer = new Set<ArrayBuffer>();
  const chunks: Chunk[] = built.components.map(({ positions, indices }, rank) => ({ positions, indices, normals: new Float32Array(0), expressID: rank }));
  return { result: { mesh: buildCollision(chunks, transfer), points, levels }, transfer: [...transfer] };
}

async function openData(data: Uint8Array, standaloneIds: number[]): Promise<{ result: LoadResult; transfer: Transferable[] }> {
  await ready;
  deferred = null;

  post({ type: 'progress', message: 'Parsing IFC…' });
  const modelID = openIfc(data, 'load');

  const standalone = new Set(standaloneIds);
  const batches = new Map<string, { color: Rgba; chunks: Chunk[] }>();
  const doorBatches = new Map<string, { color: Rgba; cell: string; chunks: Chunk[] }>();
  const single: RenderPart[] = [];
  const floorChunks: Chunk[] = [];
  const solidChunks: Chunk[] = [];
  const slabs = new Map<number, Bounds>();
  const stairs = new Map<number, Bounds>();
  const terrain = new Set<number>();
  const allBounds = new Map<number, Bounds>();
  const doorBounds: NavBounds[] = [];
  const doorIds = new Set<number>();
  const furnitureBounds: NavBounds[] = [];

  api.StreamAllMeshes(modelID, (flatMesh) => {
    const expressID = flatMesh.expressID;
    const type = api.GetLineType(modelID, expressID);
    const walk = classify(type, () => api.GetLine(modelID, expressID).PredefinedType?.value);
    const door = isDoor(type);
    const furniture = isFurniture(type);
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

      const cell = cellKey(chunk.positions);
      if (door) {
        doorBounds.push(boundsOf(chunk.positions));
        doorIds.add(expressID);
      }
      if (furniture) furnitureBounds.push(boundsOf(chunk.positions));
      if (door || standalone.has(expressID)) {
        single.push({ color, positions: chunk.positions, normals: chunk.normals, indices: chunk.indices, expressID, door, doorCell: door ? cell : null });
        if (door) {
          const key = `${color.join(',')}|${cell}`;
          let batch = doorBatches.get(key);
          if (!batch) doorBatches.set(key, (batch = { color, cell, chunks: [] }));
          batch.chunks.push(chunk);
        }
      } else {
        const key = `${color.join(',')}|${cell}`;
        let batch = batches.get(key);
        if (!batch) batches.set(key, (batch = { color, chunks: [] }));
        batch.chunks.push(chunk);
      }

      if (walk === 'floor') floorChunks.push(chunk);
      else if (walk === 'solid') solidChunks.push(chunk);
      if (isSlab(type)) extend(slabs, expressID, chunk.positions);
      if (isStair(type)) extend(stairs, expressID, chunk.positions);
      extend(allBounds, expressID, chunk.positions);
    }
  });

  const owners = elementStoreys(modelID);
  const storeyNames = new Map<number, string>();
  const storeyIds = api.GetLineIDsWithType(modelID, IFCBUILDINGSTOREY);
  for (let i = 0; i < storeyIds.size(); i++) {
    const id = storeyIds.get(i);
    const line = api.GetLine(modelID, id);
    storeyNames.set(id, text(line.LongName) ?? text(line.Name) ?? `#${id}`);
  }
  const envelopeBounds = [...allBounds].filter(([id]) => {
    const name = api.GetNameFromTypeCode(api.GetLineType(modelID, id));
    return /^(IfcWall|IfcSlab|IfcRoof|IfcCurtainWall)/.test(name);
  }).map(([, bounds]) => bounds);
  const envelope = envelopeBounds.reduce<Bounds | null>((out, b) => {
    if (!out) return { min: b.min.clone(), max: b.max.clone() };
    out.min.min(b.min); out.max.max(b.max); return out;
  }, null);
  const geometryUnit = metresPerModelUnit();
  semanticFacts = new Map([...allBounds].map(([id, b]) => {
    const line = api.GetLine(modelID, id);
    const dx = b.max.x - b.min.x;
    const dy = b.max.y - b.min.y;
    const dz = b.max.z - b.min.z;
    const distances = envelope ? [
      ['west', Math.abs(b.min.x - envelope.min.x)], ['east', Math.abs(envelope.max.x - b.max.x)],
      ['south', Math.abs(b.min.z - envelope.min.z)], ['north', Math.abs(envelope.max.z - b.max.z)],
    ] as Array<[string, number]> : [];
    distances.sort((a, c) => a[1] - c[1]);
    const tolerance = Math.max(0.25, Math.min(envelope ? envelope.max.x - envelope.min.x : 0, envelope ? envelope.max.z - envelope.min.z : 0) * 0.01);
    const exterior = Boolean(distances.length && distances[0][1] <= tolerance);
    const fact: SemanticFact = {
      id, globalId: text(line.GlobalId), ifcClass: api.GetNameFromTypeCode(api.GetLineType(modelID, id)), name: text(line.Name),
      storey: storeyNames.get(owners.get(id) ?? -1) ?? null,
      min: [b.min.x * geometryUnit, b.min.y * geometryUnit, b.min.z * geometryUnit],
      max: [b.max.x * geometryUnit, b.max.y * geometryUnit, b.max.z * geometryUnit],
      width: Number(line.OverallWidth?.value ?? Math.min(dx, dz)) * geometryUnit,
      height: Number(line.OverallHeight?.value ?? dy) * geometryUnit,
      length: Math.max(dx, dz) * geometryUnit, exterior,
      exteriorSource: 'geometry', facing: exterior ? distances[0][0] : null, facingSource: exterior ? 'geometry' : null,
    };
    return [id, fact];
  }));

  post({ type: 'progress', message: 'Preparing model…' });
  const transfer = new Set<ArrayBuffer>();
  const render: RenderPart[] = [...batches.values()].map(({ color, chunks }) => ({
    color, ...concat(chunks, true), expressID: null, door: false, doorCell: null,
  }));
  render.push(...single);
  for (const { color, cell, chunks } of doorBatches.values()) {
    render.push({ color, ...concat(chunks, true), expressID: null, door: false, doorCell: cell });
  }
  for (const part of render) {
    transfer.add(part.positions.buffer as ArrayBuffer);
    transfer.add(part.normals.buffer as ArrayBuffer);
    transfer.add(part.indices.buffer as ArrayBuffer);
  }

  // A copy: some of these chunks' buffers are transferred to the main thread with the result.
  const { positions: navPositions, indices: navIndices } = concat([...floorChunks, ...solidChunks], false);
  const storeys = readStoreys(modelID, slabs, stairs);
  navInput = {
    positions: navPositions, indices: navIndices, doors: doorBounds, furniture: furnitureBounds, storeys,
    spaces: readSpaces(modelID),
    doorInfo: [...doorIds].map((id) => {
      const fact = semanticFacts.get(id);
      const { min, max } = allBounds.get(id)!;
      return { bounds: { min: [min.x, min.y, min.z], max: [max.x, max.y, max.z] }, globalId: fact?.globalId ?? null, exterior: fact?.exterior ?? false };
    }),
  };
  navToken += 1;

  const result: LoadResult = {
    render,
    floor: buildCollision(floorChunks, transfer),
    solid: buildCollision(solidChunks, transfer),
    storeys,
    terrain: [...terrain],
    coordination: Array.from(api.GetCoordinationMatrix(modelID)),
    navToken,
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
    globalId: text(line.GlobalId),
    ifcClass: api.GetNameFromTypeCode(api.GetLineType(modelID, expressID)),
    name: text(line.Name),
    materials: [...materialNames],
    properties: properties.slice(0, 8),
  };
}

const factDescription = (fact: SemanticFact) => ({
  id: `#${fact.id}`, global_id: fact.globalId, class: fact.ifcClass, name: fact.name, storey: fact.storey,
  width_m: Number(fact.width.toFixed(3)), height_m: Number(fact.height.toFixed(3)), length_m: Number(fact.length.toFixed(3)),
  bbox_m: { min: fact.min.map((n) => Number(n.toFixed(3))), max: fact.max.map((n) => Number(n.toFixed(3))) },
  exterior: fact.exterior, exterior_source: fact.exteriorSource, facing: fact.facing, facing_source: fact.facingSource,
});

function resolveFact(reference: string): SemanticFact {
  const numeric = Number(reference.replace(/^#/, ''));
  if (Number.isInteger(numeric) && semanticFacts.has(numeric)) return semanticFacts.get(numeric)!;
  const byGuid = [...semanticFacts.values()].find((f) => f.globalId === reference);
  if (byGuid) return byGuid;
  const byName = [...semanticFacts.values()].filter((f) => f.name?.toLowerCase().includes(reference.toLowerCase()));
  if (byName.length === 1) return byName[0];
  throw new Error(byName.length ? `${reference} is ambiguous (${byName.length} elements)` : `no element ${reference}`);
}

const boxGap = (a: SemanticFact, b: SemanticFact) => Math.hypot(...([0, 1, 2].map((i) =>
  Math.max(a.min[i] - b.max[i], b.min[i] - a.max[i], 0))));

const reportProgress = (message: string) => post({ type: 'progress', message });

/** The model state a cached spatial index belongs to. Revision numbers are reused after undo, command ids are not. */
function indexKey(): string {
  const current = requireDocument();
  return `${current.id}:${history[current.cursor - 1]?.commandId ?? 'source'}`;
}

function relationLines(model: number, type: number) {
  const ids = api.GetLineIDsWithType(model, type);
  return Array.from({ length: ids.size() }, (_, i) => api.GetLine(model, ids.get(i)));
}

function readFillings(model: number): Filling[] {
  return relationLines(model, IFCRELFILLSELEMENT).map((rel) => ({
    opening: rel.RelatingOpeningElement.value as number, filling: rel.RelatedBuildingElement.value as number,
  }));
}

/** How an element connects to its opening, host and type, so "this window" doesn't need a script to resolve. */
function elementRelations(id: number) {
  if (openModel == null) return {};
  const model = openModel;
  const describe = (entity: number) => ({
    id: `#${entity}`, class: api.GetNameFromTypeCode(api.GetLineType(model, entity)), name: text(api.GetLine(model, entity).Name),
  });
  const opening = readFillings(model).find((rel) => rel.filling === id)?.opening;
  const voids = relationLines(model, IFCRELVOIDSELEMENT);
  const host = voids.find((rel) => rel.RelatedOpeningElement.value === opening)?.RelatingBuildingElement.value as number | undefined;
  const openings = voids.filter((rel) => rel.RelatingBuildingElement.value === id).map((rel) => describe(rel.RelatedOpeningElement.value as number));
  const type = relationLines(model, IFCRELDEFINESBYTYPE)
    .find((rel) => (rel.RelatedObjects as Array<{ value: number }>).some((related) => related.value === id))?.RelatingType.value as number | undefined;
  return {
    ...(opening != null && { opening: describe(opening) }),
    ...(host != null && { host: describe(host) }),
    ...(openings.length > 0 && { openings }),
    ...(type != null && { type: describe(type) }),
  };
}

async function queryAgent(query: AgentQuery): Promise<unknown> {
  if (query.method === 'kit_help') return kitHelp(query.params.topic, reportProgress);
  const current = requireDocument();
  if (openModel == null) throw new ModelUnavailable();
  if (query.method === 'inspect_with_script') {
    const { output, timing } = await runScript(api.SaveModel(openModel!), query.params.code, query.params.values, false, indexKey(), reportProgress);
    return { ok: true, output, committed: false, timing };
  }
  if (query.method === 'model_overview') {
    const counts: Record<string, number> = {};
    for (const fact of semanticFacts.values()) counts[fact.ifcClass] = (counts[fact.ifcClass] ?? 0) + 1;
    return {
      project: current.name, schema: current.schema, revision: current.revision,
      note_units: 'all lengths are metres', element_counts: counts,
      history: history.slice(0, current.cursor).slice(-10).map((h) => h.summary),
      exterior_note: 'exterior and facing currently use tessellated envelope geometry and report that provenance',
    };
  }
  if (query.method === 'find_elements') {
    const p = query.params;
    let rows = [...semanticFacts.values()].filter((fact) =>
      (!p.ifc_class || fact.ifcClass.toLowerCase().startsWith(p.ifc_class.toLowerCase()))
      && (!p.storey || fact.storey?.toLowerCase().includes(p.storey.toLowerCase()))
      && (p.exterior == null || fact.exterior === p.exterior)
      && (!p.facing || fact.facing === p.facing.toLowerCase())
      && (!p.text || `${fact.name ?? ''} ${fact.ifcClass}`.toLowerCase().includes(p.text.toLowerCase())));
    const key = p.sort_by;
    if (key === 'width' || key === 'height' || key === 'length') rows.sort((a, b) => b[key] - a[key]);
    else if (key && ['north', 'south', 'east', 'west'].includes(key)) {
      const axis = key === 'north' || key === 'south' ? 2 : 0;
      const direction = key === 'north' || key === 'east' ? -1 : 1;
      rows.sort((a, b) => direction * ((b.min[axis] + b.max[axis]) - (a.min[axis] + a.max[axis])));
    }
    return rows.slice(0, Math.max(1, Math.min(p.limit ?? 20, 100))).map(factDescription);
  }
  if (query.method === 'get_element') {
    const fact = resolveFact(query.params.element);
    return { ...factDescription(fact), relations: elementRelations(fact.id), inspection: await inspect(fact.id) };
  }
  if (query.method === 'context_around') {
    const target = resolveFact(query.params.target);
    const radius = query.params.radius ?? 3;
    const all = [...semanticFacts.values()].filter((f) => f.id !== target.id)
      .map((fact) => ({ fact, distance: boxGap(target, fact) }))
      .filter((row) => row.distance <= radius).sort((a, b) => a.distance - b.distance);
    const limit = Math.max(1, Math.min(query.params.limit ?? 40, 100));
    return {
      target: factDescription(target), nearby: all.slice(0, limit).map(({ fact, distance }) => ({ ...factDescription(fact), distance_m: Number(distance.toFixed(3)) })),
      omitted: Math.max(0, all.length - limit),
    };
  }
  if (query.method === 'get_focus') {
    return {
      selection: current.focus != null && semanticFacts.has(current.focus)
        ? { ...factDescription(semanticFacts.get(current.focus)!), relations: elementRelations(current.focus) }
        : null,
      latest_edit: history[current.cursor - 1] ?? null,
    };
  }
  const materials = new Map<string, number>();
  for (const fact of semanticFacts.values()) {
    const inspected = await inspect(fact.id).catch(() => null);
    for (const name of inspected?.materials ?? []) materials.set(name, (materials.get(name) ?? 0) + 1);
  }
  return [...materials].map(([name, usage_count]) => ({ name, usage_count })).sort((a, b) => b.usage_count - a.usage_count);
}

function requireDocument(documentId?: string, baseRevision?: number): ProjectManifest {
  const current = document();
  if (documentId != null && current.documentId !== documentId) throw new Error('the active document changed');
  if (baseRevision != null && current.revision !== baseRevision) throw new Error(`stale revision ${baseRevision}; current is ${current.revision}`);
  return manifest!;
}

function targetId(target: { expressID?: number; globalId?: string }): number {
  if (openModel == null) throw new ModelUnavailable();
  if (target.expressID != null) return target.expressID;
  if (!target.globalId) throw new Error('a target needs expressID or globalId');
  const ids = api.GetAllLines(openModel);
  for (let i = 0; i < ids.size(); i++) {
    const id = ids.get(i);
    if (text(api.GetLine(openModel, id).GlobalId) === target.globalId) return id;
  }
  throw new Error(`no element with GlobalId ${target.globalId}`);
}

const isRef = (value: unknown, ids: ReadonlySet<number>): boolean => {
  if (Array.isArray(value)) return value.some((v) => isRef(v, ids));
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  if (object.type === 5 && ids.has(object.value as number)) return true;
  return Object.values(object).some((v) => isRef(v, ids));
};

function removeRef(value: unknown, ids: ReadonlySet<number>): unknown {
  if (Array.isArray(value)) return value.filter((v) => !isRef(v, ids)).map((v) => removeRef(v, ids));
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(object)) {
    if (isRef(child, ids)) object[key] = removeRef(child, ids);
  }
  return object;
}

function metresPerModelUnit(): number {
  if (openModel == null) throw new ModelUnavailable();
  const prefix: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6, NANO: 1e-9 };
  const units = api.GetLineIDsWithType(openModel, IFCSIUNIT);
  for (let i = 0; i < units.size(); i++) {
    const unit = api.GetLine(openModel, units.get(i));
    if (unit.UnitType?.value === 'LENGTHUNIT') return prefix[unit.Prefix?.value] ?? 1;
  }
  return 1;
}

type Applied = { changed: number[]; summary: string; bytes?: Uint8Array; warnings?: string[]; output?: string; timing?: Record<string, number> };

async function applyScript(command: Extract<DocumentCommand, { kind: 'script' }>, model: Uint8Array): Promise<Applied> {
  const { code, summary, values } = command.params;
  const result = await runScript(model, code, values, true, indexKey(), reportProgress);
  return { summary, changed: result.changed, bytes: result.bytes, warnings: result.verify.problems, output: result.output, timing: result.timing };
}

function applyCommand(command: Exclude<DocumentCommand, { kind: 'script' }>): Applied {
  if (openModel == null) throw new ModelUnavailable();
  const ids = [...new Set(command.targets.map(targetId))];
  if (!ids.length) throw new Error('the command has no targets');

  if (command.kind === 'deleteElements') {
    if (!command.params.confirmationToken) throw new Error('deletion requires a confirmation token');
    const targets = new Set(ids);
    const openings = openingsFreedBy(readFillings(openModel), targets).filter((opening) => !targets.has(opening));
    openings.forEach((opening) => targets.add(opening));
    const all = api.GetAllLines(openModel);
    for (let i = 0; i < all.size(); i++) {
      const other = all.get(i);
      if (targets.has(other)) continue;
      const line = api.GetLine(openModel, other);
      if (!isRef(line, targets)) continue;
      const name = api.GetNameFromTypeCode(api.GetLineType(openModel, other));
      if (name.startsWith('IfcRel')) {
        const entries = Object.entries(line as Record<string, unknown>);
        const scalarReference = entries.some(([, value]) => !Array.isArray(value) && isRef(value, targets));
        if (scalarReference) {
          api.DeleteLine(openModel, other);
        } else {
          let hasRelatedObjects = false;
          for (const [key, value] of entries) {
            if (!Array.isArray(value) || !isRef(value, targets)) continue;
            line[key] = value.filter((candidate) => !isRef(candidate, targets));
            hasRelatedObjects ||= line[key].length > 0;
          }
          if (hasRelatedObjects) api.WriteLine(openModel, line);
          else api.DeleteLine(openModel, other);
        }
      } else {
        api.WriteLine(openModel, removeRef(line, targets) as never);
      }
    }
    targets.forEach((id) => api.DeleteLine(openModel!, id));
    const withOpenings = openings.length ? ` and ${openings.length} opening(s)` : '';
    return { changed: [...targets], summary: `deleted ${ids.length} element(s)${withOpenings}` };
  }

  if (command.kind === 'setProperty') {
    for (const id of ids) {
      const relations = api.GetLineIDsWithType(openModel, IFCRELDEFINESBYPROPERTIES);
      let property: Record<string, unknown> | null = null;
      for (let i = 0; i < relations.size() && !property; i++) {
        const relation = api.GetLine(openModel, relations.get(i));
        if (!refs(relation.RelatedObjects).includes(id)) continue;
        const [psetId] = refs(relation.RelatingPropertyDefinition);
        if (psetId == null) continue;
        const pset = api.GetLine(openModel, psetId);
        if (text(pset.Name)?.toLowerCase() !== command.params.pset.toLowerCase()) continue;
        for (const propertyId of refs(pset.HasProperties)) {
          const candidate = api.GetLine(openModel, propertyId);
          if (text(candidate.Name)?.toLowerCase() === command.params.name.toLowerCase()) property = candidate;
        }
      }
      if (!property) throw new Error(`#${id} has no existing ${command.params.pset}.${command.params.name}; creating new property sets is not supported yet`);
      const nominal = property.NominalValue as { value?: unknown } | null;
      if (!nominal || !('value' in nominal)) throw new Error(`${command.params.pset}.${command.params.name} is not a single value`);
      nominal.value = command.params.value;
      api.WriteLine(openModel, property as never);
    }
    return { changed: ids, summary: `set ${command.params.pset}.${command.params.name} on ${ids.length} element(s)` };
  }

  if (command.kind === 'resizeFilling') {
    for (const id of ids) {
      let resizeStep = 'read element';
      try {
      const element = api.GetLine(openModel, id);
      const kind = api.GetNameFromTypeCode(api.GetLineType(openModel, id));
      if (kind !== 'IfcDoor' && kind !== 'IfcWindow') throw new Error(`#${id} is ${kind}, expected IfcDoor or IfcWindow`);
      const oldWidth = Number(element.OverallWidth?.value);
      const oldHeight = Number(element.OverallHeight?.value);
      resizeStep = 'read units';
      const unit = metresPerModelUnit();
      const width = command.params.width == null ? oldWidth : command.params.width / unit;
      const height = command.params.height == null ? oldHeight : command.params.height / unit;
      if (!(width > 0 && height > 0 && oldWidth > 0 && oldHeight > 0)) throw new Error(`#${id} has no usable overall dimensions`);

      resizeStep = 'read product shape';
      const [shapeId] = refs(element.Representation);
      if (shapeId == null) throw new Error(`#${id} has no product representation`);
      const shape = api.GetLine(openModel, shapeId);
      let bodyChanged = false;
      for (const representationId of refs(shape.Representations)) {
        const representation = api.GetLine(openModel, representationId);
        if (text(representation.RepresentationIdentifier)?.toLowerCase() !== 'body') continue;
        for (const itemId of refs(representation.Items)) {
          const item = api.GetLine(openModel, itemId);
          const [targetId] = refs(item.MappingTarget);
          if (targetId == null) continue;
          const target = api.GetLine(openModel, targetId);
          const sx = Number(target.Scale?.value ?? target.Scale ?? 1) * width / oldWidth;
          const sy = Number(target.Scale2?.value ?? target.Scale2 ?? 1);
          const sz = Number(target.Scale3?.value ?? target.Scale3 ?? target.Scale?.value ?? target.Scale ?? 1) * height / oldHeight;
          resizeStep = 'create scale operator';
          const replacement = api.CreateIfcEntity(
            openModel, IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM,
            target.Axis1 ?? null, target.Axis2 ?? null, target.LocalOrigin,
            api.CreateIfcType(openModel, IFCREAL, sx), target.Axis3 ?? null,
            api.CreateIfcType(openModel, IFCREAL, sy), api.CreateIfcType(openModel, IFCREAL, sz),
          );
          item.MappingTarget = replacement;
          resizeStep = 'write mapped item';
          api.WriteLine(openModel, item);
          bodyChanged = true;
        }
      }
      if (!bodyChanged) throw new Error(`#${id} has no mapped body representation; this resize is unsupported and nothing was applied`);

      element.OverallWidth.value = width;
      element.OverallHeight.value = height;
      resizeStep = 'write element dimensions';
      api.WriteLine(openModel, element);

      resizeStep = 'find opening';
      const fills = api.GetLineIDsWithType(openModel, IFCRELFILLSELEMENT);
      let openingId: number | null = null;
      for (let i = 0; i < fills.size(); i++) {
        const relation = api.GetLine(openModel, fills.get(i));
        if (refs(relation.RelatedBuildingElement).includes(id)) openingId = refs(relation.RelatingOpeningElement)[0] ?? null;
      }
      if (openingId == null) throw new Error(`#${id} fills no opening`);
      const opening = api.GetLine(openModel, openingId);
      const [openingShapeId] = refs(opening.Representation);
      if (openingShapeId == null) throw new Error(`opening #${openingId} has no representation`);
      const openingShape = api.GetLine(openModel, openingShapeId);
      for (const representationId of refs(openingShape.Representations)) {
        const representation = api.GetLine(openModel, representationId);
        for (const itemId of refs(representation.Items)) {
          const item = api.GetLine(openModel, itemId);
          const [profileId] = refs(item.SweptArea);
          if (profileId != null) {
            const profile = api.GetLine(openModel, profileId);
            if (profile.XDim?.value != null && profile.YDim?.value != null) {
              profile.XDim.value = width;
              profile.YDim.value = height;
              resizeStep = 'write opening profile';
              api.WriteLine(openModel, profile);
            }
          }
          // Bounding-box representations are advisory and vary across schemas;
          // the swept opening body above is the authoritative void geometry.
        }
      }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${resizeStep}: ${message}`);
      }
    }
    return { changed: ids, summary: `resized ${ids.length} door/window element(s)` };
  }

  if (command.kind === 'moveElements') {
    const metresPerUnit = metresPerModelUnit();
    const delta = [command.params.x, command.params.y, command.params.z].map((n) => n / metresPerUnit);
    const changed: number[] = [];
    for (const id of ids) {
      const original = api.GetLine(openModel, id);
      const [placementId] = refs(original.ObjectPlacement);
      if (placementId == null) throw new Error(`#${id} has no object placement`);
      const placement = api.GetLine(openModel, placementId);
      const [relativeId] = refs(placement.RelativePlacement);
      const relative = api.GetLine(openModel, relativeId);
      const [locationId] = refs(relative.Location);
      const location = api.GetLine(openModel, locationId);
      const all = api.GetAllLines(openModel);
      let placementUsers = 0;
      for (let i = 0; i < all.size(); i++) {
        const line = api.GetLine(openModel, all.get(i));
        if (refs(line.ObjectPlacement).includes(placementId)) placementUsers++;
      }
      if (placementUsers !== 1) throw new Error(`#${id} shares its object placement with ${placementUsers} products; safe move is unsupported`);
      (location.Coordinates as Array<{ value: number }>).forEach((value, i) => { value.value += delta[i] ?? 0; });
      api.WriteLine(openModel, location);
      changed.push(id);
    }
    return { changed, summary: `moved ${ids.length} element(s)` };
  }

  for (const id of ids) {
    const line = api.GetLine(openModel, id);
    const attribute = command.kind === 'setName' ? 'Name' : command.params.attribute;
    const value = command.kind === 'setName' ? command.params.name : command.params.value;
    if (!(attribute in line)) throw new Error(`#${id} has no ${attribute} attribute`);
    const current = line[attribute];
    if (current && typeof current === 'object' && 'value' in current) current.value = value;
    else line[attribute] = value;
    api.WriteLine(openModel, line);
  }
  return {
    changed: ids,
    summary: command.kind === 'setName'
      ? `renamed ${ids.length} element(s) to ${command.params.name}`
      : `set ${command.params.attribute} on ${ids.length} element(s)`,
  };
}

function classCounts(model: number): Map<string, number> {
  const byType = new Map<number, number>();
  const all = api.GetAllLines(model);
  for (let i = 0; i < all.size(); i++) {
    const type = api.GetLineType(model, all.get(i));
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  return new Map([...byType].map(([type, count]) => [api.GetNameFromTypeCode(type), count]));
}

function classDelta(before: Map<string, number>, after: Map<string, number>): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const change = (after.get(name) ?? 0) - (before.get(name) ?? 0);
    if (change) delta[name] = change;
  }
  return delta;
}

async function execute(command: DocumentCommand, standalone: number[] = [], title?: string) {
  const current = requireDocument();
  if (openModel == null) throw new ModelUnavailable();
  const timing: Record<string, number> = {};
  let lapStarted = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timing[name] = Math.round(now - lapStarted);
    lapStarted = now;
  };
  const countsBefore = classCounts(openModel);
  const before = api.SaveModel(openModel);
  lap('snapshot_ms');
  let phase = 'apply command';
  try {
    const applied = command.kind === 'script' ? await applyScript(command, before) : applyCommand(command);
    lap('apply_ms');
    phase = 'serialize candidate';
    const saved = applied.bytes ?? api.SaveModel(openModel);
    lap('serialize_ms');
    // Saving is not sufficient: reopen the candidate before making it durable.
    phase = 'reopen candidate';
    const class_delta = classDelta(countsBefore, classCounts(openIfc(saved, 'reopen edited model')));
    lap('reopen_ms');
    current.revision += 1;
    current.cursor = current.revision;
    current.updatedAt = new Date().toISOString();
    const commandId = crypto.randomUUID();
    history = history.slice(0, current.cursor - 1);
    history.push({ commandId, revision: current.revision, summary: applied.summary, title, createdAt: current.updatedAt, changed: applied.changed, command });
    phase = 'persist candidate';
    await commitProject(current, history, saved);
    lap('persist_ms');
    phase = 'rebuild geometry';
    const rendered = await render(standalone.length ? standalone : applied.changed);
    lap('render_ms');
    const result: CommandResult = {
      ok: true, commandId, revision: current.revision, summary: applied.summary, changed: applied.changed,
      warnings: applied.warnings ?? [], output: applied.output, timing: { ...timing, ...applied.timing }, class_delta,
    };
    return { rendered, command: result };
  } catch (error) {
    const failure = `${phase}: ${errorText(error)}`;
    restoreModel(before, failure);
    throw new Error(failure);
  }
}

function revisedCommand(command: DocumentCommand, values: Record<string, unknown>, replacements: TextReplacement[]): DocumentCommand {
  if (command.kind !== 'script') {
    if (replacements.length) throw new Error('replacements only apply to script edits; pass params');
    return { ...command, params: { ...command.params, ...values } } as DocumentCommand;
  }
  let code = command.params.code;
  for (const { old, new: text } of replacements) {
    const count = code.split(old).length - 1;
    if (count !== 1) throw new Error(`text occurs ${count} times, expected once: ${old.slice(0, 80)}`);
    code = code.replace(old, () => text);
  }
  return { ...command, params: { ...command.params, code, values: { ...command.params.values, ...values } } };
}

/** Reruns the latest edit on the revision before it, replacing it so it stays one undo step. */
async function revise(editId: string, values: Record<string, unknown>, replacements: TextReplacement[]) {
  const current = requireDocument();
  const last = history[current.cursor - 1];
  if (!last || last.commandId !== editId) {
    throw new Error(`only the latest edit can be revised (latest: ${last?.commandId ?? 'none'}). Undo back to it, or make a new edit.`);
  }
  if (openModel == null) throw new ModelUnavailable();
  const command = revisedCommand(last.command as DocumentCommand, values, replacements);
  const parent = current.cursor - 1;
  const latest = api.SaveModel(openModel);
  const parentData = await loadRevision(current.id, parent);
  openIfc(parentData, 'open parent revision to revise');
  current.revision = parent;
  current.cursor = parent;
  try {
    return await execute(command, [], last.title);
  } catch (error) {
    current.revision = parent + 1;
    current.cursor = parent + 1;
    restoreModel(latest, errorText(error));
    throw error;
  }
}

async function render(standalone: number[]) {
  if (openModel == null) throw new ModelUnavailable();
  return openData(api.SaveModel(openModel), standalone);
}

function revisions(): RevisionInfo[] {
  const current = requireDocument();
  return [
    { revision: 0, title: 'Original', createdAt: null, current: current.cursor === 0 },
    ...history.map((entry, i) => ({
      revision: i + 1, title: entry.title ?? entry.summary, createdAt: entry.createdAt, current: current.cursor === i + 1,
    })),
  ];
}

async function moveToRevision(current: ProjectManifest, target: number, parse: boolean) {
  const data = await loadRevision(current.id, target);
  current.revision = target;
  current.cursor = target;
  current.updatedAt = new Date().toISOString();
  const opened = parse ? await openData(data, []) : null;
  await saveManifest(current);
  return { data, opened };
}

async function ensureOpen() {
  if (deferred) await openData(deferred, []);
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
      if (request.protocolVersion !== PROTOCOL_VERSION) throw new Error(`unsupported protocol ${request.protocolVersion}`);
      if (request.type === 'cancel') return;
      if (request.type === 'listProjects') {
        post({ type: 'projects', id: request.id, projects: await listProjects() });
      } else if (request.type === 'importProject') {
        const data = new Uint8Array(request.data);
        const opened = await openData(data, []);
        const schema = api.GetModelSchema(openModel!);
        manifest = await importProject(request.name, data, schema);
        history = [];
        post({ type: 'opened', id: request.id, document: document(), result: opened.result }, opened.transfer);
      } else if (request.type === 'openProject') {
        const project = await openProject(request.projectId);
        manifest = project.manifest;
        history = project.history;
        const opened = await openData(project.data, request.standalone);
        post({ type: 'opened', id: request.id, document: document(), result: opened.result }, opened.transfer);
      } else if (request.type === 'render') {
        await ensureOpen();
        const rendered = await render(request.standalone);
        post({ type: 'rendered', id: request.id, document: document(), result: rendered.result }, rendered.transfer);
      } else if (request.type === 'navigation') {
        const { result, transfer } = await navigation(request.token).catch((error) => {
          console.warn('navmesh generation failed', error);
          return { result: noNavigation, transfer: [] };
        });
        post({ type: 'navigated', id: request.id, result }, transfer);
      } else if (request.type === 'inspect') {
        await ensureOpen();
        post({ type: 'inspected', id: request.id, info: await inspect(request.expressID) });
      } else if (request.type === 'query') {
        await ensureOpen();
        post({ type: 'queried', id: request.id, result: await queryAgent(request.query) });
      } else if (request.type === 'select') {
        await saveFocus(requireDocument(), request.expressID);
        post({ type: 'selected', id: request.id });
      } else if (request.type === 'exportProject') {
        const current = requireDocument();
        const data = await loadRevision(current.id, current.cursor);
        post({ type: 'exported', id: request.id, name: current.name, data: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer]);
      } else if (request.type === 'execute') {
        requireDocument(request.documentId, request.baseRevision);
        await ensureOpen();
        const executed = await execute(request.command, [], request.title);
        post({
          type: 'executed', id: request.id, document: document(), command: executed.command, result: executed.rendered.result,
        }, executed.rendered.transfer);
      } else if (request.type === 'revise') {
        requireDocument(request.documentId, request.baseRevision);
        await ensureOpen();
        const revised = await revise(request.editId, request.values, request.replacements);
        post({
          type: 'executed', id: request.id, document: document(), command: revised.command, result: revised.rendered.result,
        }, revised.rendered.transfer);
      } else if (request.type === 'listRevisions') {
        post({ type: 'revisions', id: request.id, revisions: revisions() });
      } else if (request.type === 'jumpRevision') {
        const current = requireDocument(request.documentId, request.baseRevision);
        if (request.target < 0 || request.target > history.length) throw new Error(`no revision ${request.target}`);
        const { data, opened } = await moveToRevision(current, request.target, !request.reuse);
        if (!opened) deferred = data;
        post({ type: 'jumped', id: request.id, document: document(), result: opened?.result ?? null }, opened?.transfer ?? []);
      } else if (request.type === 'undo' || request.type === 'redo') {
        const current = requireDocument(request.documentId, request.baseRevision);
        const next = request.type === 'undo' ? current.revision - 1 : current.revision + 1;
        if (next < 0 || next > history.length) throw new Error(`nothing to ${request.type}`);
        const { opened } = await moveToRevision(current, next, true) as { opened: Awaited<ReturnType<typeof openData>> };
        const entry = request.type === 'undo' ? history[next] : history[next - 1];
        post({
          type: 'executed', id: request.id, document: document(),
          command: {
            ok: true, commandId: entry?.commandId ?? crypto.randomUUID(), revision: next,
            summary: `${request.type}: ${entry?.summary ?? 'revision'}`, changed: entry?.changed ?? [], warnings: [],
          },
          result: opened.result,
        }, opened.transfer);
      }
    } catch (err) {
      post({ type: 'error', id: request.id, code: 'DOCUMENT_ERROR', message: errorText(err) });
    }
  });
};
