import {
  IFCCOVERING, IFCDOOR, IFCDOORSTANDARDCASE, IFCFURNISHINGELEMENT, IFCFURNITURE, IFCOPENINGELEMENT, IFCOPENINGSTANDARDCASE,
  IFCRAMP, IFCRAMPFLIGHT, IFCSITE, IFCSLAB, IFCSLABELEMENTEDCASE, IFCSLABSTANDARDCASE,
  IFCSPACE, IFCSTAIR, IFCSTAIRFLIGHT, IFCSYSTEMFURNITUREELEMENT,
} from 'web-ifc';

/** How an element behaves for someone walking through the building. */
export type WalkClass = 'floor' | 'pass' | 'solid';

const FLOOR = new Set([
  IFCSLAB, IFCSLABSTANDARDCASE, IFCSLABELEMENTEDCASE, IFCSTAIR, IFCSTAIRFLIGHT, IFCRAMP, IFCRAMPFLIGHT, IFCSITE,
]);
const DOORS = new Set([IFCDOOR, IFCDOORSTANDARDCASE]);
const STAIRS = new Set([IFCSTAIR, IFCSTAIRFLIGHT]);
const SLABS = new Set([IFCSLAB, IFCSLABSTANDARDCASE, IFCSLABELEMENTEDCASE]);
const PASS = new Set([...DOORS, IFCOPENINGELEMENT, IFCOPENINGSTANDARDCASE, IFCSPACE]);

const FURNITURE = new Set([IFCFURNISHINGELEMENT, IFCFURNITURE, IFCSYSTEMFURNITUREELEMENT]);

export const isFurniture = (type: number) => FURNITURE.has(type);
export const isDoor = (type: number) => DOORS.has(type);
export const isStair = (type: number) => STAIRS.has(type);
export const isSlab = (type: number) => SLABS.has(type);

/** `predefinedType` is only consulted for coverings, where it separates floor finishes from the rest. */
export function classify(type: number, predefinedType: () => string | undefined): WalkClass {
  if (FLOOR.has(type)) return 'floor';
  if (PASS.has(type)) return 'pass';
  if (type === IFCCOVERING && predefinedType() === 'FLOORING') return 'floor';
  return 'solid';
}
