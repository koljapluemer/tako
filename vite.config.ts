import { defineConfig } from 'vite';

export default defineConfig({
  // web-ifc ships its own wasm loader; don't let Vite pre-bundle it.
  optimizeDeps: { exclude: ['web-ifc'] },
  assetsInclude: ['**/*.ifc'],
});
