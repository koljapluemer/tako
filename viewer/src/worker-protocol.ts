import type { SerializedBVH } from 'three-mesh-bvh';
import type { NavLevel, NavPoint } from './nav/points';

export const PROTOCOL_VERSION = 1 as const;
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
  /** Spatial cell of a door: set on individual doors and on the merged batch that stands in for them at a distance. */
  doorCell: string | null;
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
  terrain: number[];
  coordination: number[];
  /** Pass to a `navigation` request; a later load makes it stale. */
  navToken: number;
};

/** `rangeIds` in `mesh` hold connected-component ranks; 0 is the largest walkable area. */
export type NavBuild = { mesh: CollisionPart | null; points: NavPoint[]; levels: NavLevel[] };

export type ElementInfo = {
  expressID: number;
  globalId: string | null;
  ifcClass: string;
  name: string | null;
  materials: string[];
  properties: Array<[string, string]>;
};

export type ProjectSummary = {
  id: string;
  name: string;
  schema: string;
  revision: number;
  updatedAt: string;
  size: number;
};

export type DocumentSummary = ProjectSummary & {
  documentId: string;
  sourceFingerprint: string;
};

export type CommandTarget = { expressID?: number; globalId?: string };

export type DocumentCommand =
  | { kind: 'setName'; targets: CommandTarget[]; params: { name: string } }
  | { kind: 'setAttribute'; targets: CommandTarget[]; params: { attribute: string; value: string | number | boolean | null } }
  | { kind: 'setProperty'; targets: CommandTarget[]; params: { pset: string; name: string; value: string | number | boolean } }
  | { kind: 'resizeFilling'; targets: CommandTarget[]; params: { width?: number; height?: number; anchor: 'center' } }
  | { kind: 'moveElements'; targets: CommandTarget[]; params: { x: number; y: number; z: number } }
  | { kind: 'deleteElements'; targets: CommandTarget[]; params: { confirmationToken: string } };

export type RevisionInfo = { revision: number; title: string; createdAt: string | null; current: boolean };

export type CommandResult = {
  ok: true;
  commandId: string;
  revision: number;
  summary: string;
  changed: number[];
  warnings: string[];
};

export type AgentQuery =
  | { method: 'model_overview'; params?: Record<string, never> }
  | { method: 'find_elements'; params: { ifc_class?: string; storey?: string; exterior?: boolean; facing?: string; text?: string; sort_by?: string; limit?: number } }
  | { method: 'get_element'; params: { element: string } }
  | { method: 'context_around'; params: { target: string; radius?: number; limit?: number } }
  | { method: 'get_focus'; params?: Record<string, never> }
  | { method: 'list_materials'; params?: Record<string, never> };

type RequestBase = { protocolVersion: typeof PROTOCOL_VERSION; id: number };

export type WorkerRequest =
  | (RequestBase & { type: 'listProjects' })
  | (RequestBase & { type: 'importProject'; name: string; data: ArrayBuffer })
  | (RequestBase & { type: 'openProject'; projectId: string; standalone: number[] })
  | (RequestBase & { type: 'render'; standalone: number[] })
  | (RequestBase & { type: 'inspect'; expressID: number })
  | (RequestBase & { type: 'query'; query: AgentQuery })
  | (RequestBase & { type: 'select'; expressID: number | null })
  | (RequestBase & { type: 'exportProject' })
  | (RequestBase & { type: 'execute'; documentId: string; baseRevision: number; command: DocumentCommand; title?: string })
  | (RequestBase & { type: 'undo'; documentId: string; baseRevision: number })
  | (RequestBase & { type: 'redo'; documentId: string; baseRevision: number })
  | (RequestBase & { type: 'navigation'; token: number })
  | (RequestBase & { type: 'listRevisions' })
  /** `reuse`: the viewer still holds this revision's geometry, so don't send it again. */
  | (RequestBase & { type: 'jumpRevision'; documentId: string; baseRevision: number; target: number; reuse: boolean })
  | (RequestBase & { type: 'cancel'; requestId: number });

export type WorkerResponse =
  | { type: 'progress'; id?: number; message: string }
  | { type: 'projects'; id: number; projects: ProjectSummary[] }
  | { type: 'opened'; id: number; document: DocumentSummary; result: LoadResult }
  | { type: 'rendered'; id: number; document: DocumentSummary; result: LoadResult }
  | { type: 'inspected'; id: number; info: ElementInfo | null }
  | { type: 'queried'; id: number; result: unknown }
  | { type: 'selected'; id: number }
  | { type: 'exported'; id: number; name: string; data: ArrayBuffer }
  | { type: 'executed'; id: number; document: DocumentSummary; command: CommandResult; result: LoadResult }
  | { type: 'navigated'; id: number; result: NavBuild }
  | { type: 'revisions'; id: number; revisions: RevisionInfo[] }
  | { type: 'jumped'; id: number; document: DocumentSummary; result: LoadResult | null }
  | { type: 'error'; id: number; code: string; message: string };
