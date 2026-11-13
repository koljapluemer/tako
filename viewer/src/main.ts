import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  changeRevision, exportModel, importProject, inspectElement, jumpToRevision, listProjects, listRevisions, loadNavigation, openProject, selectElement,
  executeCommand, modelEvents, onModelEvent, queryDocument, reviseEdit, warmScripts, type LoadedModel, type OpenedDocument,
} from './model';
import type { DocumentSummary } from './worker-protocol';
import { connectAgent } from './agent-client';
import { VoiceAgent } from './voice-agent';
import { fetchSample, SAMPLES, type Sample } from './samples';
import { ModelCache, type VersionSource } from './versions';
import { XRWalk } from './xr/session';
import { ChangeHighlight, highlightMaterial } from './change-highlight';

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
xr.onHighlight = (on) => changes.setEnabled(on);
xr.onExit = (reframe) => {
  if (reframe && current) frameObject(current.group);
};

renderer.setAnimationLoop(() => {
  changes.update(performance.now(), current?.group ?? null);
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

const changes = new ChangeHighlight();
let current: LoadedModel | null = null;
let activeDocument: DocumentSummary | null = null;
let loading = Promise.resolve();

function disposeModel({ group, collision, nav }: LoadedModel) {
  const mats = new Set<THREE.Material>();
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      mats.add(o.material as THREE.Material);
      if (o.userData.baseMaterial) mats.add(o.userData.baseMaterial as THREE.Material);
    }
  });
  mats.forEach((m) => m !== highlightMaterial && m.dispose());
  collision.dispose();
  nav?.dispose();
}

const modelCache = new ModelCache(disposeModel);

async function addNavigation(model: LoadedModel) {
  await loadNavigation(model).catch(console.warn);
  if (current === model) xr.setNavigation(model);
  else if (!modelCache.holds(model)) {
    model.nav?.dispose();
    model.nav = null;
  }
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
          if (!modelCache.holds(previous)) disposeModel(previous);
        }
      });
      modelCache.put(document.id, document.revision, model, model);
      if (refocus) selectionMarker.visible = false;
      if (refocus && !xr.presenting) frameObject(model.group);
      if (change && change.changed.length) {
        const box = changes.show(model.group, change.changed);
        if (box) xr.setChange(box);
      } else if (!change) {
        changes.clear();
        xr.clearChange();
      }
      // Paint on anything an edit touched is stale; undo, revision jumps and new buildings make all of it stale.
      if (change) xr.spray.dropColorsTouching(change.changed);
      else xr.spray.clear();
      const summary = change && change.summary.length > 140 ? `${change.summary.slice(0, 140)}…` : change?.summary;
      const label = change && change.rev > 0 ? `rev ${change.rev}: ${summary}` : `${document.name}: ${model.group.children.length} draw groups`;
      setStatus(model.collision.hasFloor ? label : `${label}. No floor-class elements: VR relies on generated walkable areas`);
      void addNavigation(model);
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
  return pickAlong(pickRay.ray, model);
}

function pickAlong(ray: THREE.Ray, model: LoadedModel) {
  const hit = model.collision.raycast(ray, camera.far);
  pickRay.ray.copy(ray);
  pickRay.far = hit ? hit.distance : camera.far;
  const door = pickRay.intersectObjects(model.doors.map((d) => d.mesh), false)[0];
  if (door) return { point: door.point, normal: door.face!.normal.clone(), expressID: door.object.userData.expressID as number };
  return hit && { point: hit.point, normal: hit.normal, expressID: hit.expressID };
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

// --- buildings --------------------------------------------------------------
const picker = document.getElementById('model') as HTMLSelectElement;
const exportButton = document.getElementById('export') as HTMLButtonElement;
const undoButton = document.getElementById('undo') as HTMLButtonElement;
const redoButton = document.getElementById('redo') as HTMLButtonElement;

async function refreshPicker() {
  const projects = await listProjects();
  picker.replaceChildren(...SAMPLES.map((s) => {
    const revision = projects.find((p) => p.id === s.file)?.revision;
    return new Option(revision ? `${s.name} · rev ${revision}` : s.name, s.file, false, s.file === activeDocument?.id);
  }));
  return projects;
}

let openingSample = false;

async function openSample(sample: Sample) {
  if (openingSample) return;
  openingSample = true;
  picker.disabled = true;
  xr.notify(`Loading ${sample.name}…`, 'working');
  const opened = (async () => {
    const stored = (await listProjects()).some((p) => p.id === sample.file);
    if (stored) return openProject(sample.file, [], setStatus);
    return importProject(await fetchSample(sample, setStatus), setStatus);
  })();
  show(opened, null, true);
  const failed = await opened.then(() => false, () => true);
  await loading;
  if (failed) xr.notify(`Could not load ${sample.name}`, 'error');
  await refreshPicker();
  picker.disabled = false;
  openingSample = false;
}

xr.setSamples(SAMPLES, (sample) => void openSample(sample));

picker.addEventListener('change', () => {
  const sample = SAMPLES.find((s) => s.file === picker.value);
  if (sample) void openSample(sample);
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

// --- revision switching ------------------------------------------------------
// Latest wins: a selection made during a load replaces any waiting one, so rapid A/B doesn't queue up.
let wantedRevision: number | null = null;
let jumping = false;

async function performJump(target: number) {
  if (!activeDocument) return;
  const cached = modelCache.get(activeDocument.id, target);
  if (!cached) xr.notify('Loading revision…', 'working');
  const opened = jumpToRevision(activeDocument, target, cached, setStatus);
  show(opened, null, false);
  const failed = await opened.then(() => false, () => true);
  await loading;
  if (failed) xr.notify('Could not load that revision', 'error');
}

async function requestRevision(target: number) {
  wantedRevision = target;
  if (jumping) return;
  jumping = true;
  while (wantedRevision != null) {
    const next = wantedRevision;
    wantedRevision = null;
    if (next !== activeDocument?.revision) await performJump(next);
  }
  jumping = false;
  await refreshPicker();
}

const versions: VersionSource = {
  list: async () => (await listRevisions()).map(({ revision, title, createdAt, current: isCurrent }) => ({ id: revision, title, createdAt, current: isCurrent })),
  select: (version) => void requestRevision(version.id),
};
xr.setVersions(versions);

undoButton.addEventListener('click', () => void historyAction('undo'));
redoButton.addEventListener('click', () => void historyAction('redo'));

refreshPicker().then((projects) => {
  const latest = SAMPLES.find((s) => s.file === projects[0]?.id) ?? SAMPLES[0];
  picker.value = latest.file;
  void openSample(latest);
});

const agentWindow = window as Window & { __takoAgentDisconnect?: () => void };
agentWindow.__takoAgentDisconnect?.();
const connect = (port: number) => connectAgent({
  port,
  document: () => activeDocument,
  modelEvents,
  onModelEvent,
  status: setStatus,
  query: queryDocument,
  warm: warmScripts,
  execute: async (document, command, title) => {
    const executed = await executeCommand(document, command, setStatus, title);
    modelCache.dropAfter(document.id, executed.document.revision, current);
    return executed;
  },
  revision: (action, document) => changeRevision(action, document, setStatus),
  revise: async (document, edit) => {
    const revised = await reviseEdit(document, edit, setStatus);
    modelCache.dropAfter(document.id, revised.document.revision - 1, current);
    return revised;
  },
  changed: async (opened, summary, ids) => {
    show(Promise.resolve(opened), { rev: opened.document.revision, summary, changed: ids }, false);
    await loading;
    await refreshPicker();
    picker.value = opened.document.id;
  },
});
// 47831 is a desktop Claude session; 47833 is the VR agent's own Claude.
const agent = connect(47831);
const vrAgent = connect(47833);
agentWindow.__takoAgentDisconnect = () => {
  agent.disconnect();
  vrAgent.disconnect();
};

xr.pickAt = (ray) => (current ? pickAlong(ray, current) : null);

const voice = new VoiceAgent((text, kind) => {
  setStatus(text);
  xr.notify(text, kind);
}, async () => {
  const pose = xr.interactionPose();
  if (!pose) return undefined;
  return await queryDocument({ method: 'interaction_context', params: { ...pose, paint: xr.spray.log.summary() } }) as string;
});
xr.onTalk = (talking) => (talking ? voice.startRecording() : voice.stopRecording());

if (import.meta.env.DEV) {
  // Test hook: lets browser automation read renderer stats and drive the session.
  Object.assign(window, { __tako: { renderer, scene, camera, xr, current: () => current, document: () => activeDocument, tool: agent.call, voice, spray: xr.spray } });
}
