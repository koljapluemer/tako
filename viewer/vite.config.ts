import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join, normalize, relative, sep } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';

const CORPUS = join(import.meta.dirname, '.corpus');

/** Dev only: lists the gitignored test corpus so a headset can load it from the LAN server. */
function corpus(): Plugin {
  return {
    name: 'tako-corpus',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__corpus', (req, res) => {
        const path = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '');
        if (!path) {
          const files = existsSync(CORPUS)
            ? readdirSync(CORPUS, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ifc')).map((f) => f.split(sep).join('/')).sort()
            : [];
          res.setHeader('content-type', 'application/json');
          return void res.end(JSON.stringify(files));
        }
        const file = normalize(join(CORPUS, path));
        if (relative(CORPUS, file).startsWith('..') || !existsSync(file)) {
          res.statusCode = 404;
          return void res.end();
        }
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  optimizeDeps: { exclude: ['web-ifc'] },
  // Started by `just vr-agent`; nginx does this job in production.
  // changeOrigin off: the speech service compares Host with Origin.
  server: { proxy: { '/api/transcribe': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
  // WebXR needs a secure context; a headset on the LAN cannot use localhost's exemption.
  plugins: [corpus(), ...(process.env.TAKO_HTTPS ? [basicSsl()] : [])],
});
