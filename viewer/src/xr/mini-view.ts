/** How the mini model maps any building into the space its station reserves. All results are model-space metres. */

export const LONGEST_SIDE = 0.55;
/** How far the model can rise from its base before it would reach the cards. */
export const MAX_HEIGHT = 0.42;

/** Metres to model, the same on every axis: the footprint and the height must both fit, so towers do too. */
export function fitScale(sizeX: number, sizeZ: number, height: number): number {
  return Math.min(LONGEST_SIDE / Math.max(sizeX, sizeZ, 1), MAX_HEIGHT / Math.max(height, 1));
}
