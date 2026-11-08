# Deploy the browser application

The production image is static. It contains the Vite build and `web-ifc` WASM,
served by nginx behind Caddy. It contains no model files, Python runtime, IFC
editing service, or application database.

## On the shared host

Use this when the host already runs a Caddy container that owns ports 80 and
443. Copy `deploy/.env.example` to `deploy/.env`, fill in the target, and run
`just deploy` to publish committed `HEAD`. Tako publishes no ports. `deploy/deploy.sh` builds
the image locally, loads it on the host, starts `deploy/compose.yaml` in `~/tako`
on Caddy's network, and on first run adds a site block to the shared Caddyfile
and reloads Caddy gracefully. Uncommitted changes are not deployed.

To roll back, set `TAKO_TAG` in `~/tako/.env` on the host to an earlier commit's
short hash and run `docker compose up -d` there. Earlier images stay on the host
until removed.

## On a dedicated host

Set `TAKO_DOMAIN` in `.env`, then run:

```sh
docker compose up -d --build
docker compose ps
```

Caddy terminates HTTPS, which WebXR and browser storage require. Each visitor
imports IFC files into that browser's OPFS and exports IFC backups explicitly.
Removing a container does not affect browser projects; clearing browser site
data does.

The desktop MCP bridge is not deployed. Claude Code starts it from `.mcp.json`,
and it accepts only a local browser origin. Remote or headset agent access needs
a future authenticated rendezvous/API adapter.

Before changing scheme, hostname, or port, export every project: browser storage
is isolated by origin. Roll back by checking out the previous revision and
rebuilding the image.
