import * as THREE from 'three';

/** Shared by every highlighted mesh, and never disposed with a model. */
export const highlightMaterial = new THREE.MeshLambertMaterial({
  color: 0xff8a1f, emissive: 0x7a3300, side: THREE.DoubleSide,
});

/**
 * The elements the latest edit touched, shown with a pulsing material until released.
 * Turning it off keeps track of the change (for the way back to it) but shows the normal materials.
 */
export class ChangeHighlight {
  private model: THREE.Group | null = null;
  private ids = new Set<number>();
  private hits: THREE.Mesh[] = [];
  private enabled = true;
  private releaseAt = Infinity;

  /** Returns the changed elements' bounds, or null when none of them has geometry. `releaseMs` null holds until `release`. */
  show(model: THREE.Group, ids: number[], releaseMs: number | null): THREE.Box3 | null {
    this.clear();
    this.model = model;
    this.ids = new Set(ids);
    this.releaseAt = releaseMs == null ? Infinity : performance.now() + releaseMs;
    const box = new THREE.Box3();
    model.updateMatrixWorld(true);
    this.each((mesh) => box.expandByObject(mesh));
    if (this.enabled) this.apply();
    return box.isEmpty() ? null : box;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.apply();
    else this.restore();
  }

  /** Ends the highlight after `ms`, unless it was due to end sooner. */
  release(ms: number) {
    this.releaseAt = Math.min(this.releaseAt, performance.now() + ms);
  }

  clear() {
    this.restore();
    this.model = null;
    this.ids.clear();
  }

  /** Call every frame. `current` is the model on screen; a highlight on any other is dropped. */
  update(now: number, current: THREE.Group | null) {
    if (!this.model) return;
    if (now > this.releaseAt || this.model !== current) return this.clear();
    highlightMaterial.emissiveIntensity = 0.6 + 0.4 * Math.sin(now / 150);
  }

  private each(visit: (mesh: THREE.Mesh) => void) {
    this.model?.traverse((o) => {
      if (o instanceof THREE.Mesh && this.ids.has(o.userData.expressID)) visit(o);
    });
  }

  private apply() {
    if (this.hits.length) return;
    this.each((mesh) => {
      mesh.userData.baseMaterial = mesh.material;
      mesh.material = highlightMaterial;
      this.hits.push(mesh);
    });
  }

  private restore() {
    for (const mesh of this.hits) mesh.material = mesh.userData.baseMaterial;
    this.hits = [];
  }
}
