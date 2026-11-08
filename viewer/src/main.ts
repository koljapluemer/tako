import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadModel, type LoadedModel } from './model';
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

function reload(change: ModelChange, refocus: boolean) {
  // Serialise loads so rapid edits don't race.
  loading = loading.then(async () => {
    setStatus(change ? `Loading rev ${change.rev}…` : 'Loading…');
    try {
      const model = await loadModel('/model.ifc', change?.changed ?? [], setStatus);
      await xr.swap(() => {
        const previous = current;
        scene.add(model.group);
        model.group.updateMatrixWorld(true);
        current = model;
        xr.setModel(model, refocus);
        if (previous) {
          scene.remove(previous.group);
          disposeModel(previous);
        }
      });
      if (refocus && !xr.presenting) frameObject(model.group);
      if (change && change.changed.length) highlight(model.group, change.changed);
      const summary = change && change.summary.length > 140 ? `${change.summary.slice(0, 140)}…` : change?.summary;
      const label = change && change.rev > 0 ? `rev ${change.rev}: ${summary}` : `${model.group.children.length} draw groups`;
      setStatus(model.collision.hasFloor ? label : `${label}. No floor elements found, so VR teleport is unavailable`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

// --- model picker -----------------------------------------------------------
const picker = document.getElementById('model') as HTMLSelectElement;

async function refreshPicker() {
  const { selected, models } = (await (await fetch('/models.json', { cache: 'no-store' })).json()) as {
    selected: string;
    models: string[];
  };
  picker.replaceChildren(
    ...models.map((m) => new Option(m.replace(/^example_data\//, ''), m, false, m === selected)),
  );
  return selected;
}

picker.addEventListener('change', () => {
  picker.disabled = true;
  fetch('/select-model', { method: 'POST', body: JSON.stringify({ model: picker.value }) })
    .finally(() => (picker.disabled = false));
  // The server's file watcher answers with a tako:model event that triggers the load.
});

refreshPicker()
  .then(() => fetch('/model-change.json', { cache: 'no-store' }))
  .then((r) => r.json() as Promise<ModelChange>)
  .catch(() => null)
  .then((change) => reload(change && { ...change, changed: [] }, true));

if (import.meta.hot) {
  import.meta.hot.on('tako:model', (msg: { model: string; switched: boolean; change: ModelChange }) => {
    if (msg.switched) {
      picker.value = msg.model;
      reload(msg.change && { ...msg.change, changed: [] }, true);
    } else {
      reload(msg.change, false);
    }
  });
}

if (import.meta.env.DEV) {
  // Test hook: lets browser automation read renderer stats and drive the session.
  Object.assign(window, { __tako: { renderer, scene, camera, xr, current: () => current } });
}
