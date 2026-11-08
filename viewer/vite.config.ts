import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const workRoot = resolve(repoRoot, process.env.TAKO_WORKDIR ?? 'work');
const modelsDir = resolve(repoRoot, 'example_data');
const defaultModel = process.env.TAKO_MODEL ?? 'example_data/AC20-Institute-Var-2.ifc';
const selectedPath = join(workRoot, 'selected.json');

/** Must match tako_ifc_mcp.session.slug(). */
const slug = (rel: string) => rel.replace(/\.[^./]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_');

const readJson = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const selectedModel = (): string => readJson(selectedPath)?.model ?? defaultModel;
const modelWorkDir = (rel: string) => join(workRoot, slug(rel));

function listModels(dir = modelsDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listModels(p);
    return e.name.toLowerCase().endsWith('.ifc') ? [relative(repoRoot, p)] : [];
  }).sort();
}

/**
 * Serves the active model at /model.ifc (the MCP server's working copy when it
 * has one, else the pristine file) and pushes `tako:model` events over Vite's
 * HMR socket when the model is edited or a different model is selected.
 *
 * Selection lives in work/selected.json and is shared with the MCP server:
 * picking a model here makes the server switch on its next tool call, and
 * open_model on the server side moves the viewer.
 */
function takoModel(): Plugin {
  const changeFor = (rel: string) => readJson(join(modelWorkDir(rel), 'last_change.json'));
  return {
    name: 'tako-model',
    configureServer(server) {
      mkdirSync(workRoot, { recursive: true });
      let timer: NodeJS.Timeout | undefined;
      let lastSelected = selectedModel();
      /** kind 'selection': only notify if the active model actually changed. */
      const notify = (kind: 'selection' | 'edit') => {
        const rel = selectedModel();
        const switched = rel !== lastSelected;
        if (kind === 'selection' && !switched) return;
        lastSelected = rel;
        server.ws.send({ type: 'custom', event: 'tako:model', data: { model: rel, switched, change: changeFor(rel) } });
      };

      server.middlewares.use('/model.ifc', (_req, res) => {
        const rel = selectedModel();
        const working = join(modelWorkDir(rel), 'current.ifc');
        const path = existsSync(working) ? working : resolve(repoRoot, rel);
        if (!existsSync(path)) {
          res.statusCode = 404;
          return res.end(`model not found: ${rel}`);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(path).pipe(res);
      });

      server.middlewares.use('/model-change.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(changeFor(selectedModel())));
      });

      server.middlewares.use('/models.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ selected: selectedModel(), models: listModels() }));
      });

      server.middlewares.use('/select-model', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          return res.end();
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const rel = String(JSON.parse(body || '{}').model ?? '');
            if (!listModels().includes(rel)) {
              res.statusCode = 400;
              return res.end('unknown model');
            }
            mkdirSync(workRoot, { recursive: true });
            writeFileSync(selectedPath, JSON.stringify({ model: rel }));
            notify('selection');
            res.end('ok');
          } catch (err) {
            res.statusCode = 500;
            res.end(String(err));
          }
        });
      });

      // Watch the whole work root (files are replaced atomically, which breaks
      // per-file watchers). last_change.json is written after current.ifc.
      watch(workRoot, { recursive: true }, (_ev, name) => {
        if (!name) return;
        const isSelection = name === 'selected.json';
        const isActiveChange = name === join(slug(selectedModel()), 'last_change.json');
        if (!isSelection && !isActiveChange) return;
        clearTimeout(timer);
        timer = setTimeout(() => notify(isSelection ? 'selection' : 'edit'), 150);
      });
    },
  };
}

export default defineConfig({
  // web-ifc ships its own wasm loader; don't let Vite pre-bundle it.
  optimizeDeps: { exclude: ['web-ifc'] },
  // Edits to the working copies must not trigger a full page reload.
  server: { watch: { ignored: [`${workRoot}/**`] } },
  plugins: [takoModel()],
});
