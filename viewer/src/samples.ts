export type Sample = { name: string; path: string; url?: string };

/** Served from public/samples. The first one opens on a visit with no local projects. */
export const SAMPLES: Sample[] = [
  { name: 'AC20 Institute', path: 'AC20-Institute-Var-2.ifc' },
  { name: 'S Office', path: 'external/s-office-archi.ifc' },
  { name: 'Simple building (IFC 2x3)', path: 'external/bsi-arch-ifc2x3.ifc' },
  { name: 'Simple building (IFC 4.3)', path: 'external/bsi-arch-ifc4x3.ifc' },
];

/** Dev server only: adds the test corpus, see `just corpus`. */
export async function addCorpusSamples() {
  const files = await (await fetch('/__corpus')).json() as string[];
  SAMPLES.push(...files.map((path) => ({ name: `Corpus: ${path.replace(/\.ifc$/, '')}`, path, url: `/__corpus/${path}` })));
}

/** Also the name of the local project a sample becomes once opened. */
export const sampleFileName = (sample: Sample) => sample.path.split('/').pop()!;

export async function fetchSample(sample: Sample, progress: (message: string) => void): Promise<File> {
  progress(`Downloading ${sample.name}…`);
  const response = await fetch(sample.url ?? `${import.meta.env.BASE_URL}samples/${sample.path}`);
  if (!response.ok) throw new Error(`Could not download ${sample.name} (HTTP ${response.status})`);
  return new File([await response.blob()], sampleFileName(sample));
}
