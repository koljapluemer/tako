export type Vec3 = [number, number, number];
export type Dot = { point: Vec3; normal: Vec3; id: number };
export type Stroke = { color: number; dots: Dot[] };

export type PaintedElement = { id: number; dots: number; center: Vec3; min: Vec3; max: Vec3 };
export type PaintedColor = { color: string; elements: PaintedElement[] };

/** Named so the user can say them; neighbours differ strongly, and red and green are kept apart. */
export const PALETTE = [
  { name: 'yellow', hex: 0xffd400 },
  { name: 'blue', hex: 0x2f6bff },
  { name: 'red', hex: 0xe5172b },
  { name: 'pink', hex: 0xff4fd8 },
  { name: 'green', hex: 0x16c24a },
  { name: 'white', hex: 0xffffff },
];

export const MAX_DOTS = 5000;
/** A stroke starting later than this after the last one takes a new colour. */
export const GROUP_PAUSE_MS = 2000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Everything sprayed so far, and which colour comes next. */
export class PaintLog {
  strokes: Stroke[] = [];
  private open = new Set<Stroke>();
  private current: number | null = null;
  private lastEnded = -Infinity;

  get dotCount() {
    return this.strokes.reduce((sum, stroke) => sum + stroke.dots.length, 0);
  }

  /** The colour a stroke starting now would get; null when every colour is taken. */
  nextColor(now: number): number | null {
    if (this.current != null && (this.open.size > 0 || now - this.lastEnded <= GROUP_PAUSE_MS)) return this.current;
    const used = new Set(this.strokes.map((stroke) => stroke.color));
    const free = PALETTE.findIndex((_, color) => !used.has(color));
    return free < 0 ? null : free;
  }

  beginStroke(now: number): Stroke | null {
    const color = this.nextColor(now);
    if (color == null) return null;
    const stroke: Stroke = { color, dots: [] };
    this.strokes.push(stroke);
    this.open.add(stroke);
    this.current = color;
    return stroke;
  }

  /** False when the dot was refused: the paint is full, or the stroke has since been removed. */
  add(stroke: Stroke, dot: Dot): boolean {
    if (!this.open.has(stroke) || this.dotCount >= MAX_DOTS) return false;
    stroke.dots.push(dot);
    return true;
  }

  endStroke(stroke: Stroke, now: number) {
    if (!this.open.delete(stroke)) return;
    this.lastEnded = now;
    // A stroke that hit nothing shouldn't be what the next undo removes.
    if (!stroke.dots.length) this.strokes = this.strokes.filter((s) => s !== stroke);
  }

  /** The removed stroke's colour stays current briefly, so a redone stroke carries on in it. */
  undoStroke(now: number) {
    const stroke = this.strokes.pop();
    if (!stroke) return;
    this.open.delete(stroke);
    this.current = stroke.color;
    this.lastEnded = now;
  }

  clear() {
    this.strokes = [];
    this.open.clear();
    this.current = null;
    this.lastEnded = -Infinity;
  }

  /** Removes every colour with a dot on one of these elements. Returns whether anything went. */
  dropColorsTouching(ids: Iterable<number>): boolean {
    const touched = new Set(ids);
    const colors = new Set(this.strokes.filter((s) => s.dots.some((d) => touched.has(d.id))).map((s) => s.color));
    if (!colors.size) return false;
    for (const stroke of this.strokes) if (colors.has(stroke.color)) this.open.delete(stroke);
    this.strokes = this.strokes.filter((stroke) => !colors.has(stroke.color));
    if (this.current != null && colors.has(this.current)) this.current = null;
    return true;
  }

  translate([x, y, z]: Vec3) {
    for (const stroke of this.strokes) {
      for (const { point } of stroke.dots) {
        point[0] += x;
        point[1] += y;
        point[2] += z;
      }
    }
  }

  /** Per colour in palette order, then per element, most painted first. */
  summary(): PaintedColor[] {
    return PALETTE.flatMap(({ name }, color) => {
      const byElement = new Map<number, Vec3[]>();
      for (const stroke of this.strokes) {
        if (stroke.color !== color) continue;
        for (const { id, point } of stroke.dots) {
          const points = byElement.get(id);
          if (points) points.push(point);
          else byElement.set(id, [point]);
        }
      }
      if (!byElement.size) return [];
      const elements = [...byElement].map(([id, points]): PaintedElement => {
        const axis = (i: number) => points.map((point) => point[i]);
        const each = (pick: (values: number[]) => number): Vec3 => [pick(axis(0)), pick(axis(1)), pick(axis(2))];
        return {
          id, dots: points.length, center: each(median),
          min: each((values) => Math.min(...values)), max: each((values) => Math.max(...values)),
        };
      });
      return [{ color: name, elements: elements.sort((a, b) => b.dots - a.dots) }];
    });
  }
}
