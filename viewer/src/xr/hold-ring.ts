import * as THREE from 'three';

const INNER = 0.011;
const OUTER = 0.015;
const SEGMENTS = 64;
const INDICES_PER_SEGMENT = 6;

/** View-locked ring that fills clockwise from the top while a button is held. */
export class HoldRing {
  private group = new THREE.Group();
  private fill: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;

  constructor(camera: THREE.Camera) {
    const track = this.mesh(new THREE.RingGeometry(INNER, OUTER, SEGMENTS), 0.25);
    this.fill = this.mesh(new THREE.RingGeometry(INNER, OUTER, SEGMENTS, 1, Math.PI / 2, -Math.PI * 2), 1);
    this.fill.renderOrder += 1;
    this.group.add(track, this.fill);
    this.group.position.z = -0.28; // inside the fade shell, like its hint
    this.group.visible = false;
    camera.add(this.group);
  }

  private mesh(geometry: THREE.RingGeometry, opacity: number) {
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 10002;
    mesh.frustumCulled = false;
    return mesh;
  }

  /** 0 hides the ring. */
  set(progress: number) {
    this.group.visible = progress > 0;
    this.fill.geometry.setDrawRange(0, Math.ceil(progress * SEGMENTS) * INDICES_PER_SEGMENT);
  }
}
