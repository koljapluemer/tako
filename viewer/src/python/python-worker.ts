/// <reference lib="webworker" />
// IfcOpenShell in Pyodide, for scripted edits: IFC bytes in, IFC bytes out. It keeps the parsed model of one model
// state between scripts (see runner.py), so the document worker sends bytes only when that state changes.
import type { PythonReply, PythonRequest, ScriptGeometry } from './client';

const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/';
// 0.9.0.post1 crashes with "memory access out of bounds" in ifcopenshell.open on Pyodide 0.29.
const WHEEL = 'https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl';
const SOURCE = '/tako-run/in.ifc';
const OUTPUT = '/tako-run/out.ifc';
const GEOMETRY = '/tako-run/geometry';

const sources = import.meta.glob('./py/**/*.py', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

// Pyodide comes from its CDN at runtime, so it has no package types here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pyodide = any;
let ready: Promise<Pyodide> | null = null;
/** How long the cold start took, until a script's timing has reported it. */
let loadMs: number | undefined;

const send = (message: PythonReply, transfer: Transferable[] = []) =>
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);

async function load(): Promise<Pyodide> {
  send({ progress: 'Loading Python for the scripted edit…' });
  const started = performance.now();
  const { loadPyodide } = await import(/* @vite-ignore */ `${PYODIDE}pyodide.mjs`);
  const py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage('micropip');
  await py.pyimport('micropip').install(WHEEL);
  py.FS.mkdirTree(GEOMETRY);
  py.FS.mkdirTree('/tako-py/tako/kit_examples');
  for (const [path, text] of Object.entries(sources)) py.FS.writeFile(`/tako-py/tako/${path.slice('./py/'.length)}`, text);
  await py.runPythonAsync("import sys\nsys.path.insert(0, '/tako-py')\nimport tako.runner");
  loadMs = Math.round(performance.now() - started);
  return py;
}

type Inputs = { bytes?: Uint8Array; geometry?: ScriptGeometry | null };

/** Writes what came with a request to the virtual filesystem; returns the paths Python reads, or null. */
function writeInputs(py: Pyodide, { bytes, geometry }: Inputs) {
  if (bytes) py.FS.writeFile(SOURCE, bytes);
  if (geometry) {
    py.FS.writeFile(`${GEOMETRY}/ids.bin`, new Uint8Array(geometry.ids.buffer, geometry.ids.byteOffset, geometry.ids.byteLength));
    py.FS.writeFile(`${GEOMETRY}/values.bin`, new Uint8Array(geometry.values.buffer, geometry.values.byteOffset, geometry.values.byteLength));
  }
  return { source: bytes ? SOURCE : null, geometry: geometry ? GEOMETRY : null };
}

function removeInputs(py: Pyodide) {
  // These live in the WASM heap; the parsed model is what's kept, not a second copy of its bytes.
  for (const path of [SOURCE, OUTPUT, `${GEOMETRY}/ids.bin`, `${GEOMETRY}/values.bin`]) if (py.FS.analyzePath(path).exists) py.FS.unlink(path);
  py.runPython('import gc; gc.collect()');
}

function run(py: Pyodide, request: Extract<PythonRequest, { type: 'run' }>) {
  try {
    const paths = writeInputs(py, request);
    const reply = JSON.parse(py.pyimport('tako.runner').run(
      request.key, paths.source, OUTPUT, request.code, JSON.stringify(request.values), request.commit, paths.geometry,
    ) as string);
    if (reply.ok && loadMs != null) {
      reply.timing.pyodide_load_ms = loadMs;
      loadMs = undefined;
    }
    if (!reply.ok || !request.commit) return { result: reply, transfer: [] };
    const bytes = (py.FS.readFile(OUTPUT) as Uint8Array).slice();
    return { result: { ...reply, bytes }, transfer: [bytes.buffer as ArrayBuffer] };
  } finally {
    removeInputs(py);
  }
}

function prime(py: Pyodide, request: Extract<PythonRequest, { type: 'prime' }>) {
  try {
    const paths = writeInputs(py, request);
    return JSON.parse(py.pyimport('tako.runner').prime(request.key, paths.source, paths.geometry) as string);
  } finally {
    removeInputs(py);
  }
}

self.onmessage = async ({ data }: MessageEvent<PythonRequest>) => {
  try {
    ready ??= load().catch((error) => { ready = null; throw error; });
    const py = await ready;
    if (data.type === 'help') {
      send({ id: data.id, result: py.pyimport('tako.runner').kit_help(data.topic) as string });
    } else if (data.type === 'prime') {
      send({ id: data.id, result: prime(py, data) });
    } else {
      const { result, transfer } = run(py, data);
      send({ id: data.id, result }, transfer);
    }
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    send({ id: data.id, error: message, fatal: message.includes('memory access') || message.includes('fatally failed') });
  }
};
