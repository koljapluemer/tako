"""MCP server exposing a small, file-agnostic IFC editing toolset."""

from __future__ import annotations

import contextlib
import io
import json
import os
import threading
import traceback
from pathlib import Path
from typing import Any

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as ue
from mcp.server.mcpserver import MCPServer

from . import edits, kit, kit_docs, verify
from .recipes import RECIPES, Recipe
from .session import REPO_ROOT, Session
from .spatial import SpatialIndex

INSTRUCTIONS = """\
Edits the IFC building model shown in the user's tako viewer. Every edit is saved
as a revision and the viewer reloads and highlights what changed.

How to work:
1. Resolve what the user means with find_elements. Do NOT rely on element names:
   they are authoring-tool and language specific (e.g. German 'Wand', 'Tür').
   Use the derived facts instead: exterior, facing (compass direction of the
   outward side), storey, width, sort_by.
   - "north wall"  -> find_elements(ifc_class="IfcWall", exterior=True, facing="north")
     A façade is often split into several wall segments, and every storey has
     its own. If several match, say so and either edit all of them (when that
     is clearly what the user means) or ask which one.
   - "main door"   -> find_elements(ifc_class="IfcDoor", exterior=True, sort_by="width");
     prefer the lowest above-ground storey. If there is no single clear
     candidate, list the candidates and ask.
2. Check each match's `*_source` fields. If a fact was derived from geometry or
   assumed (e.g. north assumed +Y), mention that briefly to the user.
3. Edit with the dedicated tools. Material names in the file may be in another
   language: call list_materials and map the user's word (e.g. concrete ->
   'Stahlbeton'/'Beton') yourself before creating a new material.
   Prefer add_window, add_door and set_window_panels for openings.
4. For a follow-up on the latest edit ("no, only the left side"), call revise_edit with
   just the changed parameters. For "this" or "it", call get_focus.
5. Tell the user what changed, including warnings and any `verify` problems. undo reverts.
Use run_ifcopenshell only when no dedicated tool fits. Before writing a script, use
context_around to see what surrounds a place, and kit_help for tested building blocks
and worked examples: `kit` and the spatial index `si` are available inside scripts.
"""

mcp = MCPServer("tako-ifc", instructions=INSTRUCTIONS)
_session: Session | None = None
_index: tuple[int, SpatialIndex] | None = None
_index_lock = threading.Lock()


def session() -> Session:
    """The active session, switched to whatever model the viewer has selected."""
    global _session
    if _session is None:
        _session = Session.from_env()
    else:
        _session.sync_selection()
    return _session


def index() -> SpatialIndex:
    global _index
    s = session()
    with _index_lock:
        if _index is None or _index[0] != s.generation:
            _index = (s.generation, SpatialIndex(s.model))
        elif _index[1].f is not s.model:
            _index[1].f = s.model  # reopened at the same revision: facts still hold
        return _index[1]


def _resolve(ref: str):
    try:
        return index().resolve(ref)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"no element {ref!r}: {e}") from e


def _handle(entry: dict) -> dict:
    """What a follow-up needs to refer to and change this edit."""
    recipe = RECIPES.get(entry.get("recipe", ""))
    return {
        "edit_id": entry.get("edit_id"), "recipe": entry.get("recipe"), "params": entry.get("params"),
        "targets": entry.get("targets"), "revisable": list(recipe.schema) if recipe else "PARAMS, or text replacements in the script",
    }


def _run_recipe(s: Session, recipe: Recipe, targets: list, params: dict, rev_before: int, replace_last: bool = False) -> dict:
    """Apply a recipe and commit it, or leave the latest revision as it was."""
    try:
        result = recipe.apply(s.model, targets, params, index())
    except Exception as e:  # noqa: BLE001
        s.reload()
        return {"ok": False, "error": str(e) if isinstance(e, edits.EditError) else f"{type(e).__name__}: {e}"}
    check = verify.check_elements(s.model, result["changed"])
    if recipe.enforce_verify and not check["ok"] and not params.get("force"):
        s.reload()
        return {"ok": False, "error": "verification failed, so nothing was applied. Change the parameters, or pass force=true after asking the user.", "verify": check}
    edit = {"recipe": recipe.name, "params": params, "targets": [t.GlobalId for t in targets], "rev_before": rev_before}
    rev = s.commit(result["summary"], result["changed"], edit, replace_last)
    return {"ok": True, "revision": rev, "summary": result["summary"], "changed": [f"#{i}" for i in dict.fromkeys(result["changed"])],
            "warnings": result["warnings"], "verify": check, "edit": _handle(s.history[-1])}


def _apply_recipe(recipe_name: str, refs: list[str], /, **params: Any) -> dict:
    s = session()
    targets = [_resolve(ref) for ref in refs]
    given = {k: v for k, v in params.items() if v is not None and not (k == "force" and not v)}
    return _run_recipe(s, RECIPES[recipe_name], targets, given, s.rev)


def _execute(s: Session, code: str, params: dict) -> tuple[dict | None, str, str | None]:
    """Run script code against the open model. Returns (namespace, output, traceback)."""
    ns: dict[str, Any] = {"f": s.model, "si": index(), "kit": kit, "PARAMS": params, "ifcopenshell": ifcopenshell, "api": ifcopenshell.api, "ue": ue, "changed": []}
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<run_ifcopenshell>", "exec"), ns)  # noqa: S102
    except Exception:  # noqa: BLE001
        return None, buf.getvalue(), traceback.format_exc(limit=3)
    return ns, buf.getvalue(), None


def _commit_script(s: Session, code: str, summary: str, params: dict, ns: dict, output: str, rev_before: int, replace_last: bool = False) -> dict:
    changed = [int(c) for c in ns.get("changed") or []]
    check = verify.check_elements(s.model, changed)
    edit = {"recipe": "script", "params": params, "targets": [], "rev_before": rev_before}
    rev = s.commit(summary, changed, edit, replace_last)
    s.edits_dir.mkdir(parents=True, exist_ok=True)
    (s.edits_dir / f"{s.history[-1]['edit_id']}.py").write_text(code)
    return {"ok": True, "output": output[-8000:], "revision": rev, "changed": [f"#{c}" for c in changed], "verify": check, "edit": _handle(s.history[-1])}


# ----------------------------------------------------------------------------
# read tools
# ----------------------------------------------------------------------------

@mcp.tool()
def model_overview() -> dict:
    """Schema, units, true north, storeys, element counts and edit history of the open model."""
    s = session()
    f = s.model
    si = index()
    counts: dict[str, int] = {}
    for fa in si.facts.values():
        counts[fa.ifc_class] = counts.get(fa.ifc_class, 0) + 1
    project = f.by_type("IfcProject")
    return {
        "file": str(s.source),
        "schema": f.schema,
        "project": project[0].Name if project else None,
        "note_units": "all lengths in tool inputs/outputs are metres, regardless of the file's unit",
        "length_unit": next((f"{u.Prefix or ''}{u.Name}" for u in f.by_type("IfcSIUnit") if u.UnitType == "LENGTHUNIT"), None),
        "north": si.north_source,
        "storeys": [{"name": st.Name, "elevation_m": round((st.Elevation or 0) * si.unit, 3)} for st in sorted(f.by_type("IfcBuildingStorey"), key=lambda x: x.Elevation or 0)],
        "element_counts": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
        "exterior_signals": {
            "space_boundaries": len(f.by_type("IfcRelSpaceBoundary")),
            "note": "exterior is taken from Pset_*Common.IsExternal, else space boundaries, else host wall, else a geometric ray test",
        },
        "revision": s.rev,
        "history": [h["summary"] for h in s.history[-10:]],
    }


@mcp.tool()
def find_elements(
    ifc_class: str | None = None,
    storey: str | None = None,
    exterior: bool | None = None,
    facing: str | None = None,
    text: str | None = None,
    sort_by: str | None = None,
    limit: int = 20,
) -> list[dict]:
    """Find candidate elements by derived spatial facts.

    ifc_class: e.g. IfcWall (includes subtypes like IfcWallStandardCase), IfcDoor, IfcWindow, IfcSlab.
    storey: substring of the storey name, or an elevation in metres (e.g. "0").
    exterior: True for elements on the building envelope.
    facing: compass direction of the outward side: north, ne, east, ..., or a bearing in degrees.
        Within ±45°. Only exterior elements have a facing.
    text: substring match on name / type name / object type (use only when the user quotes a name).
    sort_by: width | height | length | thickness | elevation | north | south | east | west
        (the compass options sort by position, e.g. 'north' = northernmost first).
    """
    return index().find(ifc_class, storey, exterior, facing, text, sort_by, limit)


@mcp.tool()
def get_element(element: str) -> dict:
    """Full details for one element ('#123' expressID or GlobalId): spatial facts,
    material (with layers), property sets and quantities."""
    el = _resolve(element)
    si = index()
    d = si.describe(si.facts[el.id()]) if el.id() in si.facts else {"id": f"#{el.id()}", "class": el.is_a(), "name": getattr(el, "Name", None)}
    d["material"] = edits.describe_material(session().model, el) if el.is_a("IfcProduct") else None
    psets = ue.get_psets(el)
    d["psets"] = {k: {pk: pv for pk, pv in v.items() if pk != "id"} for k, v in psets.items()}
    if el.is_a("IfcDoor") or el.is_a("IfcWindow"):
        u = si.unit
        d["overall_width_m"] = el.OverallWidth * u if el.OverallWidth else None
        d["overall_height_m"] = el.OverallHeight * u if el.OverallHeight else None
    return d


@mcp.tool()
def context_around(target: str, radius: float = 3.0, limit: int = 40) -> dict:
    """What surrounds an element or room, in one call: the room it is in, neighbouring
    rooms, and nearby walls, doors, windows, slabs and stairs. Use before writing
    inspection scripts.

    target: '#id', GlobalId, or a room's name, number or long name.
    radius: metres of clearance to search around the target's bounding box.
    limit: maximum nearby elements; the result says how many more there were.
    """
    return index().context_around(target, radius, limit)


@mcp.tool()
def list_materials() -> list[dict]:
    """All IfcMaterials in the model with usage counts and display colour."""
    return edits.material_overview(session().model)


# ----------------------------------------------------------------------------
# edit tools
# ----------------------------------------------------------------------------

@mcp.tool()
def set_material(
    elements: list[str],
    material: str,
    layer_index: int | None = None,
    color: list[float] | None = None,
    create_if_missing: bool = False,
    category: str | None = None,
) -> dict:
    """Change the material of one or more elements as a single revision (one undo
    step; if any element fails, nothing is applied). Shared layer sets are copied, so other elements
    keep their material. The element is recoloured to match.

    material: an existing material name (exact, case-insensitive) or '#id'.
    layer_index: required for multi-layer walls/slabs; get_element shows the layers.
    color: optional [r, g, b] in 0..1 to override the display colour.
    create_if_missing: create a new IfcMaterial if no such name exists.
    category: IFC material category for a newly created material (e.g. 'concrete').
    """
    return _apply_recipe("set_material", elements, material=material, layer_index=layer_index, color=color,
                         create_if_missing=create_if_missing, category=category)


@mcp.tool()
def resize_door_or_window(
    element: str,
    width: float | None = None,
    height: float | None = None,
    anchor: str = "center",
    force: bool = False,
) -> dict:
    """Set the width and/or height (metres) of a door or window, resizing its
    opening in the host wall too. Height grows upward from the sill/threshold.

    anchor: which side stays fixed when the width changes: center | left | right
        (left/right in the element's own coordinate frame).
    force: apply even if the clearance check fails (overlap with other
        openings or exceeding the wall). Ask the user before using this.
    """
    return _apply_recipe("resize_door_or_window", [element], width=width, height=height, anchor=anchor, force=force)


@mcp.tool()
def set_property(element: str, pset: str, name: str, value: str | float | int | bool) -> dict:
    """Set one property, e.g. pset='Pset_WallCommon', name='FireRating', value='F90'."""
    return _apply_recipe("set_property", [element], pset=pset, name=name, value=value)


@mcp.tool()
def set_window_panels(windows: list[str], panels: list[dict], force: bool = False) -> dict:
    """Rebuild windows with the given panels, keeping their size and position. One revision.

    panels: [{"pos": "left"|"center"|"right", "kind": "fixed"|"sliding"|"casement"}, ...], 1 to 3.
    The result says which compass end is left. To change only one side later, use revise_edit.
    force: apply even if verification fails. Ask the user first.
    """
    return _apply_recipe("set_window_panels", windows, panels=panels, force=force)


@mcp.tool()
def add_window(
    wall: str,
    width: float,
    height: float,
    sill: float = 0.9,
    along: float | None = None,
    panels: list[dict] | None = None,
    force: bool = False,
) -> dict:
    """Cut an opening in a wall and fill it with a new window.

    sill: metres above the wall's base.
    along: centre, metres from the wall's start. Omit to use the widest free stretch.
    panels: as in set_window_panels. Default: one casement panel.
    force: apply even if verification fails. Ask the user first.
    """
    return _apply_recipe("add_window", [wall], width=width, height=height, sill=sill, along=along,
                         panels=panels or [{"pos": "center", "kind": "casement"}], force=force)


@mcp.tool()
def add_door(wall: str, width: float = 0.9, height: float = 2.1, along: float | None = None, like: str | None = None, force: bool = False) -> dict:
    """Cut a floor-level opening in a wall and fill it with a new plain door.

    along: centre, metres from the wall's start. Omit to use the widest free stretch.
    like: an existing door whose look to copy.
    force: apply even if verification fails. Ask the user first.
    """
    return _apply_recipe("add_door", [wall], width=width, height=height, along=along, like=like, force=force)


@mcp.tool()
def revise_edit(edit_id: str, params: dict | None = None, replacements: list[dict] | None = None) -> dict:
    """Redo the latest edit with changes, instead of undoing and starting over. It stays
    one undo step. Use this for follow-ups like "only the left side" or "make it wider".

    edit_id: from the `edit` field of the edit's result, or get_focus.
    params: parameters to change; others keep their values.
    replacements: for script edits only, [{"old": "...", "new": "..."}]; each old text must occur exactly once.
    """
    s = session()
    last = s.history[-1] if s.history else None
    if last is None or last.get("edit_id") != edit_id:
        latest = last.get("edit_id") if last else "none"
        return {"ok": False, "error": f"only the latest edit can be revised (latest: {latest}). Undo back to it, or make a new edit."}
    merged = {**last["params"], **(params or {})}
    if last["recipe"] == "script":
        return _revise_script(s, last, merged, replacements or [])
    if replacements:
        return {"ok": False, "error": "replacements only apply to script edits; pass params"}
    s.open_revision(last["rev_before"])
    try:
        targets = [s.model.by_guid(g) for g in last["targets"]]
    except RuntimeError as e:
        s.reload()
        return {"ok": False, "error": f"a target no longer exists: {e}"}
    return _run_recipe(s, RECIPES[last["recipe"]], targets, merged, last["rev_before"], replace_last=True)


def _revise_script(s: Session, last: dict, params: dict, replacements: list[dict]) -> dict:
    code = (s.edits_dir / f"{last['edit_id']}.py").read_text()
    for r in replacements:
        if code.count(r["old"]) != 1:
            return {"ok": False, "error": f"text occurs {code.count(r['old'])} times, expected once: {r['old'][:80]!r}"}
        code = code.replace(r["old"], r["new"])
    s.open_revision(last["rev_before"])
    s.generation += 1  # scripts may read `si`, which must describe the older revision
    ns, output, error = _execute(s, code, params)
    if ns is None:
        s.reload()
        s.generation += 1
        return {"ok": False, "output": output[-4000:], "error": error[-4000:]}
    return _commit_script(s, code, last["summary"], params, ns, output, last["rev_before"], replace_last=True)


@mcp.tool()
def get_focus() -> dict:
    """What the user means by "this" or "it": the element selected in the viewer and the latest edit."""
    s = session()
    si = index()
    out: dict[str, Any] = {"selection": None, "latest_edit": None}
    try:
        selected = json.loads(s.selection_path.read_text())["expressID"]
    except (OSError, ValueError, KeyError):
        selected = None
    if selected is not None:
        if selected in si.facts:
            out["selection"] = si.describe(si.facts[selected])
        else:
            try:
                el = s.model.by_id(selected)
                out["selection"] = {"id": f"#{el.id()}", "class": el.is_a(), "name": getattr(el, "Name", None)}
            except RuntimeError:
                out["selection_note"] = f"the selected element #{selected} no longer exists; ask the user to select again"
    if s.history and "edit_id" in s.history[-1]:
        out["latest_edit"] = {"summary": s.history[-1]["summary"], **_handle(s.history[-1])}
    return out


@mcp.tool()
def run_ifcopenshell(code: str, summary: str, commit: bool = True, params: dict | None = None) -> dict:
    """Escape hatch: run Python against the open model for edits no other tool covers.

    Available names: f (ifcopenshell.file), si (the SpatialIndex: si.facts[id] has
    world bbox, storey, exterior, host, ...; si.rooms has the IfcSpaces), kit
    (building blocks in metres; see kit_help), ifcopenshell, api (ifcopenshell.api), ue (ifcopenshell.util.element). Assign a list of changed expressIDs to
    `changed` so the viewer highlights them. Print to return output.
    The model is rolled back if the code raises. `summary` describes the edit.
    params: values the code reads from PARAMS. Put sizes and options there, so a
    follow-up can change them with revise_edit instead of rewriting the script.
    Use commit=False for read-only inspection.
    Runs with full local privileges; keep it to model manipulation.
    """
    s = session()
    params = params or {}
    rev_before = s.rev
    ns, output, error = _execute(s, code, params)
    if ns is None:
        s.reload()
        return {"ok": False, "output": output[-4000:], "error": error[-4000:]}
    if not commit:
        s.reload()  # discard anything the code may have touched anyway
        return {"ok": True, "output": output[-8000:], "committed": False}
    return _commit_script(s, code, summary, params, ns, output, rev_before)


@mcp.tool()
def kit_help(topic: str | None = None) -> str:
    """Reference for the `kit` used in run_ifcopenshell. No topic: all functions and
    example names. A topic: one function's full docs, or a complete worked example.
    Read the matching example before writing a modelling script."""
    return kit_docs.help_text(topic)


@mcp.tool()
def undo(steps: int = 1) -> dict:
    """Revert the last `steps` edits."""
    return session().undo(steps)


@mcp.tool()
def list_models() -> dict:
    """IFC files available under example_data/ (the viewer's model picker shows the same list)."""
    s = session()
    files = sorted((REPO_ROOT / "example_data").rglob("*.ifc"))
    return {
        "active": str(s.source.relative_to(REPO_ROOT)) if s.source.is_relative_to(REPO_ROOT) else str(s.source),
        "models": [{"path": str(p.relative_to(REPO_ROOT)), "size_mb": round(p.stat().st_size / 1e6, 1)} for p in files],
    }


@mcp.tool()
def open_model(path: str, resume: bool = False) -> dict:
    """Switch to another IFC file (path absolute or relative to the repo root).
    The viewer follows. resume=True continues that file's previous edit history;
    resume=False starts again from the pristine file."""
    p = Path(path)
    p = p if p.is_absolute() else REPO_ROOT / p
    if not p.exists():
        return {"ok": False, "error": f"{p} does not exist"}
    session().open(p, resume=resume)
    return {"ok": True, **model_overview()}


def main() -> None:
    os.chdir(REPO_ROOT)
    session()  # open eagerly so the viewer has current.ifc immediately
    # Build the spatial index while the client is still starting up.
    threading.Thread(target=index, daemon=True).start()
    mcp.run()


if __name__ == "__main__":
    main()
