import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { IfcAPI } from 'web-ifc';
import ifcUrl from '../example_data/AC20-Institute-Var-2.ifc?url';

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
async function loadIfc(url: string): Promise<THREE.Group> {
  const ifcApi = new IfcAPI();
  ifcApi.SetWasmPath('/wasm/');
  await ifcApi.Init(undefined, true); // single-threaded: no COOP/COEP headers needed

  setStatus('Downloading IFC…');
  const data = new Uint8Array(await (await fetch(url)).arrayBuffer());

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

loadIfc(ifcUrl)
  .then((model) => {
    scene.add(model);
    model.updateMatrixWorld(true);
    frameObject(model);
    setStatus(`Loaded ${model.children.length} meshes`);
  })
  .catch((err) => {
    console.error(err);
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
  });
