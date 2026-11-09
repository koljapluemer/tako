import { describe, expect, it } from 'vitest';
import { GROUP_PAUSE_MS, MAX_DOTS, PALETTE, PaintLog, type Stroke } from './paint-log';

const dot = (id: number, x = 0, y = 0, z = 0) => ({ id, point: [x, y, z] as [number, number, number], normal: [0, 0, 1] as [number, number, number] });

function stroke(log: PaintLog, now: number, ...ids: number[]): Stroke {
  const s = log.beginStroke(now)!;
  ids.forEach((id) => log.add(s, dot(id)));
  log.endStroke(s, now);
  return s;
}

describe('PaintLog colours', () => {
  it('keeps the colour across a short pause and changes it after a long one', () => {
    const log = new PaintLog();
    expect(stroke(log, 0, 1).color).toBe(0);
    expect(stroke(log, GROUP_PAUSE_MS, 1).color).toBe(0);
    expect(stroke(log, 2 * GROUP_PAUSE_MS + 1, 1).color).toBe(1);
  });

  it('does not change colour while another stroke is open', () => {
    const log = new PaintLog();
    const open = log.beginStroke(0)!;
    log.add(open, dot(1));
    expect(log.nextColor(GROUP_PAUSE_MS * 10)).toBe(open.color);
  });

  it('reuses a colour freed by undo, and carries on in it right after the undo', () => {
    const log = new PaintLog();
    stroke(log, 0, 1);
    stroke(log, 10_000, 2);
    log.undoStroke(20_000);
    expect(log.nextColor(20_100)).toBe(1);
    expect(log.nextColor(30_000)).toBe(1);
  });

  it('refuses a new stroke once every colour is taken', () => {
    const log = new PaintLog();
    PALETTE.forEach((_, i) => stroke(log, i * 10_000, 1));
    expect(log.nextColor(1_000_000)).toBeNull();
    expect(log.beginStroke(1_000_000)).toBeNull();
    log.undoStroke(1_000_000);
    expect(log.nextColor(2_000_000)).toBe(PALETTE.length - 1);
  });

  it('forgets a stroke that hit nothing', () => {
    const log = new PaintLog();
    stroke(log, 0, 1);
    stroke(log, 100);
    expect(log.strokes).toHaveLength(1);
  });
});

describe('PaintLog removal', () => {
  it('stops at the dot cap', () => {
    const log = new PaintLog();
    const s = log.beginStroke(0)!;
    for (let i = 0; i < MAX_DOTS; i++) expect(log.add(s, dot(1))).toBe(true);
    expect(log.add(s, dot(1))).toBe(false);
  });

  it('drops whole colours that touch a changed element and keeps the rest', () => {
    const log = new PaintLog();
    stroke(log, 0, 1);
    stroke(log, 100, 2);
    stroke(log, 10_000, 3);
    expect(log.dropColorsTouching([2])).toBe(true);
    expect(log.strokes.map((s) => s.color)).toEqual([1]);
    expect(log.dropColorsTouching([99])).toBe(false);
  });

  it('refuses dots for a stroke removed while it was open', () => {
    const log = new PaintLog();
    const s = log.beginStroke(0)!;
    log.clear();
    expect(log.add(s, dot(1))).toBe(false);
  });

  it('moves stored points', () => {
    const log = new PaintLog();
    const s = log.beginStroke(0)!;
    log.add(s, dot(1, 1, 2, 3));
    log.translate([1, 1, 1]);
    expect(s.dots[0].point).toEqual([2, 3, 4]);
  });
});

describe('PaintLog summary', () => {
  it('groups by colour then element, with a median centre that ignores strays', () => {
    const log = new PaintLog();
    const s = log.beginStroke(0)!;
    for (const x of [1, 2, 3, 4, 100]) log.add(s, dot(7, x));
    log.add(s, dot(8, 5));
    log.endStroke(s, 0);
    const [yellow] = log.summary();
    expect(yellow.color).toBe('yellow');
    expect(yellow.elements.map((e) => e.id)).toEqual([7, 8]);
    expect(yellow.elements[0]).toMatchObject({ dots: 5, center: [3, 0, 0], min: [1, 0, 0], max: [100, 0, 0] });
  });
});
