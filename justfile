# tako: browser-owned IFC editor + stateless TypeScript MCP bridge

set shell := ["bash", "-euo", "pipefail", "-c"]

port := env_var_or_default("TAKO_PORT", "5173")

# List recipes
default:
    @just --list

# Everything: install if needed, start the viewer in the background, open Claude in the foreground
up: setup
    #!/usr/bin/env bash
    set -euo pipefail
    (cd viewer && exec ./node_modules/.bin/vite --port {{port}} --strictPort > ../work/viewer.log 2>&1) &
    viewer_pid=$!
    trap 'kill $viewer_pid 2>/dev/null || true' EXIT
    for _ in $(seq 1 40); do curl -sf -o /dev/null localhost:{{port}}/ && break; sleep 0.25; done
    echo "viewer: http://localhost:{{port}}  (log: work/viewer.log)"
    command -v xdg-open >/dev/null && xdg-open "http://localhost:{{port}}" >/dev/null 2>&1 || true
    claude

# Install browser and bridge dependencies
setup:
    @[ -d viewer/node_modules ] || (cd viewer && npm ci)
    @[ -d bridge/node_modules ] || (cd bridge && npm ci)
    @cd bridge && npm run build --silent

# Viewer dev server only (foreground)
viewer: setup
    cd viewer && npx vite --port {{port}} --strictPort

# Viewer over HTTPS on the LAN, for opening in a headset (WebXR needs a secure context)
vr: setup
    cd viewer && TAKO_HTTPS=1 npx vite --host --port {{port}} --strictPort

# Claude Code with the tako-ifc MCP server (start `just viewer` separately)
chat: setup
    claude

# Download the external test models into viewer/public/samples/external (skips existing files)
fetch-models:
    #!/usr/bin/env bash
    set -euo pipefail
    dir=viewer/public/samples/external
    mkdir -p "$dir"
    bsi="https://raw.githubusercontent.com/buildingSMART/Sample-Test-Files/main"
    fetch() { [ -s "$dir/$1" ] || { echo "downloading $1"; curl -sfL "$2" -o "$dir/$1"; }; }
    fetch bsi-arch-ifc2x3.ifc "$bsi/IFC%202.3.0.1%20(IFC%202x3%20TC1)/Simple-Scene/Building-Architecture.ifc"
    fetch bsi-arch-ifc4x3.ifc "$bsi/IFC%204.3.2.0%20(IFC%204.3%20ADD2)/Simple-Scene/Building-Architecture.ifc"
    fetch s-office-archi.ifc "https://raw.githubusercontent.com/ThatOpen/engine_web-ifc/main/tests/ifcfiles/public/S_Office_Integrated%20Design%20Archi.ifc"

# Typecheck and build the browser plus the stateless MCP bridge
check: setup
    cd viewer && npm run build
    cd bridge && npm run check
    @echo ok

# Production build of the viewer
build: setup
    cd viewer && npm run build

# Deploy committed HEAD to the shared host (see doc/deployment.md)
deploy:
    bash deploy/deploy.sh
