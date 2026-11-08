import type { SerializedBVH } from 'three-mesh-bvh';

export type Rgba = [number, number, number, number];
/** [minX, minZ, maxX, maxZ] */
export type Box2 = [number, number, number, number];

export type RenderPart = {
  color: Rgba;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Set on standalone meshes only; merged batches hold many elements. */
  expressID: number | null;
  door: boolean;
};

export type CollisionPart = {
  positions: Float32Array;
  bvh: SerializedBVH;
  /** First triangle of each element chunk, ascending; rangeIds[i] is its expressID. */
  rangeStarts: Uint32Array;
  rangeIds: Uint32Array;
};

export type StoreyInfo = {
  name: string;
  /** In file units: only its magnitude relative to other storeys is meaningful. */
  elevation: number | null;
  floorY: number;
  slabBox: Box2;
  stairBoxes: Box2[];
};

export type LoadResult = {
  render: RenderPart[];
  floor: CollisionPart | null;
  solid: CollisionPart | null;
  storeys: StoreyInfo[];
  /** IfcSite elements: walkable, but not somewhere a storey jump should land. */
  terrain: number[];
  coordination: number[];
};

export type ElementInfo = {
  expressID: number;
  ifcClass: string;
  name: string | null;
  materials: string[];
  properties: Array<[string, string]>;
};

export type WorkerRequest =
  | { type: 'load'; id: number; url: string; standalone: number[] }
  | { type: 'inspect'; id: number; expressID: number };

export type WorkerResponse =
  | { type: 'progress'; message: string }
  | { type: 'loaded'; id: number; result: LoadResult }
  | { type: 'inspected'; id: number; info: ElementInfo | null }
  | { type: 'error'; id: number; message: string };
