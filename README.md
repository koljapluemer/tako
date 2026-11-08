# tako

Proof of concept: edit IFC building models from a Claude chat ("make the north
wall concrete", "make the main door wider") and watch the result in a browser
viewer.

```
viewer/   three.js + web-ifc viewer (Vite). Model picker, live reload, change highlight.
server/   Python MCP server (IfcOpenShell). Resolves spatial references, applies edits.
example_data/          IFC models (anything *.ifc in here shows up in the picker)
work/                  working copies + revision history per model (gitignored)
.mcp.json              registers the MCP server with Claude Code
```

## Run

Needs [just](https://github.com/casey/just), [uv](https://docs.astral.sh/uv/), Node and the `claude` CLI.

```sh
just up        # install if needed, start the viewer (http://localhost:5173), open Claude
```

On first start, approve the project's `tako-ifc` MCP server in Claude. Quitting
Claude also stops the viewer. Other recipes (`just --list`):

| Recipe | What it does |
|---|---|
| `just viewer` / `just chat` | Run the viewer and Claude separately, e.g. in two terminals |
| `just fetch-models` | Download the external test models (already part of `setup`) |
| `just check` | Typecheck the viewer and run the server tests |
| `just bench` | Benchmark edits through the Claude CLI (uses your plan's usage) |
| `just reset` | Discard all edits and revision history |
| `TAKO_PORT=5200 just up` | Use a different viewer port |

Then ask Claude things like *"change the material of the north wall to concrete"*
or *"make the main door 30 cm wider"*. The viewer reloads and highlights what
changed. *"undo that"* reverts it.

## Walk through it in VR

The viewer has an **Enter VR** button on any WebXR headset. WebXR needs a secure
context, so run `just vr` and open `https://<this machine's IP>:5173` in the
headset, accepting the self-signed certificate. On Quest, `adb reverse tcp:5173 tcp:5173`
with `just viewer` works too. `just vr` exposes the viewer, including its
`/select-model` endpoint, to your LAN.

- **Walk:** physically. Floors and stairs are followed as you go. Walls fade the view instead of stopping you.
- **Teleport**, when the building is bigger than the room: hold the trigger or a pinch, aim the arc, release. With a thumbstick, push it forward to aim and rotate it to choose which way you'll face. Cyan means you can land there, red means you can't.
- **Menu:** the small button at waist height lists the storeys.
- **Inspect:** tap on an element to see its class, material and key properties.

Edits made through Claude show up while you are in VR, and you stay where you are.

## More

How references, edits and follow-ups work, plus tested models and known limits: [doc/how-it-works.md](doc/how-it-works.md).
