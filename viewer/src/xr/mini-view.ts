/** How the mini model maps any building into the space its station reserves. All results are model-space metres. */

export const LONGEST_SIDE = 0.55;
export const WALL_HEIGHT_M = 2.2;
/** Tallest the building may be with its floors together, leaving room to pull them apart. */
const ASSEMBLED_MAX = 0.5;
export const MAX_STACK = 0.85;
/** How far the stack can rise from its base before it would reach the cards. */
export const ROOM_ABOVE = 0.42;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const span = (levelYs: number[]) => (levelYs.length ? levelYs[levelYs.length - 1] - levelYs[0] : 0);

/** Metres to model: the footprint and the height must both fit, so towers do too. */
export function fitScale(sizeX: number, sizeZ: number, heightSpan: number): number {
  return Math.min(LONGEST_SIDE / Math.max(sizeX, sizeZ, 1), ASSEMBLED_MAX / Math.max(heightSpan + WALL_HEIGHT_M, 1));
}

export function assembledHeight(levelYs: number[], scale: number): number {
  return (span(levelYs) + WALL_HEIGHT_M) * scale;
}

/** Each level's height in the model. `spread` 0 keeps true storey heights, 1 fills `MAX_STACK`. Levels ascend. */
export function levelOffsets(levelYs: number[], scale: number, spread: number): number[] {
  const steps = levelYs.length - 1;
  const extra = steps > 0 ? (clamp01(spread) * Math.max(0, MAX_STACK - assembledHeight(levelYs, scale))) / steps : 0;
  return levelYs.map((y, i) => (y - levelYs[0]) * scale + i * extra);
}

export function stackHeight(offsets: number[], scale: number): number {
  return (offsets[offsets.length - 1] ?? 0) + WALL_HEIGHT_M * scale;
}

/** A tall stack extends downward rather than rising into the cards. */
export function stackDrop(height: number): number {
  return Math.max(0, height - ROOM_ABOVE);
}
