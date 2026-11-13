import * as THREE from 'three';

const RADIUS = 0.02;
const LENGTH = 0.1;

/**
 * A spray can on the controller, so the held tool can be seen at a glance. Built from primitives:
 * it lies along the pointing ray with the nozzle at the ray's origin, and its band shows the next colour.
 */
export class SprayCan {
  readonly group = new THREE.Group();
  private band = new THREE.MeshLambertMaterial({ color: 0xffffff });

  constructor() {
    const metal = new THREE.MeshLambertMaterial({ color: 0xb8bec6 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
    // Cylinders are made along Y; the can's axis is the ray's Z, pointing back from the nozzle.
    const along = (geometry: THREE.BufferGeometry, z: number) => geometry.rotateX(Math.PI / 2).translate(0, 0, z);
    const body = new THREE.Mesh(along(new THREE.CylinderGeometry(RADIUS, RADIUS, LENGTH, 20), 0.02 + LENGTH / 2), metal);
    const band = new THREE.Mesh(along(new THREE.CylinderGeometry(RADIUS * 1.04, RADIUS * 1.04, LENGTH * 0.4, 20), 0.02 + LENGTH / 2), this.band);
    const shoulder = new THREE.Mesh(along(new THREE.CylinderGeometry(RADIUS * 0.6, RADIUS, 0.012, 20), 0.014), metal);
    const cap = new THREE.Mesh(along(new THREE.CylinderGeometry(RADIUS * 0.45, RADIUS * 0.45, 0.012, 16), 0.002), dark);
    this.group.add(body, band, shoulder, cap);
    // Below the ray, so the beam and tip stay visible above it.
    this.group.position.y = -0.03;
    this.group.visible = false;
  }

  update(visible: boolean, color: number) {
    this.group.visible = visible;
    if (visible) this.band.color.setHex(color);
  }
}
