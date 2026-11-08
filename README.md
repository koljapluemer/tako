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
| `just check` | Typecheck the viewer and import-check the server |
| `just reset` | Discard all edits and revision history |
| `TAKO_PORT=5200 just up` | Use a different viewer port |

Then ask Claude things like *"change the material of the north wall to concrete"*
or *"make the main door 30 cm wider"*. The viewer reloads and highlights what
changed. *"undo that"* reverts it.

## How it works

- **The viewer and the server share the selected model** through
  `work/selected.json`. Picking a model in the viewer makes the server switch to
  it on its next tool call, and `open_model` on the server side moves the viewer.
- **References are resolved from data, not names.** Element names are tool- and
  language-specific (`Wand-002`, `Tür-019`), so `find_elements` uses derived
  facts instead (`spatial.py`):
  - *exterior* comes from `Pset_*Common.IsExternal`, then space boundaries, then
    the host wall, then a 2D ray test against the other walls.
  - *facing* is the outward normal of a PCA footprint, measured against `TrueNorth`
    (or +Y when the file has none).
  - Every fact reports its source, so Claude can say when it guessed.
- **Edits never mutate shared data** (`edits.py`):
  - Layer sets that other elements also use are copied before they are changed.
  - Doors and windows are resized by wrapping the existing body (and the
    opening's body) in an `IfcMappedItem` with a non-uniform scale. Shared type
    geometry stays untouched, and this works for Breps, extrusions or mapped type
    geometry alike.
  - The clearance check refuses a resize that would overlap other openings or
    run past the end of the wall.
- **Units:** all tool inputs and outputs are in metres. Model units are converted
  at the boundary, so millimetre files work too.
- **Revisions:** every edit is written as a numbered revision under
  `work/<model>/revisions/`, which is what makes `undo` possible.
  `run_ifcopenshell` is an escape hatch for edits no dedicated tool covers.

## Tested on

| Model | Tool / schema | Exterior signal |
|---|---|---|
| `AC20-Institute-Var-2.ifc` | ArchiCAD 20, IFC4 | space boundaries |
| `external/s-office-archi.ifc` | ArchiCAD 24, IFC2X3, millimetres | pset |
| `external/bsi-arch-ifc2x3.ifc`, `external/bsi-arch-ifc4x3.ifc` | SketchUp, IFC2X3 / IFC4X3 | geometry |

Sources of the external files: [buildingSMART Sample-Test-Files](https://github.com/buildingSMART/Sample-Test-Files)
(Simple-Scene/Building-Architecture) and [ThatOpen engine_web-ifc test files](https://github.com/ThatOpen/engine_web-ifc/tree/main/tests/ifcfiles/public).

## Known limits

- 2D plan representations and space-boundary geometry are not updated after a resize.
- Profile-set materials (beams and columns) are not supported by `set_material` yet.
- Geometry in the index only covers envelope-relevant classes (walls, doors,
  windows, slabs and the like), so furniture has no facing information.
