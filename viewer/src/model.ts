import * as THREE from 'three';
import { Collision, NavMesh } from './collision';
import type { NavLevel, NavPoint } from './nav/points';
import {
  PROTOCOL_VERSION,
  type AgentQuery, type DocumentCommand, type DocumentSummary, type LoadResult, type ProjectSummary,
  type StoreyInfo, type WorkerRequest, type WorkerResponse,
} from './worker-protocol';

export type DoorInfo = { mesh: THREE.Mesh; box: THREE.Box3; material: THREE.MeshLambertMaterial; baseOpacity: number };

/** One cell's doors: far away the merged meshes draw them in one call; up close the individual ones can fade. */
export type DoorCell = { merged: THREE.Mesh[]; doors: DoorInfo[]; box: THREE.Box3; near: boolean | null };

export type LoadedModel = {
  group: THREE.Group;
  collision: Collision;
  /** Arrives after the model is live, and stays null if nothing walkable could be derived. */
  nav: NavMesh | null;
  navToken: number;
  points: NavPoint[];
  levels: NavLevel[];
  doors: DoorInfo[];
  doorCells: DoorCell[];
  storeys: StoreyInfo[];
  terrain: Set<number>;
  coordination: number[];
};

const worker = new Worker(new URL('./ifc-worker.ts', import.meta.url), { type: 'module' });

type Reply = Exclude<WorkerResponse, { type: 'progress' }>;
type Pending = { resolve: (value: Reply) => void; reject: (err: Error) => void };
const pending = new Map<number, Pending>();
let nextId = 1;
let onProgress: (message: string) => void = () => {};
let workerDocument: DocumentSummary | null = null;

export const currentDocument = () => workerDocument;

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const msg = event.data;
  if (msg.type === 'progress') return onProgress(msg.message);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'error') p.reject(Object.assign(new Error(msg.message), { code: msg.code }));
  else p.resolve(msg);
};

type RequestPayload = WorkerRequest extends infer R
  ? R extends WorkerRequest ? Omit<R, 'id' | 'protocolVersion'> : never
  : never;

function request<T extends Reply>(message: RequestPayload): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as unknown as Pending['resolve'], reject });
    const outgoing = { ...message, id, protocolVersion: PROTOCOL_VERSION } as WorkerRequest;
    const transfer = outgoing.type === 'importProject' ? [outgoing.data] : [];
    worker.postMessage(outgoing, transfer);
  });
}

export const inspectElement = async (expressID: number) =>
  (await request<Extract<Reply, { type: 'inspected' }>>({ type: 'inspect', expressID })).info;

export const queryDocument = async (query: AgentQuery): Promise<unknown> =>
  (await request<Extract<Reply, { type: 'queried' }>>({ type: 'query', query })).result;

function build(result: LoadResult): LoadedModel {
  const group = new THREE.Group();
  const shared = new Map<string, THREE.MeshLambertMaterial>();
  const make = ([r, g, b, a]: LoadResult['render'][number]['color']) =>
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(r, g, b),
      transparent: a < 1,
      opacity: a,
      side: THREE.DoubleSide,
      depthWrite: a >= 1,
    });

  const doors: DoorInfo[] = [];
  const cells = new Map<string, DoorCell>();
  const cellOf = (key: string) => {
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { merged: [], doors: [], box: new THREE.Box3(), near: null }));
    return cell;
  };
  for (const part of result.render) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));

    // Doors fade individually, so they can't share a material.
    let material: THREE.MeshLambertMaterial;
    if (part.door) {
      material = make(part.color);
    } else {
      const key = part.color.join(',');
      material = shared.get(key) ?? make(part.color);
      shared.set(key, material);
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    if (part.expressID != null) mesh.userData.expressID = part.expressID;
    group.add(mesh);

    if (part.door) {
      geometry.computeBoundingBox();
      const door = { mesh, box: geometry.boundingBox!.clone(), material, baseOpacity: part.color[3] };
      doors.push(door);
      if (part.doorCell != null) {
        const cell = cellOf(part.doorCell);
        cell.doors.push(door);
        cell.box.union(door.box);
      }
    } else if (part.doorCell != null) {
      // Desktop draws individual doors for picking and highlighting; VR turns these on.
      mesh.visible = false;
      cellOf(part.doorCell).merged.push(mesh);
    }
  }

  return {
    group,
    collision: new Collision(result.floor, result.solid),
    nav: null,
    navToken: result.navToken,
    points: [],
    levels: [],
    doors,
    doorCells: [...cells.values()],
    storeys: result.storeys,
    terrain: new Set(result.terrain),
    coordination: result.coordination,
  };
}

export async function loadNavigation(model: LoadedModel): Promise<void> {
  const { result } = await request<Extract<Reply, { type: 'navigated' }>>({ type: 'navigation', token: model.navToken });
  if (result.mesh) model.nav = new NavMesh(result.mesh);
  model.points = result.points;
  model.levels = result.levels;
}

export type OpenedDocument = { document: DocumentSummary; model: LoadedModel };

export const listProjects = async (): Promise<ProjectSummary[]> =>
  (await request<Extract<Reply, { type: 'projects' }>>({ type: 'listProjects' })).projects;

export async function importProject(file: File, progress: (message: string) => void): Promise<OpenedDocument> {
  onProgress = progress;
  const data = await file.arrayBuffer();
  const reply = await request<Extract<Reply, { type: 'opened' }>>({ type: 'importProject', name: file.name, data });
  workerDocument = reply.document;
  return { document: reply.document, model: build(reply.result) };
}

export async function openProject(projectId: string, standalone: number[], progress: (message: string) => void): Promise<OpenedDocument> {
  onProgress = progress;
  const reply = await request<Extract<Reply, { type: 'opened' }>>({ type: 'openProject', projectId, standalone });
  workerDocument = reply.document;
  return { document: reply.document, model: build(reply.result) };
}

export const selectElement = async (expressID: number | null): Promise<void> => {
  await request<Extract<Reply, { type: 'selected' }>>({ type: 'select', expressID });
};

export async function executeCommand(
  document: DocumentSummary,
  command: DocumentCommand,
  progress: (message: string) => void,
): Promise<OpenedDocument & { command: Extract<Reply, { type: 'executed' }>['command'] }> {
  onProgress = progress;
  const reply = await request<Extract<Reply, { type: 'executed' }>>({
    type: 'execute', documentId: document.documentId, baseRevision: document.revision, command,
  });
  workerDocument = reply.document;
  return { document: reply.document, model: build(reply.result), command: reply.command };
}

export async function changeRevision(
  action: 'undo' | 'redo',
  document: DocumentSummary,
  progress: (message: string) => void,
): Promise<OpenedDocument & { command: Extract<Reply, { type: 'executed' }>['command'] }> {
  onProgress = progress;
  const reply = await request<Extract<Reply, { type: 'executed' }>>({
    type: action, documentId: document.documentId, baseRevision: document.revision,
  });
  workerDocument = reply.document;
  return { document: reply.document, model: build(reply.result), command: reply.command };
}

export async function exportModel(): Promise<{ name: string; data: ArrayBuffer }> {
  const reply = await request<Extract<Reply, { type: 'exported' }>>({ type: 'exportProject' });
  return { name: reply.name, data: reply.data };
}
