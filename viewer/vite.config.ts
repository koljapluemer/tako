import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['web-ifc'] },
  // WebXR needs a secure context; a headset on the LAN cannot use localhost's exemption.
  plugins: process.env.TAKO_HTTPS ? [basicSsl()] : [],
});
