import * as THREE from 'three';

type Animation = { from: number; to: number; start: number; ms: number; done: () => void };

/**
 * One view-locked black shell. WebXR has no compositor fade, and several things
 * want darkness at once (teleport, head in a wall, reload), so each owns a
 * channel and the darkest channel wins.
 */
export class Fade {
  private levels = new Map<string, number>();
  private animations = new Map<string, Animation>();
  private shell: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private hint: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor(camera: THREE.Camera) {
    this.shell = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    );
    this.shell.renderOrder = 10000;
    this.shell.frustumCulled = false;
    this.shell.visible = false;
    camera.add(this.shell);

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.font = '600 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Step back', 256, 64);
    this.hint = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.125),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, opacity: 0, depthTest: false, depthWrite: false }),
    );
    this.hint.position.z = -0.28;
    this.hint.scale.setScalar(0.3);
    this.hint.renderOrder = 10001;
    this.hint.frustumCulled = false;
    this.hint.visible = false;
    camera.add(this.hint);
  }

  set(channel: string, level: number) {
    this.levels.set(channel, level);
  }

  /** Resolves when the channel reaches `level`. */
  to(channel: string, level: number, ms: number): Promise<void> {
    this.finish(channel);
    return new Promise((done) => {
      this.animations.set(channel, { from: this.levels.get(channel) ?? 0, to: level, start: performance.now(), ms, done });
    });
  }

  private finish(channel: string) {
    const a = this.animations.get(channel);
    if (!a) return;
    this.animations.delete(channel);
    this.levels.set(channel, a.to);
    a.done();
  }

  showHint(opacity: number) {
    this.hint.material.opacity = opacity;
    this.hint.visible = opacity > 0.01;
  }

  update(now: number) {
    for (const [channel, a] of [...this.animations]) {
      const t = a.ms <= 0 ? 1 : (now - a.start) / a.ms;
      if (t >= 1) this.finish(channel);
      else this.levels.set(channel, a.from + (a.to - a.from) * t);
    }
    const level = Math.max(0, ...this.levels.values());
    this.shell.material.opacity = level;
    this.shell.visible = level > 0.001;
  }

  /** The render loop stops with the session, so anything still waiting must be released. */
  reset() {
    [...this.animations.keys()].forEach((c) => this.finish(c));
    this.levels.clear();
    this.update(performance.now());
    this.showHint(0);
  }
}
