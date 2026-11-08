# Deploy the browser application

The production image is static. It contains the Vite build and `web-ifc` WASM,
served by nginx behind Caddy. It contains no model files, Python runtime, IFC
editing service, or application database.

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
