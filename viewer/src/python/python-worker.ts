/// <reference lib="webworker" />
// IfcOpenShell in Pyodide, for scripted edits. It holds no model between runs: IFC bytes in, IFC bytes out.
import type { PythonReply, PythonRequest } from './client';

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/';
// 0.9.0.post1 crashes with "memory access out of bounds" in ifcopenshell.open on Pyodide 0.29.
const WHEEL = 'https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl';
const SOURCE = '/tako-run/in.ifc';
const OUTPUT = '/tako-run/out.ifc';

const sources = import.meta.glob('./py/**/*.py', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// Pyodide comes from its CDN at runtime, so it has no package types here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pyodide = any;
let ready: Promise<Pyodide> | null = null;

const send = (message: PythonReply, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);

async function load(): Promise<Pyodide> {
  send({ progress: 'Loading Python for the scripted edit…' });
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE}pyodide.mjs`);
  const py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage('micropip');
  await py.pyimport('micropip').install(WHEEL);
  py.FS.mkdirTree('/tako-run');
  py.FS.mkdirTree('/tako-py/tako/kit_examples');
  for (const [path, text] of Object.entries(sources)) py.FS.writeFile(`/tako-py/tako/${path.slice('./py/'.length)}`, text);
  await py.runPythonAsync("import sys\nsys.path.insert(0, '/tako-py')\nimport tako.runner");
  return py;
}

function run(py: Pyodide, request: Extract<PythonRequest, { type: 'run' }>) {
  py.FS.writeFile(SOURCE, request.bytes);
  try {
    const reply = JSON.parse(py.pyimport('tako.runner').run(SOURCE, OUTPUT, request.code, JSON.stringify(request.values), request.commit) as string);
    if (!reply.ok || !request.commit) return { result: reply, transfer: [] };
    const bytes = (py.FS.readFile(OUTPUT) as Uint8Array).slice();
    return { result: { ...reply, bytes }, transfer: [bytes.buffer as ArrayBuffer] };
  } finally {
    // Both files live in the WASM heap, so leaving them behind would pin a copy of the model.
    for (const path of [SOURCE, OUTPUT]) if (py.FS.analyzePath(path).exists) py.FS.unlink(path);
    py.runPython('import gc; gc.collect()');
  }
}

self.onmessage = async ({ data }: MessageEvent<PythonRequest>) => {
  try {
    ready ??= load().catch((error) => { ready = null; throw error; });
    const py = await ready;
    if (data.type === 'help') {
      send({ id: data.id, result: py.pyimport('tako.runner').kit_help(data.topic) as string });
    } else {
      const { result, transfer } = run(py, data);
      send({ id: data.id, result }, transfer);
    }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    send({ id: data.id, error: message, fatal: message.includes('memory access') || message.includes('fatally failed') });
  }
};
