import * as THREE from 'three';
import { Collision } from './collision';
import type { ElementInfo, LoadResult, StoreyInfo, WorkerRequest, WorkerResponse } from './worker-protocol';

export type DoorInfo = { mesh: THREE.Mesh; box: THREE.Box3; material: THREE.MeshLambertMaterial; baseOpacity: number };

export type LoadedModel = {
  group: THREE.Group;
  collision: Collision;
  doors: DoorInfo[];
  storeys: StoreyInfo[];
  terrain: Set<number>;
  coordination: number[];
};

const worker = new Worker(new URL('./ifc-worker.ts', import.meta.url), { type: 'module' });

type Pending = { resolve: (value: never) => void; reject: (err: Error) => void };
const pending = new Map<number, Pending>();
let nextId = 1;
let onProgress: (message: string) => void = () => {};

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const msg = event.data;
  if (msg.type === 'progress') return onProgress(msg.message);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.type === 'error') p.reject(new Error(msg.message));
  else if (msg.type === 'loaded') p.resolve(msg.result as never);
  else p.resolve(msg.info as never);
};

function request<T>(message: Omit<WorkerRequest & { id: number }, 'id'> & Record<string, unknown>): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as Pending['resolve'], reject });
    worker.postMessage({ ...message, id });
  });
}

export const inspectElement = (expressID: number) => request<ElementInfo | null>({ type: 'inspect', expressID });

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
      doors.push({ mesh, box: geometry.boundingBox!.clone(), material, baseOpacity: part.color[3] });
    }
  }

  return {
    group,
    collision: new Collision(result.floor, result.solid),
    doors,
    storeys: result.storeys,
    terrain: new Set(result.terrain),
    coordination: result.coordination,
  };
}

/** `standalone`: elements to keep as individual meshes, so they can be highlighted. */
export async function loadModel(url: string, standalone: number[], progress: (message: string) => void): Promise<LoadedModel> {
  onProgress = progress;
  return build(await request<LoadResult>({ type: 'load', url, standalone }));
}
