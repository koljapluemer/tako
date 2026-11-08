import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { IfcAPI } from 'web-ifc';

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

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// --- IFC loading ----------------------------------------------------------
const ifcApi = new IfcAPI();
ifcApi.SetWasmPath('/wasm/');
const ifcReady = ifcApi.Init(undefined, true); // single-threaded: no COOP/COEP headers needed

async function loadIfc(url: string): Promise<THREE.Group> {
  await ifcReady;

  setStatus('Downloading IFC…');
  const data = new Uint8Array(await (await fetch(url, { cache: 'no-store' })).arrayBuffer());

  setStatus('Parsing IFC…');
  const modelID = ifcApi.OpenModel(data, { COORDINATE_TO_ORIGIN: true });

  const group = new THREE.Group();
  const materials = new Map<string, THREE.MeshLambertMaterial>();
  const getMaterial = (c: { x: number; y: number; z: number; w: number }) => {
    const key = `${c.x},${c.y},${c.z},${c.w}`;
    let mat = materials.get(key);
    if (!mat) {
      mat = new THREE.MeshLambertMaterial({
        color: new THREE.Color(c.x, c.y, c.z),
        transparent: c.w < 1,
        opacity: c.w,
        side: THREE.DoubleSide,
        depthWrite: c.w >= 1,
      });
      materials.set(key, mat);
    }
    return mat;
  };

  ifcApi.StreamAllMeshes(modelID, (flatMesh) => {
    const placed = flatMesh.geometries;
    for (let i = 0; i < placed.size(); i++) {
      const pg = placed.get(i);
      const geom = ifcApi.GetGeometry(modelID, pg.geometryExpressID);
      // Vertex data is interleaved: [px, py, pz, nx, ny, nz] per vertex.
      const verts = ifcApi.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const indices = ifcApi.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      geom.delete();

      const interleaved = new THREE.InterleavedBuffer(new Float32Array(verts), 6);
      const bufferGeom = new THREE.BufferGeometry();
      bufferGeom.setAttribute('position', new THREE.InterleavedBufferAttribute(interleaved, 3, 0));
      bufferGeom.setAttribute('normal', new THREE.InterleavedBufferAttribute(interleaved, 3, 3));
      bufferGeom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));

      const mesh = new THREE.Mesh(bufferGeom, getMaterial(pg.color));
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(pg.flatTransformation);
      mesh.userData.expressID = flatMesh.expressID;
      group.add(mesh);
    }
  });

  ifcApi.CloseModel(modelID);
  return group;
}

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
let current: THREE.Group | null = null;
let loading = Promise.resolve();

function disposeModel(g: THREE.Group) {
  const mats = new Set<THREE.Material>();
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      mats.add(o.material as THREE.Material);
    }
  });
  mats.forEach((m) => m !== highlightMat && m.dispose());
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
    if (t > until || current !== model) {
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
      const model = await loadIfc('/model.ifc');
      scene.add(model);
      model.updateMatrixWorld(true);
      if (current) {
        scene.remove(current);
        disposeModel(current);
      }
      current = model;
      if (refocus) frameObject(model);
      if (change && change.changed.length) highlight(model, change.changed);
      const summary = change && change.summary.length > 140 ? `${change.summary.slice(0, 140)}…` : change?.summary;
      const label = change && change.rev > 0 ? `rev ${change.rev}: ${summary}` : `${model.children.length} meshes`;
      setStatus(label);
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
