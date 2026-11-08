import * as THREE from 'three';
import type { Sample } from '../samples';
import { formatAge, type Version, type VersionSource } from '../versions';
import { CanvasPanel } from './panel';

const RADIUS = 1.25;
const ANGLE_STEP = 0.3;
const CARD_W = 0.34;
const CARD_H = 0.21;
const DROP = 0.1;
const SLOTS = 5;
const WALK_AWAY = 1.4;

type Item = { title: string; detail: string; current: boolean; dim: boolean; run: () => void };

const centre = new THREE.Vector3();
const forward = new THREE.Vector3();
const head = new THREE.Vector3();

/** A world-locked, gravity-aligned row of cards for moving between versions. It stays open for A/B comparison. */
export class Arc {
  private cards: Array<{ panel: CanvasPanel; item: Item }> = [];
  private items: Item[] = [];
  private mode: 'versions' | 'buildings' = 'versions';
  private scroll = 0;
  private hovered = -1;
  private yaw = 0;
  private opened = false;
  private samples: Sample[] = [];
  private openSample: (sample: Sample) => void = () => {};
  source: VersionSource | null = null;

  constructor(private scene: THREE.Scene, private camera: THREE.Camera) {}

  setSamples(samples: Sample[], open: (sample: Sample) => void) {
    this.samples = samples;
    this.openSample = open;
  }

  get isOpen() {
    return this.opened;
  }

  /** The ray only chooses the direction: distance and height are fixed so the cards stay usable. */
  async open(ray: THREE.Ray) {
    this.camera.getWorldPosition(head);
    forward.copy(ray.direction).setY(0);
    if (forward.lengthSq() < 0.01) this.camera.getWorldDirection(forward).setY(0);
    this.yaw = Math.atan2(forward.x, forward.z);
    centre.set(head.x, head.y - DROP, head.z);
    this.opened = true;
    this.mode = 'versions';
    this.scroll = -1;
    await this.refresh();
  }

  close() {
    this.opened = false;
    this.clearCards();
  }

  toggle(ray: THREE.Ray) {
    if (this.opened) this.close();
    else void this.open(ray);
  }

  /** The list of versions, or which one is current, may have changed. */
  async refresh() {
    if (!this.opened) return;
    this.items = this.mode === 'versions' ? await this.versionItems() : this.buildingItems();
    if (!this.opened) return; // closed while the list was loading
    this.layout();
  }

  private async versionItems(): Promise<Item[]> {
    const versions = await this.source?.list().catch(() => [] as Version[]) ?? [];
    // Newest nearest the "Other buildings" end.
    const items = versions.map((version): Item => ({
      title: version.title,
      detail: formatAge(version.createdAt),
      current: version.current,
      dim: false,
      run: () => this.source?.select(version),
    }));
    if (this.scroll < 0) this.scroll = Math.max(0, versions.findIndex((v) => v.current) - 1);
    return [...items, this.navigationItem('Other buildings', 'buildings')];
  }

  private buildingItems(): Item[] {
    return [
      ...this.samples.map((sample): Item => ({ title: sample.name, detail: '', current: false, dim: false, run: () => this.openSample(sample) })),
      this.navigationItem('Revisions', 'versions'),
    ];
  }

  private navigationItem(title: string, mode: Arc['mode']): Item {
    return {
      title, detail: '', current: false, dim: true,
      run: () => {
        this.mode = mode;
        this.scroll = 0;
        void this.refresh();
      },
    };
  }

  private arrow(title: string, delta: number): Item {
    return {
      title, detail: '', current: false, dim: true,
      run: () => {
        this.scroll += delta;
        this.layout();
      },
    };
  }

  /** Arrows take a slot each, and only appear when there is something to scroll to. */
  private visibleItems(): Item[] {
    const { items } = this;
    if (items.length <= SLOTS) return items;
    this.scroll = Math.max(0, Math.min(this.scroll, items.length - 1));
    const before = this.scroll > 0 ? [this.arrow('‹', -(SLOTS - 2))] : [];
    const room = SLOTS - before.length;
    const fitsToEnd = this.scroll + room >= items.length;
    const shown = items.slice(this.scroll, this.scroll + (fitsToEnd ? room : room - 1));
    return fitsToEnd ? [...before, ...shown] : [...before, ...shown, this.arrow('›', shown.length)];
  }

  private clearCards() {
    for (const { panel } of this.cards) {
      this.scene.remove(panel.mesh);
      panel.dispose();
    }
    this.cards = [];
    this.hovered = -1;
  }

  private layout() {
    this.clearCards();
    const visible = this.visibleItems();
    visible.forEach((item, slot) => {
      const panel = new CanvasPanel(CARD_W, CARD_H);
      const angle = this.yaw + (slot - (visible.length - 1) / 2) * -ANGLE_STEP;
      panel.mesh.position.set(centre.x + Math.sin(angle) * RADIUS, centre.y, centre.z + Math.cos(angle) * RADIUS);
      panel.mesh.rotation.y = angle + Math.PI;
      panel.mesh.visible = true;
      panel.mesh.updateMatrixWorld(true);
      this.scene.add(panel.mesh);
      this.cards.push({ panel, item });
      this.draw(slot);
    });
  }

  private draw(slot: number) {
    const { panel, item } = this.cards[slot];
    const { ctx, canvasWidth: w, canvasHeight: h } = panel;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = slot === this.hovered ? 'rgba(40,70,90,0.95)' : 'rgba(20,22,26,0.92)';
    ctx.fillRect(0, 0, w, h);
    if (item.current) {
      ctx.fillStyle = '#35d0ff';
      ctx.fillRect(0, 0, w, 14);
    }
    ctx.textBaseline = 'middle';
    ctx.fillStyle = item.dim ? '#aab' : '#fff';
    ctx.font = '500 40px system-ui, sans-serif';
    this.wrap(ctx, item.title, 24, h * 0.34, w - 48);
    if (item.current || item.detail) {
      ctx.fillStyle = '#9ab';
      ctx.font = '400 30px system-ui, sans-serif';
      ctx.fillText([item.current ? 'Current' : '', item.detail].filter(Boolean).join(' · '), 24, h - 36, w - 48);
    }
    panel.refresh();
  }

  /** Two lines at most: titles are written by people and agents, so they can be any length. */
  private wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number) {
    const words = text.split(/\s+/);
    let first = '';
    while (words.length && ctx.measureText(`${first} ${words[0]}`.trim()).width <= width) first = `${first} ${words.shift()}`.trim();
    if (!words.length) return ctx.fillText(first, x, y + 20, width);
    ctx.fillText(first || words.shift()!, x, y - 6, width);
    ctx.fillText(words.join(' '), x, y + 44, width);
  }

  private slotAt(ray: THREE.Ray) {
    return this.cards.findIndex(({ panel }) => panel.hit(ray));
  }

  press(ray: THREE.Ray): boolean {
    const slot = this.slotAt(ray);
    if (slot < 0) return false;
    this.cards[slot].item.run();
    return true;
  }

  update(rays: THREE.Ray[]) {
    if (!this.opened) return;
    this.camera.getWorldPosition(head);
    if (Math.hypot(head.x - centre.x, head.z - centre.z) > WALK_AWAY) return this.close();
    const slot = rays.reduce((found, ray) => (found >= 0 ? found : this.slotAt(ray)), -1);
    if (slot === this.hovered) return;
    const before = this.hovered;
    this.hovered = slot;
    if (before >= 0) this.draw(before);
    if (slot >= 0) this.draw(slot);
  }
}
