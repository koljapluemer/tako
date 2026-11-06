import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
const src = 'node_modules/web-ifc';
const dst = 'public/wasm';
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src).filter((f) => f.endsWith('.wasm'))) {
  copyFileSync(`${src}/${f}`, `${dst}/${f}`);
}
