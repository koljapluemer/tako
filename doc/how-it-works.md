# How it works

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

## Edits and follow-ups

- **Recipes:** `add_window`, `add_door`, `set_window_panels`, `set_material`, `resize_door_or_window` and `set_property` are named recipes (`server/src/tako_ifc_mcp/recipes.py`). Each records its parameters and targets in `history.json`.
- **`revise_edit`** re-applies the latest edit from the revision before it, with changed parameters. It replaces that revision, so one `undo` still removes the whole edit. Older edits can't be revised yet.
- **Scripts** (`run_ifcopenshell`) are saved under `work/<model>/edits/`. Values read from `PARAMS` can be changed with `revise_edit`, as can exact text snippets.
- **The kit** (`kit.py`) has tested building blocks in metres for scripts. `kit_help` lists them and the worked examples in `kit_examples/`, which also run as tests.
- **`verify`** runs before each commit: geometry exists, doors and windows fill an opening in a host, and nothing overlaps. Recipes refuse a failing geometric edit unless forced. Scripts report the problems.
- **`context_around`** summarises a room or element and its surroundings in one call.
- **`get_focus`** returns the element clicked in the viewer (`work/<model>/selection.json`) and the latest edit, so "this" needs no search.

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
