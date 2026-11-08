"""MCP server exposing a small, file-agnostic IFC editing toolset."""

from __future__ import annotations

import contextlib
import io
import os
import threading
import traceback
from pathlib import Path
from typing import Any

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as ue
from mcp.server.mcpserver import MCPServer

from . import edits
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
4. Tell the user what changed, including warnings. undo reverts.
Use run_ifcopenshell only when no dedicated tool fits.
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
        return _index[1]


def _resolve(ref: str):
    try:
        return index().resolve(ref)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"no element {ref!r}: {e}") from e


def _rollback(s: Session) -> None:
    s.model = ifcopenshell.open(str(s._rev_path(s.rev)))  # discard partial changes
    s.generation += 1


def _apply(fn, *args) -> dict:
    """Run one edit; commit on success, roll back to the last revision on failure."""
    return _apply_many([(fn, args)])


def _apply_many(calls: list[tuple]) -> dict:
    """Run several edits as one revision (one undo step). All or nothing."""
    s = session()
    results = []
    for fn, args in calls:
        try:
            el = args[0]
            results.append(fn(s.model, *args))
        except Exception as e:  # noqa: BLE001
            _rollback(s)
            msg = str(e) if isinstance(e, edits.EditError) else f"{type(e).__name__}: {e}"
            where = f" (on #{el.id()}; no changes were applied)" if len(calls) > 1 else ""
            return {"ok": False, "error": msg + where}
    changed = [i for r in results for i in r["changed"]]
    summary = "; ".join(r["summary"] for r in results)
    rev = s.commit(summary, changed)
    return {"ok": True, "revision": rev, "summary": summary, "changed": [f"#{i}" for i in dict.fromkeys(changed)],
            "warnings": [w for r in results for w in r["warnings"]]}


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
    return _apply_many([(edits.set_material, (_resolve(ref), material, layer_index, color, create_if_missing, category))
                        for ref in elements])


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
    return _apply(edits.resize_filling, _resolve(element), width, height, anchor, force)


@mcp.tool()
def set_property(element: str, pset: str, name: str, value: str | float | int | bool) -> dict:
    """Set one property, e.g. pset='Pset_WallCommon', name='FireRating', value='F90'."""
    return _apply(edits.set_property, _resolve(element), pset, name, value)


@mcp.tool()
def run_ifcopenshell(code: str, summary: str, commit: bool = True) -> dict:
    """Escape hatch: run Python against the open model for edits no other tool covers.

    Available names: f (ifcopenshell.file), ifcopenshell, api (ifcopenshell.api),
    ue (ifcopenshell.util.element). Assign a list of changed expressIDs to
    `changed` so the viewer highlights them. Print to return output.
    The model is rolled back if the code raises. `summary` describes the edit.
    Use commit=False for read-only inspection.
    Runs with full local privileges; keep it to model manipulation.
    """
    s = session()
    ns: dict[str, Any] = {"f": s.model, "ifcopenshell": ifcopenshell, "api": ifcopenshell.api, "ue": ue, "changed": []}
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            exec(compile(code, "<run_ifcopenshell>", "exec"), ns)  # noqa: S102
    except Exception:  # noqa: BLE001
        s.model = ifcopenshell.open(str(s._rev_path(s.rev)))
        s.generation += 1
        return {"ok": False, "output": buf.getvalue()[-4000:], "error": traceback.format_exc(limit=3)[-4000:]}
    changed = [int(c) for c in ns.get("changed") or []]
    if not commit:
        # Discard anything the code may have touched anyway.
        s.model = ifcopenshell.open(str(s._rev_path(s.rev)))
        s.generation += 1
        return {"ok": True, "output": buf.getvalue()[-8000:], "committed": False}
    rev = s.commit(summary, changed)
    return {"ok": True, "output": buf.getvalue()[-8000:], "revision": rev, "changed": [f"#{c}" for c in changed]}


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
