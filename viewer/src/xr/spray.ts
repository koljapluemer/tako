import * as THREE from 'three';
import { MAX_DOTS, PALETTE, PaintLog, type Stroke, type Vec3 } from './paint-log';

const RADIUS = 0.05;
/** Keeps a disc off the surface it's on. */
const LIFT = 0.01;

const FACING = new THREE.Vector3(0, 0, 1);
const dummy = new THREE.Object3D();
const normal = new THREE.Vector3();
const color = new THREE.Color();

/** Paint as flat discs in world space, so it needs nothing from the model's meshes. */
export class Spray {
  readonly log = new PaintLog();
  private mesh = new THREE.InstancedMesh(
    new THREE.CircleGeometry(RADIUS, 8),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthWrite: false }),
    MAX_DOTS,
  );

  constructor(scene: THREE.Scene) {
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Writes no depth, so anything opaque drawn after it would paint straight over it.
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  private write(index: number, point: Vec3, faces: Vec3, palette: number) {
    normal.set(faces[0], faces[1], faces[2]);
    dummy.position.set(point[0], point[1], point[2]).addScaledVector(normal, LIFT);
    dummy.quaternion.setFromUnitVectors(FACING, normal);
    dummy.updateMatrix();
    this.mesh.setMatrixAt(index, dummy.matrix);
    this.mesh.setColorAt(index, color.setHex(PALETTE[palette].hex));
  }

  private uploaded() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  add(stroke: Stroke, point: Vec3, faces: Vec3, id: number): boolean {
    if (!this.log.add(stroke, { point, normal: faces, id })) return false;
    this.write(this.mesh.count++, point, faces, stroke.color);
    this.uploaded();
    return true;
  }

  private rebuild() {
    let index = 0;
    for (const stroke of this.log.strokes) {
      for (const dot of stroke.dots) this.write(index++, dot.point, dot.normal, stroke.color);
    }
    this.mesh.count = index;
    this.uploaded();
  }

  undo(now: number) {
    this.log.undoStroke(now);
    this.rebuild();
  }

  clear() {
    this.log.clear();
    this.mesh.count = 0;
  }

  dropColorsTouching(ids: number[]) {
    if (this.log.dropColorsTouching(ids)) this.rebuild();
  }

  translate(shift: THREE.Vector3) {
    this.log.translate([shift.x, shift.y, shift.z]);
    this.rebuild();
  }
}
