import { beforeAll, describe, expect, it } from 'vitest';
import { corpusFiles, loadNavInput } from './corpus';
import { buildNavmesh, initNavmesh, type NavInput } from './navmesh';
import { generatePoints, stabilise, type NavDoor, type NavPoint, type PointsInput } from './points';

const point = (over: Partial<NavPoint>): NavPoint => ({ id: 'a', name: 'A', type: 'room', position: [0, 0, 0], yaw: 0, level: 0, importance: 1, anchor: null, ...over });

describe('stabilise', () => {
  it('keeps a nearby point in place', () => {
    const [out] = stabilise([point({ id: 'old', name: 'Old', position: [1, 0, 1] })], [point({ id: 'new', position: [1.5, 0, 1] })], () => true);
    expect(out).toMatchObject({ id: 'old', name: 'Old', position: [1, 0, 1] });
  });

  it('moves when the old spot is gone', () => {
    const [out] = stabilise([point({ id: 'old', position: [1, 0, 1] })], [point({ position: [1.5, 0, 1] })], () => false);
    expect(out).toMatchObject({ id: 'old', position: [1.5, 0, 1] });
  });

  it('lets a door follow its element', () => {
    const [out] = stabilise([point({ id: 'g', anchor: 'g', type: 'door', position: [1, 0, 1] })], [point({ id: 'g', anchor: 'g', type: 'door', position: [9, 0, 1] })], () => true);
    expect(out.position).toEqual([9, 0, 1]);
  });
});

const files = corpusFiles();

const inputFor = async (file: string): Promise<PointsInput> => {
  const input: NavInput = await loadNavInput(file);
  const nav = buildNavmesh(input)!;
  const doors: NavDoor[] = input.doors.map((bounds, i) => ({ bounds, globalId: `door-${i}`, exterior: false }));
  return { components: nav.components, doors, spaces: [], storeys: [] };
};

describe.skipIf(!files.length)('navigation points on the corpus', () => {
  beforeAll(() => initNavmesh());

  it.each(files)('%s gives named, spread-out points on every level', async (file) => {
    const { points, levels } = generatePoints(await inputFor(file));
    expect(levels.length).toBeGreaterThan(0);
    levels.forEach((_, level) => expect(points.some((p) => p.level === level)).toBe(true));
    for (const p of points) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(Number.isFinite(p.yaw)).toBe(true);
    }
    const optional = points.filter((p) => p.type !== 'entrance' && p.type !== 'stair');
    for (const a of optional) {
      for (const b of optional) {
        if (a !== b && a.level === b.level) expect(Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2])).toBeGreaterThan(0.3);
      }
    }
  }, 240000);

  it.each(files.filter((f) => f.includes('synthetic') && !f.includes('large')))('%s is deterministic', async (file) => {
    const input = await inputFor(file);
    expect(generatePoints(input)).toEqual(generatePoints(input));
  }, 240000);

  it.each(files.filter((f) => /no-spaces|proxy-floors|broken-relationships/.test(f)))('%s finds the entrance and both stair ends', async (file) => {
    const { points, levels } = generatePoints(await inputFor(file));
    expect(levels).toHaveLength(2);
    expect(points.some((p) => p.type === 'entrance')).toBe(true);
    expect(new Set(points.filter((p) => p.type === 'stair').map((p) => p.level)).size).toBe(2);
  }, 240000);
});
