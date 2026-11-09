import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['web-ifc'] },
  // Started by `just vr-agent`; nginx does this job in production.
  // changeOrigin off: the speech service compares Host with Origin.
  server: { proxy: { '/api/transcribe': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
  // WebXR needs a secure context; a headset on the LAN cannot use localhost's exemption.
  plugins: process.env.TAKO_HTTPS ? [basicSsl()] : [],
});
