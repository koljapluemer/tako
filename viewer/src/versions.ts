import type { LoadedModel } from './model';

export type Version = { id: number; title: string; createdAt: string | null; current: boolean };

/** What the revision arc needs. Project history is the only source until revisions can reach the headset. */
export interface VersionSource {
  list(): Promise<Version[]>;
  select(version: Version): void;
}

// Provisional until measured on a headset: see doc/vr-headset-checklist.md.
export const MAX_CACHED_MODELS = 3;
export const MAX_CACHED_BYTES = 300 * 1024 * 1024;

export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const minutes = Math.floor((now - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (60 * 24))} d ago`;
}

type Entry = { key: string; project: string; revision: number; model: LoadedModel };

/** Keeps recent revisions' built geometry so A/B switching is instant. */
export class ModelCache {
  private entries: Entry[] = [];

  constructor(private dispose: (model: LoadedModel) => void, private maxModels = MAX_CACHED_MODELS, private maxBytes = MAX_CACHED_BYTES) {}

  get(project: string, revision: number): LoadedModel | null {
    const index = this.entries.findIndex((entry) => entry.project === project && entry.revision === revision);
    if (index < 0) return null;
    const [entry] = this.entries.splice(index, 1);
    this.entries.push(entry);
    return entry.model;
  }

  holds(model: LoadedModel) {
    return this.entries.some((entry) => entry.model === model);
  }

  /** `current` is on screen and is never evicted. */
  put(project: string, revision: number, model: LoadedModel, current: LoadedModel | null) {
    const key = `${project}:${revision}`;
    const existing = this.entries.find((entry) => entry.key === key);
    if (existing?.model === model) return;
    if (existing) this.remove(existing, current);
    this.entries.push({ key, project, revision, model });
    this.evict(current);
  }

  /** A new edit overwrites revision numbers above the one it was made on. */
  dropAfter(project: string, revision: number, current: LoadedModel | null) {
    for (const entry of this.entries.filter((e) => e.project === project && e.revision >= revision)) this.remove(entry, current);
  }

  private remove(entry: Entry, current: LoadedModel | null) {
    this.entries = this.entries.filter((e) => e !== entry);
    if (entry.model !== current) this.dispose(entry.model);
  }

  private evict(current: LoadedModel | null) {
    const bytes = () => this.entries.reduce((sum, entry) => sum + entry.model.bytes, 0);
    while (this.entries.length > this.maxModels || bytes() > this.maxBytes) {
      const victim = this.entries.find((entry) => entry.model !== current);
      if (!victim) return;
      this.remove(victim, current);
    }
  }
}
