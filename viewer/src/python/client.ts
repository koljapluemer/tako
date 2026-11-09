// The document worker's handle on the Python worker, which starts on the first scripted edit.

type Base = { id: number };
export type PythonRequest =
  | (Base & { type: 'run'; bytes: Uint8Array; code: string; values: Record<string, unknown>; commit: boolean })
  | (Base & { type: 'help'; topic?: string });
export type PythonReply =
  | { progress: string }
  | { id: number; result: unknown }
  | { id: number; error: string; fatal: boolean };

export type ScriptResult = { output: string; changed: number[]; verify: { ok: boolean; problems: string[] }; bytes: Uint8Array };

type Waiting = { resolve: (value: unknown) => void; reject: (error: Error) => void };
const waiting = new Map<number, Waiting>();
let worker: Worker | null = null;
let next = 0;
let onProgress: (message: string) => void = () => undefined;

function fail(message: string) {
  worker?.terminate();
  worker = null;
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

export async function runScript(
  model: Uint8Array,
  code: string,
  values: Record<string, unknown>,
  commit: boolean,
  progress: (message: string) => void,
): Promise<ScriptResult> {
  onProgress = progress;
  // A copy, because `model` may be a view that the caller still needs for rollback.
  const bytes = model.slice();
  const reply = await call<(ScriptResult & { ok: true }) | { ok: false; output: string; error: string }>(
    { type: 'run', id: next++, bytes, code, values, commit }, [bytes.buffer as ArrayBuffer],
  );
  if (!reply.ok) {
    const text = `the script failed and the model is unchanged\n${reply.error}${reply.output ? `\nprinted before the failure:\n${reply.output}` : ''}`;
    const error = new Error(text);
    error.stack = text;
    throw error;
  }
  return reply;
}

export function kitHelp(topic: string | undefined, progress: (message: string) => void): Promise<string> {
  onProgress = progress;
  return call<string>({ type: 'help', id: next++, topic });
}
