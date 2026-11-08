/** Provisional until measured on a headset: see doc/vr-headset-checklist.md. */
export const CELL_SIZE_XZ = 12;
export const CELL_SIZE_Y = 4;

/** Spatial bucket of a chunk's bounding-box centre. Geometry only, so it works without storey data. */
export function cellKey(positions: Float32Array): string {
  let [minX, minY, minZ] = [Infinity, Infinity, Infinity];
  let [maxX, maxY, maxZ] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
  }
  const bucket = (min: number, max: number, size: number) => Math.floor((min + max) / 2 / size);
  return `${bucket(minX, maxX, CELL_SIZE_XZ)},${bucket(minY, maxY, CELL_SIZE_Y)},${bucket(minZ, maxZ, CELL_SIZE_XZ)}`;
}
