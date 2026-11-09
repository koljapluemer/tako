import { SAMPLES } from './samples';
import type { ProjectSummary } from './worker-protocol';

// projects/<sample file>/{manifest.json, history.json, revisions/NNNN.ifc}
const ROOT = 'projects';
const MANIFEST = 'manifest.json';
const HISTORY = 'history.json';
const REVISIONS = 'revisions';

export type HistoryEntry = {
  commandId: string;
  revision: number;
  summary: string;
  title?: string;
  createdAt: string;
  changed: number[];
  command: unknown;
};

/** `id` is the sample's file name, so a building has at most one project. */
export type ProjectManifest = ProjectSummary & {
  version: 1;
  sourceFingerprint: string;
  cursor: number;
  focus: number | null;
};

const root = async () => {
  const storage = await navigator.storage.getDirectory();
  return storage.getDirectoryHandle(ROOT, { create: true });
};

const projectDir = async (id: string, create = false) => (await root()).getDirectoryHandle(id, { create });

const isSample = (name: string) => SAMPLES.some((sample) => sample.file === name);

const revisionFile = (revision: number) => `${String(revision).padStart(4, '0')}.ifc`;

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array> {
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  const buffer: ArrayBuffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array | string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  await writer.write(typeof data === 'string' ? data : data.slice().buffer as ArrayBuffer);
  await writer.close();
}

const readJson = async <T>(dir: FileSystemDirectoryHandle, name: string): Promise<T> =>
  JSON.parse(new TextDecoder().decode(await readFile(dir, name))) as T;

const writeJson = (dir: FileSystemDirectoryHandle, name: string, value: unknown) =>
  writeFile(dir, name, JSON.stringify(value, null, 2));

async function fingerprint(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** Also deletes anything that isn't a selectable building, so storage only ever holds their revisions. */
export async function listProjects(): Promise<ProjectManifest[]> {
  const dir = await root();
  const out: ProjectManifest[] = [];
  const unknown: string[] = [];
  for await (const [name, handle] of dir) {
    if (!isSample(name) || handle.kind !== 'directory') {
      unknown.push(name);
      continue;
    }
    try {
      out.push(await readJson<ProjectManifest>(handle, MANIFEST));
    } catch {
      // An interrupted import has no valid manifest and is deliberately invisible.
    }
  }
  await Promise.all(unknown.map((name) => dir.removeEntry(name, { recursive: true })));
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function importProject(file: string, data: Uint8Array, schema: string): Promise<ProjectManifest> {
  if (!isSample(file)) throw new Error(`${file} is not a selectable building`);
  const dir = await projectDir(file, true);
  const manifest: ProjectManifest = {
    version: 1,
    id: file,
    name: file,
    schema,
    revision: 0,
    cursor: 0,
    updatedAt: new Date().toISOString(),
    size: data.byteLength,
    sourceFingerprint: await fingerprint(data),
    focus: null,
  };
  const revisions = await dir.getDirectoryHandle(REVISIONS, { create: true });
  await writeFile(revisions, revisionFile(0), data);
  await writeJson(dir, HISTORY, []);
  // Manifest is last: it is the commit marker for an import.
  await writeJson(dir, MANIFEST, manifest);
  return manifest;
}

export async function loadRevision(id: string, revision: number): Promise<Uint8Array> {
  const dir = await projectDir(id);
  return readFile(await dir.getDirectoryHandle(REVISIONS), revisionFile(revision));
}

export async function openProject(id: string): Promise<{
  manifest: ProjectManifest;
  data: Uint8Array;
  history: HistoryEntry[];
}> {
  const dir = await projectDir(id);
  const manifest = await readJson<ProjectManifest>(dir, MANIFEST);
  return {
    manifest,
    data: await loadRevision(id, manifest.cursor),
    history: await readJson<HistoryEntry[]>(dir, HISTORY),
  };
}

/** Stores a new edit as `manifest.revision`. Revisions past the end of `history` were cut off by it. */
export async function commitProject(
  manifest: ProjectManifest,
  history: HistoryEntry[],
  data: Uint8Array,
): Promise<void> {
  const dir = await projectDir(manifest.id);
  const revisions = await dir.getDirectoryHandle(REVISIONS);
  await writeFile(revisions, revisionFile(manifest.revision), data);
  await writeJson(dir, HISTORY, history);
  await saveManifest(manifest);
  const stale: string[] = [];
  for await (const name of revisions.keys()) {
    if (Number.parseInt(name, 10) > history.length) stale.push(name);
  }
  await Promise.all(stale.map((name) => revisions.removeEntry(name)));
}

export async function saveManifest(manifest: ProjectManifest): Promise<void> {
  await writeJson(await projectDir(manifest.id), MANIFEST, manifest);
}

export async function saveFocus(manifest: ProjectManifest, expressID: number | null): Promise<void> {
  manifest.focus = expressID;
  await saveManifest(manifest);
}
