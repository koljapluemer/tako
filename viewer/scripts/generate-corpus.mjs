// Writes synthetic IFC4 buildings to .corpus/: each one removes something real files often lack.
// Metres, Z up. Elements are extruded boxes, so wall gaps are geometric and need no opening elements.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.corpus', 'synthetic');
const STOREY_H = 3;
const SLAB_T = 0.2;
const WALL_T = 0.2;
const DOOR_W = 1;
const DOOR_H = 2.1;

class Step {
  lines = [];
  add(text) {
    this.lines.push(text);
    return `#${this.lines.length}`;
  }
  point([x, y, z]) { return this.add(`IFCCARTESIANPOINT((${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}))`); }
  point2([x, y]) { return this.add(`IFCCARTESIANPOINT((${x.toFixed(3)},${y.toFixed(3)}))`); }
  axis(p) { return this.add(`IFCAXIS2PLACEMENT3D(${this.point(p)},$,$)`); }
}

let guidCounter = 0;
const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
/** Deterministic, so regenerating the corpus keeps GlobalIds stable. */
function guid() {
  let n = ++guidCounter;
  let out = '';
  for (let i = 0; i < 22; i++) {
    out = GUID_CHARS[n % 64] + out;
    n = Math.floor(n / 64);
  }
  return `'${out}'`;
}

const box = (x0, y0, z0, x1, y1, z1) => ({ x0, y0, z0, x1, y1, z1 });

/** A plan is { storeys: [{ z, elements: [{ cls, name?, boxes }] }], loose: [elements], options }. */
function write({ storeys, loose = [] }, { contain = true, useStoreys = true } = {}) {
  guidCounter = 0;
  const s = new Step();
  const origin = s.axis([0, 0, 0]);
  const direction = s.add('IFCDIRECTION((0.,0.,1.))');
  const context = s.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,${origin},$)`);
  const length = s.add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const units = s.add(`IFCUNITASSIGNMENT((${length}))`);
  const project = s.add(`IFCPROJECT(${guid()},$,'Synthetic',$,$,$,$,(${context}),${units})`);
  const place = s.add(`IFCLOCALPLACEMENT($,${origin})`);
  const site = s.add(`IFCSITE(${guid()},$,'Site',$,$,${place},$,$,.ELEMENT.,$,$,$,$,$)`);
  const building = s.add(`IFCBUILDING(${guid()},$,'Building',$,$,${place},$,$,.ELEMENT.,$,$,$)`);
  s.add(`IFCRELAGGREGATES(${guid()},$,$,$,${project},(${site}))`);
  s.add(`IFCRELAGGREGATES(${guid()},$,$,$,${site},(${building}))`);

  const element = ({ cls, name = cls, boxes }) => {
    const solids = boxes.map(({ x0, y0, z0, x1, y1, z1 }) => {
      const centre = s.add(`IFCAXIS2PLACEMENT2D(${s.point2([(x0 + x1) / 2, (y0 + y1) / 2])},$)`);
      const profile = s.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${centre},${(x1 - x0).toFixed(3)},${(y1 - y0).toFixed(3)})`);
      return s.add(`IFCEXTRUDEDAREASOLID(${profile},${s.axis([0, 0, z0])},${direction},${(z1 - z0).toFixed(3)})`);
    });
    const body = s.add(`IFCSHAPEREPRESENTATION(${context},'Body','SweptSolid',(${solids.join(',')}))`);
    const shape = s.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${body}))`);
    const head = `${guid()},$,'${name}',$,$,${place},${shape},$`;
    const tail = { IFCDOOR: ',$,$,$,$,$', IFCSLAB: ',.FLOOR.', IFCSTAIRFLIGHT: ',$,$,$,$,.STRAIGHT.', IFCSPACE: ',$,$,.ELEMENT.,$', IFCBUILDINGELEMENTPROXY: ',$', IFCWALL: ',$', IFCFURNITURE: ',$' }[cls];
    if (tail == null) throw new Error(`no attribute tail for ${cls}`);
    return s.add(`${cls}(${head}${tail})`);
  };

  const storeyIds = [];
  storeys.forEach(({ z, elements }, index) => {
    const ids = elements.map(element);
    if (!useStoreys) return;
    const storey = s.add(`IFCBUILDINGSTOREY(${guid()},$,'Level ${index}',$,$,${place},$,$,.ELEMENT.,${z.toFixed(3)})`);
    storeyIds.push(storey);
    if (contain && ids.length) s.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},$,$,$,(${ids.join(',')}),${storey})`);
  });
  if (storeyIds.length) s.add(`IFCRELAGGREGATES(${guid()},$,$,$,${building},(${storeyIds.join(',')}))`);
  const looseIds = loose.map(element);
  if (contain && looseIds.length) s.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid()},$,$,$,(${looseIds.join(',')}),${building})`);

  const data = s.lines.map((line, i) => `#${i + 1}=${line};`).join('\n');
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'tako','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n${data}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/** Wall along X (`alongX`) or Y from a to b at `at`, with door gaps at the given centres. */
function wall(z, alongX, at, a, b, doors = [], height = STOREY_H - SLAB_T) {
  const span = (p, q, z0, z1) => (alongX
    ? box(p, at - WALL_T / 2, z0, q, at + WALL_T / 2, z1)
    : box(at - WALL_T / 2, p, z0, at + WALL_T / 2, q, z1));
  const boxes = [];
  let from = a;
  for (const c of [...doors].sort((m, n) => m - n)) {
    boxes.push(span(from, c - DOOR_W / 2, z, z + height));
    boxes.push(span(c - DOOR_W / 2, c + DOOR_W / 2, z + DOOR_H, z + height));
    from = c + DOOR_W / 2;
  }
  boxes.push(span(from, b, z, z + height));
  const out = [{ cls: 'IFCWALL', boxes }];
  for (const c of doors) {
    out.push({ cls: 'IFCDOOR', boxes: [span(c - DOOR_W / 2, c + DOOR_W / 2, z, z + DOOR_H)] });
  }
  return out;
}

/** cols x rows rooms off a central corridor along X. */
function floorPlan(z, { cols = 3, roomW = 5, roomD = 4, corridor = 2, floorCls = 'IFCSLAB', entrance = false, spaces = false, furniture = false, skip = null } = {}) {
  const width = cols * roomW;
  const depth = 2 * roomD + corridor;
  const y1 = roomD;
  const y2 = roomD + corridor;
  const slabs = skip
    ? [box(0, 0, z - SLAB_T, width, skip.y0, z), box(0, skip.y1, z - SLAB_T, width, depth, z), box(0, skip.y0, z - SLAB_T, skip.x0, skip.y1, z), box(skip.x1, skip.y0, z - SLAB_T, width, skip.y1, z)]
    : [box(0, 0, z - SLAB_T, width, depth, z)];
  const centres = Array.from({ length: cols }, (_, i) => (i + 0.5) * roomW);
  const elements = [
    { cls: floorCls, boxes: slabs },
    ...wall(z, true, 0, 0, width),
    ...wall(z, true, depth, 0, width),
    ...wall(z, false, 0, 0, depth, entrance ? [y1 + corridor / 2] : []),
    ...wall(z, false, width, 0, depth),
    ...wall(z, true, y1, 0, width, centres),
    ...wall(z, true, y2, 0, width, centres),
  ];
  for (let i = 1; i < cols; i++) {
    elements.push(...wall(z, false, i * roomW, 0, y1), ...wall(z, false, i * roomW, y2, depth));
  }
  if (furniture) {
    elements.push({ cls: 'IFCFURNITURE', name: 'Table', boxes: [box(1, 1, z, 3, 2, z + 0.75)] });
  }
  if (spaces) {
    centres.forEach((c, i) => {
      elements.push({ cls: 'IFCSPACE', name: `Room ${i}S`, boxes: [box(c - roomW / 2, 0, z, c + roomW / 2, y1, z + 2.5)] });
    });
  }
  return elements;
}

/** Straight flight along +X from (x, y), rising one storey. */
function stairs(x, y, z, width = 1.2) {
  const steps = 16;
  const rise = STOREY_H / steps;
  const going = 0.24;
  const boxes = Array.from({ length: steps }, (_, i) => box(x + i * going, y, z + i * rise, x + (i + 1) * going, y + width, z + (i + 1) * rise));
  return { cls: 'IFCSTAIRFLIGHT', boxes };
}

const levels = (n, make) => ({ storeys: Array.from({ length: n }, (_, i) => ({ z: i * STOREY_H, elements: make(i * STOREY_H, i) })) });
// The flight runs along one side of a wide corridor, between two doors, so it blocks neither.
const WIDE = 3.2;
const WELL = { x0: 8, x1: 12, y0: 4.1, y1: 5.4 };
const withStair = (options) => (z, i) => [
  ...floorPlan(z, { corridor: WIDE, entrance: i === 0, skip: i ? WELL : null, ...options }),
  ...(i === 0 ? [stairs(8.1, 4.15, z)] : []),
];

export const CASES = {
  'with-spaces': () => write(levels(2, withStair({ spaces: true }))),
  'no-spaces': () => write(levels(2, withStair({ furniture: true }))),
  'no-stairs': () => write(levels(2, (z, i) => floorPlan(z, { entrance: i === 0 }))),
  'proxy-floors': () => write(levels(2, withStair({ floorCls: 'IFCBUILDINGELEMENTPROXY' }))),
  atrium: () => write(levels(3, (z, i) => floorPlan(z, { cols: 5, entrance: i === 0, skip: i ? { x0: 8, x1: 17, y0: 1, y1: 9 } : null }))),
  'broken-relationships': () => write(levels(2, withStair({})), { contain: false, useStoreys: false }),
  large: () => write(levels(8, (z, i) => floorPlan(z, { cols: 40, entrance: i === 0 }))),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(OUT, { recursive: true });
  for (const [name, make] of Object.entries(CASES)) {
    const text = make();
    writeFileSync(join(OUT, `${name}.ifc`), text);
    console.log(`${name}.ifc ${(text.length / 1024).toFixed(0)} KB`);
  }
}
