export type Sample = { name: string; file: string };

/** Exactly the files in public/samples; samples.test.ts enforces that. The first one opens on a first visit. */
export const SAMPLES: Sample[] = [
  { name: 'AC20 Institute', file: 'AC20-Institute-Var-2.ifc' },
  { name: 'S Office', file: 's-office-archi.ifc' },
  { name: 'Simple building (IFC 2x3)', file: 'bsi-arch-ifc2x3.ifc' },
  { name: 'Duplex (IFC 2x3)', file: 'Ifc2x3_Duplex_Architecture.ifc' },
];

export async function fetchSample(sample: Sample, progress: (message: string) => void): Promise<File> {
  progress(`Downloading ${sample.name}…`);
  const response = await fetch(`${import.meta.env.BASE_URL}samples/${sample.file}`);
  if (!response.ok) throw new Error(`Could not download ${sample.name} (HTTP ${response.status})`);
  return new File([await response.blob()], sample.file);
}
