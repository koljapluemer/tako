// The document worker's handle on the Python worker, which starts on the first scripted edit.

type Base = { id: number };
export type PythonRequest =
  | (Base & { type: 'run'; key: string; bytes?: Uint8Array; geometry: ScriptGeometry | null; code: string; values: Record<string, unknown>; commit: boolean })
  | (Base & { type: 'prime'; key: string; bytes: Uint8Array; geometry: ScriptGeometry | null })
  | (Base & { type: 'help'; topic?: string });
export type PythonReply =
  | { progress: string }
  | { id: number; result: unknown }
  | { id: number; error: string; fatal: boolean };

/** Rows the viewer measured for the spatial index; the layout is GEOMETRY_ROW in py/spatial.py. */
export type ScriptGeometry = { ids: Int32Array; values: Float64Array };

export type ScriptResult = { output: string; changed: number[]; verify: { ok: boolean; problems: string[] }; bytes: Uint8Array; timing: Record<string, number> };

type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const waiting = new Map<number, Waiting>();
let worker: Worker | null = null;
let next = 0;
let onProgress: (message: string) => void = () => undefined;
/** The model state the Python worker has parsed and kept, as far as this side knows. */
let heldKey: string | null = null;

/** Whether the Python worker already holds the model for `key`, so priming it again would be wasted. */
export const holdsModel = (key: string) => heldKey === key;

function fail(message: string) {
  worker?.terminate();
  worker = null;
  heldKey = null;
  for (const call of waiting.values()) call.reject(new Error(message));
  waiting.clear();
}

function start(): Worker {
  const started = new Worker(new URL('./python-worker.ts', import.meta.url), { type: 'module' });
  started.onerror = (event) => fail(`the Python worker stopped: ${event.message}`);
  started.onmessage = ({ data }: MessageEvent<PythonReply>) => {
    if ('progress' in data) return onProgress(data.progress);
    const call = waiting.get(data.id);
    waiting.delete(data.id);
    if ('error' in data) {
      call?.reject(new Error(data.error));
      // A fatal error poisons the interpreter, so the next script gets a new one.
      if (data.fatal) fail('the Python runtime crashed');
    } else {
      call?.resolve(data.result);
    }
  };
  return started;
}

function call<T>(request: PythonRequest, transfer: Transferable[] = []): Promise<T> {
  worker ??= start();
  const running = worker;
  return new Promise<T>((resolve, reject) => {
    waiting.set(request.id, { resolve: resolve as Waiting['resolve'], reject });
    running.postMessage(request, transfer);
  });
}

type RunReply = (ScriptResult & { ok: true; held: boolean }) | { ok: false; stale: true } | { ok: false; stale?: undefined; held: boolean; output: string; error: string };

/**
 * Runs a script against the model state `key`. `model` makes that state's bytes and is only called when the
 * Python worker doesn't already hold it, so a repeated read-only script skips serializing and parsing.
 */
export async function runScript(
  model: () => Uint8Array,
  code: string,
  values: Record<string, unknown>,
  commit: boolean,
  key: string,
  geometry: ScriptGeometry | null,
  progress: (message: string) => void,
): Promise<ScriptResult> {
  onProgress = progress;
  const send = (withModel: boolean) => {
    // Copies, because the caller may still need `model`'s bytes for rollback and keeps `geometry` for later scripts.
    const bytes = withModel ? model().slice() : undefined;
    const rows = geometry && { ids: geometry.ids.slice(), values: geometry.values.slice() };
    const transfer = [bytes?.buffer, rows?.ids.buffer, rows?.values.buffer].filter((b): b is ArrayBuffer => b != null);
    return call<RunReply>({ type: 'run', id: next++, key, bytes, geometry: rows, code, values, commit }, transfer);
  };
  let reply = await send(heldKey !== key);
  if (!reply.ok && reply.stale) reply = await send(true);
  if (!reply.ok && reply.stale) throw new Error('the Python worker lost the model it was just sent');
  heldKey = reply.held ? key : null;
  if (!reply.ok) {
    const text = `the script failed and the model is unchanged\n${reply.error}${reply.output ? `\nprinted before the failure:\n${reply.output}` : ''}`;
    const error = new Error(text);
    error.stack = text;
    throw error;
  }
  return reply;
}

/** Loads Python and parses the model ahead of the first script, so that script doesn't wait for either. */
export async function primeScripts(key: string, bytes: Uint8Array, geometry: ScriptGeometry | null): Promise<void> {
  onProgress = () => undefined;
  const rows = geometry && { ids: geometry.ids.slice(), values: geometry.values.slice() };
  const copy = bytes.slice(); // `bytes` may be a view the caller still uses
  const transfer = [copy.buffer as ArrayBuffer, ...(rows ? [rows.ids.buffer, rows.values.buffer] : [])];
  heldKey = null;
  await call({ type: 'prime', id: next++, key, bytes: copy, geometry: rows }, transfer);
  heldKey = key;
}

export function kitHelp(topic: string | undefined, progress: (message: string) => void): Promise<string> {
  onProgress = progress;
  return call<string>({ type: 'help', id: next++, topic });
}
