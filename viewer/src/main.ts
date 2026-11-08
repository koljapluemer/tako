import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  changeRevision, exportModel, importProject, inspectElement, listProjects, openProject, selectElement,
  executeCommand, queryDocument, type LoadedModel, type OpenedDocument,
} from './model';
import type { DocumentSummary } from './worker-protocol';
import { connectAgent } from './agent-client';
import { fetchSample, sampleFileName, SAMPLES, type Sample } from './samples';
import { XRWalk } from './xr/session';

const statusEl = document.getElementById('status')!;
const setStatus = (msg: string) => (statusEl.textContent = msg);

// --- three.js setup -------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1f22);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 5000);
camera.position.set(30, 30, 30);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(50, 100, 30);
scene.add(sun);
scene.add(new THREE.GridHelper(200, 100, 0x555555, 0x333333));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const xr = new XRWalk(renderer, scene, camera);
xr.onExit = (reframe) => {
  if (reframe && current) frameObject(current.group);
};

renderer.setAnimationLoop(() => {
  if (xr.presenting) xr.update();
  else controls.update();
  renderer.render(scene, camera);
});

function frameObject(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(size));
  camera.near = size / 1000;
  camera.far = size * 10;
  camera.updateProjectionMatrix();
}

// --- live reload + change highlighting ------------------------------------
type ModelChange = { rev: number; summary: string; changed: number[] } | null;

const highlightMat = new THREE.MeshLambertMaterial({
  color: 0xff8a1f, emissive: 0x7a3300, side: THREE.DoubleSide,
});
let current: LoadedModel | null = null;
let activeDocument: DocumentSummary | null = null;
let loading = Promise.resolve();

function disposeModel({ group, collision }: LoadedModel) {
  const mats = new Set<THREE.Material>();
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      mats.add(o.material as THREE.Material);
      if (o.userData.baseMaterial) mats.add(o.userData.baseMaterial as THREE.Material);
    }
  });
  mats.forEach((m) => m !== highlightMat && m.dispose());
  collision.dispose();
}

function highlight(model: THREE.Group, ids: number[]) {
  const set = new Set(ids);
  const hits: THREE.Mesh[] = [];
  model.traverse((o) => {
    if (o instanceof THREE.Mesh && set.has(o.userData.expressID)) {
      o.userData.baseMaterial = o.material;
      o.material = highlightMat;
      hits.push(o);
    }
  });
  // Restore after a few seconds; pulsing via emissive while it lasts.
  const until = performance.now() + 6000;
  const tick = () => {
    const t = performance.now();
    if (t > until || current?.group !== model) {
      hits.forEach((m) => (m.material = m.userData.baseMaterial));
      return;
    }
    highlightMat.emissiveIntensity = 0.6 + 0.4 * Math.sin(t / 150);
    requestAnimationFrame(tick);
  };
  tick();
}

function show(opened: Promise<OpenedDocument>, change: ModelChange, refocus: boolean) {
  // Serialise loads so rapid edits don't race.
  loading = loading.then(async () => {
    setStatus(change ? `Loading rev ${change.rev}…` : 'Loading…');
    try {
      const { model, document } = await opened;
      await xr.swap(() => {
        const previous = current;
        scene.add(model.group);
        model.group.updateMatrixWorld(true);
        current = model;
        activeDocument = document;
        xr.setModel(model, refocus);
        if (previous) {
          scene.remove(previous.group);
          disposeModel(previous);
        }
      });
      if (refocus) selectionMarker.visible = false;
      if (refocus && !xr.presenting) frameObject(model.group);
      if (change && change.changed.length) highlight(model.group, change.changed);
      const summary = change && change.summary.length > 140 ? `${change.summary.slice(0, 140)}…` : change?.summary;
      const label = change && change.rev > 0 ? `rev ${change.rev}: ${summary}` : `${document.name}: ${model.group.children.length} draw groups`;
      setStatus(model.collision.hasFloor ? label : `${label}. No floor elements found, so VR teleport is unavailable`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// --- click to select: tells Claude what "this" means --------------------------
const selectionMarker = new THREE.Mesh(
  new THREE.SphereGeometry(0.12, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0x35d0ff, depthTest: false, transparent: true, opacity: 0.9 }),
);
selectionMarker.renderOrder = 10;
selectionMarker.visible = false;
scene.add(selectionMarker);

const CLICK_TOLERANCE_PX = 5;
const pickRay = new THREE.Raycaster();
let pressedAt: { x: number; y: number } | null = null;

function pick(event: PointerEvent, model: LoadedModel) {
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  pickRay.setFromCamera(pointer, camera);
  const hit = model.collision.raycast(pickRay.ray, camera.far);
  pickRay.far = hit ? hit.distance : camera.far;
  const door = pickRay.intersectObjects(model.doors.map((d) => d.mesh), false)[0];
  if (door) return { point: door.point, expressID: door.object.userData.expressID as number };
  return hit && { point: hit.point, expressID: hit.expressID };
}

async function select(event: PointerEvent) {
  if (!current || xr.presenting) return;
  const picked = pick(event, current);
  selectionMarker.visible = picked != null;
  if (!picked) {
    await selectElement(null);
    setStatus('Selection cleared');
    return;
  }
  selectionMarker.position.copy(picked.point);
  await selectElement(picked.expressID);
  const info = await inspectElement(picked.expressID).catch(() => null);
  setStatus(`Selected #${picked.expressID}${info ? `: ${info.ifcClass} ${info.name ?? ''}` : ''}`);
}

renderer.domElement.addEventListener('pointerdown', (e) => (pressedAt = { x: e.clientX, y: e.clientY }));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (pressedAt && Math.hypot(e.clientX - pressedAt.x, e.clientY - pressedAt.y) <= CLICK_TOLERANCE_PX) {
    void select(e);
  }
  pressedAt = null;
});

// --- local projects ---------------------------------------------------------
const picker = document.getElementById('model') as HTMLSelectElement;
const importButton = document.getElementById('import') as HTMLButtonElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;
const undoButton = document.getElementById('undo') as HTMLButtonElement;
const redoButton = document.getElementById('redo') as HTMLButtonElement;
const fileInput = document.getElementById('ifc-file') as HTMLInputElement;
const SAMPLE_PREFIX = 'sample:';

async function refreshPicker() {
  const projects = await listProjects();
  picker.replaceChildren(
    ...projects.map((p) => new Option(`${p.name} · rev ${p.revision}`, p.id, false, p.id === activeDocument?.id)),
  );
  // An opened sample is a local project from then on, listed above with its edits.
  const unopened = SAMPLES.filter((s) => !projects.some((p) => p.name === sampleFileName(s)));
  if (unopened.length) {
    const group = Object.assign(document.createElement('optgroup'), { label: 'Samples' });
    group.append(...unopened.map((s) => new Option(s.name, SAMPLE_PREFIX + s.path)));
    picker.append(group);
  }
  return projects;
}

let openingSample = false;

async function openSample(sample: Sample) {
  if (openingSample) return;
  openingSample = true;
  picker.disabled = true;
  xr.notify(`Loading ${sample.name}…`, true);
  const opened = (async () => {
    const existing = (await listProjects()).find((p) => p.name === sampleFileName(sample));
    if (existing) return openProject(existing.id, [], setStatus);
    return importProject(await fetchSample(sample, setStatus), setStatus);
  })();
  show(opened, null, true);
  const failed = await opened.then(() => false, () => true);
  await loading;
  if (failed) xr.notify(`Could not load ${sample.name}`, false);
  await refreshPicker();
  picker.disabled = false;
  openingSample = false;
}

xr.setSamples(SAMPLES, (sample) => void openSample(sample));

picker.addEventListener('change', async () => {
  if (picker.value.startsWith(SAMPLE_PREFIX)) {
    const sample = SAMPLES.find((s) => SAMPLE_PREFIX + s.path === picker.value);
    if (sample) await openSample(sample);
    return;
  }
  picker.disabled = true;
  show(openProject(picker.value, [], setStatus), null, true);
  await loading;
  picker.disabled = false;
});

importButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  show(importProject(file, setStatus), null, true);
  await loading;
  await refreshPicker();
  if (activeDocument) picker.value = activeDocument.id;
  fileInput.value = '';
});

exportButton.addEventListener('click', async () => {
  if (!activeDocument) return;
  const exported = await exportModel();
  const url = URL.createObjectURL(new Blob([exported.data], { type: 'application/x-step' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: exported.name });
  link.click();
  URL.revokeObjectURL(url);
});

async function historyAction(action: 'undo' | 'redo') {
  if (!activeDocument) return;
  const changed = changeRevision(action, activeDocument, setStatus);
  const result = changed.then(({ document, model, command }) => ({ document, model, change: command }));
  show(result.then(({ document, model }) => ({ document, model })), null, false);
  const { change } = await result;
  await loading;
  setStatus(change.summary);
  await refreshPicker();
}

undoButton.addEventListener('click', () => void historyAction('undo'));
redoButton.addEventListener('click', () => void historyAction('redo'));

refreshPicker().then((projects) => {
  if (projects[0]) {
    picker.value = projects[0].id;
    show(openProject(projects[0].id, [], setStatus), null, true);
  } else {
    void openSample(SAMPLES[0]);
  }
});

const agentWindow = window as Window & { __takoAgentDisconnect?: () => void };
agentWindow.__takoAgentDisconnect?.();
agentWindow.__takoAgentDisconnect = connectAgent({
  document: () => activeDocument,
  status: setStatus,
  query: queryDocument,
  execute: (document, command) => executeCommand(document, command, setStatus),
  revision: (action, document) => changeRevision(action, document, setStatus),
  changed: async (opened, summary, ids) => {
    show(Promise.resolve(opened), { rev: opened.document.revision, summary, changed: ids }, false);
    await loading;
    await refreshPicker();
    picker.value = opened.document.id;
  },
});

if (import.meta.env.DEV) {
  // Test hook: lets browser automation read renderer stats and drive the session.
  Object.assign(window, { __tako: { renderer, scene, camera, xr, current: () => current, document: () => activeDocument } });
}
