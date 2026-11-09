import * as THREE from 'three';
import type { Sample } from '../samples';
import { formatAge, type Version, type VersionSource } from '../versions';
import { CanvasPanel, type LimitedRay } from './panel';

export const ARC_RADIUS = 1.25;
export const ARC_ANGLE_STEP = 0.3;
export const ARC_SLOTS = 5;
const CARD_W = 0.34;
const CARD_H = 0.21;

type Item = { title: string; detail: string; current: boolean; dim: boolean; run: () => void };

/** A world-locked, gravity-aligned row of cards for moving between versions or buildings. */
export class Arc {
  private cards: Array<{ panel: CanvasPanel; item: Item }> = [];
  private items: Item[] = [];
  private mode: 'versions' | 'buildings' = 'versions';
  private scroll = 0;
  private hovered = -1;
  private yaw = 0;
  private centre = new THREE.Vector3();
  private opened = false;
  private samples: Sample[] = [];
  private openSample: (sample: Sample) => void = () => {};
  source: VersionSource | null = null;

  constructor(private scene: THREE.Scene) {}

  setSamples(samples: Sample[], open: (sample: Sample) => void) {
    this.samples = samples;
    this.openSample = open;
  }

  get showingBuildings() {
    return this.mode === 'buildings';
  }

  /** The cards curve around `centre`, spread either side of `yaw`. */
  async open(centre: THREE.Vector3, yaw: number) {
    this.centre.copy(centre);
    this.yaw = yaw;
    this.opened = true;
    await this.showVersions();
  }

  close() {
    this.opened = false;
    this.clearCards();
  }

  showVersions() {
    this.mode = 'versions';
    this.scroll = -1;
    return this.refresh();
  }

  showBuildings() {
    this.mode = 'buildings';
    this.scroll = 0;
    return this.refresh();
  }

  translate(shift: THREE.Vector3) {
    this.centre.add(shift);
    for (const { panel } of this.cards) {
      panel.mesh.position.add(shift);
      panel.mesh.updateMatrixWorld(true);
    }
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
    const items = versions.map((version): Item => ({
      title: version.title,
      detail: formatAge(version.createdAt),
      current: version.current,
      dim: false,
      run: () => this.source?.select(version),
    }));
    if (this.scroll < 0) this.scroll = Math.max(0, versions.findIndex((v) => v.current) - 1);
    return items;
  }

  private buildingItems(): Item[] {
    return this.samples.map((sample): Item => ({ title: sample.name, detail: '', current: false, dim: false, run: () => this.openSample(sample) }));
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
    if (items.length <= ARC_SLOTS) return items;
    this.scroll = Math.max(0, Math.min(this.scroll, items.length - 1));
    const before = this.scroll > 0 ? [this.arrow('‹', -(ARC_SLOTS - 2))] : [];
    const room = ARC_SLOTS - before.length;
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
    const { centre } = this;
    visible.forEach((item, slot) => {
      const panel = new CanvasPanel(CARD_W, CARD_H, { depthTest: true });
      const angle = this.yaw + (slot - (visible.length - 1) / 2) * -ARC_ANGLE_STEP;
      panel.mesh.position.set(centre.x + Math.sin(angle) * ARC_RADIUS, centre.y, centre.z + Math.cos(angle) * ARC_RADIUS);
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

  private slotAt({ ray, far }: LimitedRay) {
    return this.cards.findIndex(({ panel }) => panel.hit(ray, far));
  }

  press(pick: LimitedRay): boolean {
    const slot = this.slotAt(pick);
    if (slot < 0) return false;
    this.cards[slot].item.run();
    return true;
  }

  update(picks: LimitedRay[]) {
    if (!this.opened) return;
    const slot = picks.reduce((found, pick) => (found >= 0 ? found : this.slotAt(pick)), -1);
    if (slot === this.hovered) return;
    const before = this.hovered;
    this.hovered = slot;
    if (before >= 0) this.draw(before);
    if (slot >= 0) this.draw(slot);
  }
}
