import type { ProjectSummary } from './worker-protocol';

const ROOT = 'projects';
const MANIFEST = 'manifest.json';
const SOURCE = 'source.ifc';
const CURRENT = 'current.ifc';
const HISTORY = 'history.json';

export type HistoryEntry = {
  commandId: string;
  revision: number;
  summary: string;
  /** Absent on entries written before titles and ages existed. */
  title?: string;
  createdAt?: string;
  changed: number[];
  command: unknown;
};

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

export async function fingerprint(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

export async function listProjects(): Promise<ProjectManifest[]> {
  const out: ProjectManifest[] = [];
  for await (const [, handle] of await root()) {
    if (handle.kind !== 'directory') continue;
    try {
      out.push(await readJson<ProjectManifest>(handle, MANIFEST));
    } catch {
      // An interrupted import has no valid manifest and is deliberately invisible.
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function importProject(name: string, data: Uint8Array, schema: string): Promise<ProjectManifest> {
  const id = crypto.randomUUID();
  const dir = await projectDir(id, true);
  const now = new Date().toISOString();
  const manifest: ProjectManifest = {
    version: 1,
    id,
    name,
    schema,
    revision: 0,
    cursor: 0,
    updatedAt: now,
    size: data.byteLength,
    sourceFingerprint: await fingerprint(data),
    focus: null,
  };
  await writeFile(dir, SOURCE, data);
  await writeFile(dir, CURRENT, data);
  const revisions = await dir.getDirectoryHandle('revisions', { create: true });
  await writeFile(revisions, '0000.ifc', data);
  await writeJson(dir, HISTORY, []);
  // Manifest is last: it is the commit marker for an import.
  await writeJson(dir, MANIFEST, manifest);
  return manifest;
}

export async function openProject(id: string): Promise<{
  manifest: ProjectManifest;
  data: Uint8Array;
  history: HistoryEntry[];
}> {
  const dir = await projectDir(id);
  return {
    manifest: await readJson<ProjectManifest>(dir, MANIFEST),
    data: await readFile(dir, CURRENT),
    history: await readJson<HistoryEntry[]>(dir, HISTORY),
  };
}

export async function commitProject(
  manifest: ProjectManifest,
  history: HistoryEntry[],
  data: Uint8Array,
): Promise<void> {
  const dir = await projectDir(manifest.id);
  const recovery = `recovery-${manifest.revision}.ifc`;
  await writeFile(dir, recovery, await readFile(dir, CURRENT));
  await writeFile(dir, CURRENT, data);
  const revisions = await dir.getDirectoryHandle('revisions', { create: true });
  await writeFile(revisions, `${String(manifest.revision).padStart(4, '0')}.ifc`, data);
  await writeJson(dir, HISTORY, history);
  await writeJson(dir, MANIFEST, manifest);
  await dir.removeEntry(recovery).catch(() => undefined);
}

export async function loadRevision(id: string, revision: number): Promise<Uint8Array> {
  const dir = await projectDir(id);
  const revisions = await dir.getDirectoryHandle('revisions');
  return readFile(revisions, `${String(revision).padStart(4, '0')}.ifc`);
}

export async function saveFocus(manifest: ProjectManifest, expressID: number | null): Promise<void> {
  manifest.focus = expressID;
  await writeJson(await projectDir(manifest.id), MANIFEST, manifest);
}

export async function exportProject(id: string): Promise<Uint8Array> {
  return readFile(await projectDir(id), CURRENT);
}
