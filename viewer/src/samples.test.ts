import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SAMPLES } from './samples';

it('lists exactly the files in public/samples', () => {
  const files = readdirSync(join(import.meta.dirname, '..', 'public', 'samples')).sort();
  expect(SAMPLES.map((sample) => sample.file).sort()).toEqual(files);
});
