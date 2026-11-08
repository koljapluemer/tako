import { beforeAll, describe, expect, it } from 'vitest';
import { corpusFiles, loadNavInput } from './corpus';
import { buildNavmesh, initNavmesh, splitComponents } from './navmesh';

const planArea = ({ positions: p }: { positions: Float32Array }) => {
  let area = 0;
  for (let i = 0; i < p.length; i += 9) area += Math.abs((p[i + 3] - p[i]) * (p[i + 8] - p[i + 2]) - (p[i + 6] - p[i]) * (p[i + 5] - p[i + 2])) / 2;
  return area;
};

describe('splitComponents', () => {
  it('separates disjoint triangles and puts the largest first', () => {
    const positions = [0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 0, 5, 9, 0, 5, 5, 0, 9];
    const parts = splitComponents(positions, [0, 1, 2, 3, 4, 5]);
    expect(parts).toHaveLength(2);
    expect(planArea(parts[0])).toBeGreaterThan(planArea(parts[1]));
  });
});

describe.skipIf(!corpusFiles().length)('navmesh on the corpus', () => {
  beforeAll(() => initNavmesh());

  it.each(corpusFiles())('%s has a substantial walkable area', async (file) => {
    const nav = buildNavmesh(await loadNavInput(file));
    expect(nav).not.toBeNull();
    expect(planArea(nav!.components[0])).toBeGreaterThan(10);
  }, 120000);

  it.each(corpusFiles().filter((f) => /no-spaces|proxy-floors|broken-relationships/.test(f)))('%s connects rooms through door thresholds', async (file) => {
    const nav = buildNavmesh(await loadNavInput(file))!;
    // Rooms and corridor only form one area if the door thresholds join them.
    expect(planArea(nav.components[0])).toBeGreaterThan(100);
    // The stair joins both levels into that same area.
    const ys = nav.components[0].positions.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(2.5);
  }, 120000);

  it('leaves furniture tops out', async () => {
    const input = await loadNavInput('synthetic/no-spaces.ifc'.replaceAll('/', corpusFiles()[0].includes('\\') ? '\\' : '/'));
    expect(input.furniture.length).toBeGreaterThan(0);
    const nav = buildNavmesh(input)!;
    const [{ min, max }] = input.furniture;
    for (const { positions: p } of nav.components) {
      for (let i = 0; i < p.length; i += 3) {
        const inside = p[i] > min[0] + 0.1 && p[i] < max[0] - 0.1 && p[i + 2] > min[2] + 0.1 && p[i + 2] < max[2] - 0.1;
        expect(inside && Math.abs(p[i + 1] - max[1]) < 0.1).toBe(false);
      }
    }
  }, 120000);
});
