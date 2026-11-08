import * as THREE from 'three';

const raycaster = new THREE.Raycaster();

/** Flat world-space UI: the DOM doesn't exist in an immersive session. */
export class CanvasPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  readonly ctx: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;

  constructor(readonly width: number, readonly height: number, pixelsPerMetre = 1000) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * pixelsPerMetre);
    canvas.height = Math.round(height * pixelsPerMetre);
    this.ctx = canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 9000;
    this.mesh.visible = false;
  }

  get canvasWidth() {
    return this.ctx.canvas.width;
  }

  get canvasHeight() {
    return this.ctx.canvas.height;
  }

  refresh() {
    this.texture.needsUpdate = true;
  }

  /** Hit position in canvas pixels, or null. */
  hit(ray: THREE.Ray): { x: number; y: number } | null {
    if (!this.mesh.visible) return null;
    raycaster.ray.copy(ray);
    const uv = raycaster.intersectObject(this.mesh, false)[0]?.uv;
    return uv ? { x: uv.x * this.canvasWidth, y: (1 - uv.y) * this.canvasHeight } : null;
  }

  dispose() {
    this.texture.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
