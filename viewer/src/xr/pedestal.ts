import * as THREE from 'three';

/** Height of the table's top surface above the floor it stands on. */
export const TABLE_TOP = 0.94;
const TOP_THICKNESS = 0.025;
const COLUMN_RADIUS = 0.03;
const FOOT_RADIUS = 0.16;
const FOOT_HEIGHT = 0.012;
const RIM_WIDTH = 0.01;

/** Shaded by the scene's lights, like furniture rather than UI. */
export const tableMaterial = new THREE.MeshStandardMaterial({ color: 0x2b3036, roughness: 0.8, metalness: 0.1 });

/**
 * The table the mini model stands on. Its top fits the model shown on it, so a small
 * building doesn't sit on a big empty disc.
 */
export class Pedestal {
  readonly group = new THREE.Group();
  private top: THREE.Mesh;
  private rim: THREE.Mesh;
  private radius = 0;

  constructor(scene: THREE.Scene) {
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(FOOT_RADIUS, FOOT_RADIUS, FOOT_HEIGHT, 40).translate(0, FOOT_HEIGHT / 2, 0), tableMaterial);
    const columnHeight = TABLE_TOP - TOP_THICKNESS;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(COLUMN_RADIUS, COLUMN_RADIUS, columnHeight, 20).translate(0, columnHeight / 2, 0), tableMaterial);
    // Unit radius, scaled to fit; the thickness stays put.
    this.top = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, TOP_THICKNESS, 64).translate(0, TABLE_TOP - TOP_THICKNESS / 2, 0), tableMaterial);
    this.rim = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({ color: 0x35d0ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.rim.position.y = TABLE_TOP + 0.001;
    this.group.add(foot, column, this.top, this.rim);
    this.group.visible = false;
    scene.add(this.group);
  }

  open(position: THREE.Vector3, radius: number) {
    this.group.position.copy(position);
    this.setRadius(radius);
    this.group.visible = true;
  }

  close() {
    this.group.visible = false;
  }

  setRadius(radius: number) {
    if (radius === this.radius) return;
    this.radius = radius;
    this.top.scale.set(radius, 1, radius);
    this.rim.geometry.dispose();
    this.rim.geometry = new THREE.RingGeometry(radius - RIM_WIDTH, radius, 64).rotateX(-Math.PI / 2);
  }

  translate(shift: THREE.Vector3) {
    this.group.position.add(shift);
  }
}
