import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as WebIFC from 'web-ifc';
import { classify, isDoor, isFurniture } from '../ifc-classes';
import { boundsOf, type NavInput } from './navmesh';

const ROOT = join(import.meta.dirname, '..', '..', '.corpus');

/** Empty until `just corpus` has run. */
export const corpusFiles = () => (existsSync(ROOT)
  ? readdirSync(ROOT, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ifc')).sort()
  : []);

let api: WebIFC.IfcAPI | null = null;

/** The worker's geometry path, reduced to what navigation needs. */
export async function loadNavInput(file: string): Promise<NavInput> {
  if (!api) {
    api = new WebIFC.IfcAPI();
    await api.Init();
  }
  const model = api.OpenModel(new Uint8Array(readFileSync(join(ROOT, file))), { COORDINATE_TO_ORIGIN: true });
  const positions: number[] = [];
  const indices: number[] = [];
  const doors: NavInput['doors'] = [];
  const furniture: NavInput['furniture'] = [];
  const ifc = api;
  ifc.StreamAllMeshes(model, (mesh) => {
    const type = ifc.GetLineType(model, mesh.expressID);
    const walk = classify(type, () => ifc.GetLine(model, mesh.expressID).PredefinedType?.value);
    for (let i = 0; i < mesh.geometries.size(); i++) {
      const placed = mesh.geometries.get(i);
      const geometry = ifc.GetGeometry(model, placed.geometryExpressID);
      const vertices = ifc.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
      const faces = ifc.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
      const m = placed.flatTransformation;
      const baked = new Float32Array((vertices.length / 6) * 3);
      for (let v = 0; v < vertices.length / 6; v++) {
        const [x, y, z] = [vertices[v * 6], vertices[v * 6 + 1], vertices[v * 6 + 2]];
        baked.set([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]], v * 3);
      }
      geometry.delete();
      if (isDoor(type)) doors.push(boundsOf(baked));
      if (isFurniture(type)) furniture.push(boundsOf(baked));
      if (walk === 'pass') continue;
      const base = positions.length / 3;
      for (const value of baked) positions.push(value);
      for (const face of faces) indices.push(face + base);
    }
  });
  ifc.CloseModel(model);
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), doors, furniture };
}
