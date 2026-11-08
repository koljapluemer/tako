"""Edits as named recipes with parameters, so a follow-up can re-run one with changes.

Each recipe receives resolved target entities and a params dict, and returns the
usual edit result (`changed`, `summary`, `warnings`). Recipes hold no state: given
the same model and params they make the same edit.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import ifcopenshell

from . import edits, kit
from .edits import EditError
from .spatial import SpatialIndex, compass_label, local_matrix, unit_scale


@dataclass
class Recipe:
    name: str
    apply: Callable
    schema: dict[str, str]  # parameter -> description; a future viewer panel renders these
    enforce_verify: bool = True


RECIPES: dict[str, Recipe] = {}


def recipe(name: str, schema: dict[str, str], enforce_verify: bool = True):
    def register(fn):
        RECIPES[name] = Recipe(name, fn, schema, enforce_verify)
        return fn
    return register


def _each(targets: list, apply_one: Callable) -> dict:
    """Apply to every target; a failure names the element and aborts the whole edit."""
    results = []
    for el in targets:
        try:
            results.append(apply_one(el))
        except Exception as e:  # noqa: BLE001
            message = str(e) if isinstance(e, EditError) else f"{type(e).__name__}: {e}"
            raise EditError(message + (f" (on #{el.id()}; no changes were applied)" if len(targets) > 1 else "")) from e
    return {
        "changed": [i for r in results for i in r["changed"]],
        "summary": "; ".join(r["summary"] for r in results),
        "warnings": [w for r in results for w in r["warnings"]],
    }


def _sides(f: ifcopenshell.file, si: SpatialIndex, element) -> dict[str, str]:
    """Which compass end the element's left and right are, so a wrong guess is easy to spot."""
    x_axis = local_matrix(f, element)[:3, 0][:2]
    return {"left": compass_label(si.bearing(-x_axis)), "right": compass_label(si.bearing(x_axis))}


def _describe_panels(panels: list[dict], sides: dict[str, str]) -> str:
    return ", ".join(f"{p['pos']}" + (f" ({sides[p['pos']]} end)" if p["pos"] in sides else "") + f" {p['kind']}" for p in panels)


def _window_type_name(panels: list[dict]) -> str:
    return "Fenster - " + ", ".join(f"{p['pos']} {p['kind']}" for p in panels)


def _set_partitioning(window, panels: list[dict]) -> None:
    if hasattr(window, "PartitioningType"):
        window.PartitioningType = kit.PARTITIONING[len(panels)]


@recipe("set_window_panels", {"panels": "list of {pos: left|center|right, kind: fixed|sliding|casement}"})
def set_window_panels(f, targets: list, params: dict, si: SpatialIndex) -> dict:
    panels = kit.normalize_panels(params["panels"])
    for el in targets:
        if not el.is_a("IfcWindow"):
            raise EditError(f"#{el.id()} is {el.is_a()}, expected IfcWindow")
        if not (el.OverallWidth and el.OverallHeight):
            raise EditError(f"window #{el.id()} doesn't state its overall size")
    styles = kit.styles_from(f, targets[0])
    u = unit_scale(f)
    maps: dict[tuple[float, float], object] = {}
    for el in targets:
        size = (round(el.OverallWidth * u, 4), round(el.OverallHeight * u, 4))
        if size not in maps:
            maps[size] = kit.rep_map(f, kit.body(f, kit.window_items(f, *size, panels, styles)))
        local = edits._local_verts(el)  # noqa: SLF001
        low, high = local.min(0), local.max(0)
        at = (float(low[0] + high[0]) / 2, float(low[1] + high[1]) / 2, float(low[2]))
        edits._replace_representation(f, el, edits._body(el), kit.mapped_body(f, maps[size], at))  # noqa: SLF001
        _set_partitioning(el, panels)
    kit.assign_type(f, targets, kit.window_type(f, _window_type_name(panels), panels, list(maps.values())))
    return {"changed": [el.id() for el in targets], "warnings": [],
            "summary": f"{len(targets)} window(s) now: {_describe_panels(panels, _sides(f, si, targets[0]))}"}


def _reference(f: ifcopenshell.file, ifc_class: str, ref: str | None):
    if ref is not None:
        ref = ref.strip()
        return f.by_id(int(ref.lstrip("#"))) if ref.lstrip("#").isdigit() else f.by_guid(ref)
    return next(iter(f.by_type(ifc_class)), None)


def _wall(targets: list):
    if len(targets) != 1 or not targets[0].is_a("IfcWall"):
        raise EditError("expected exactly one IfcWall")
    return targets[0]


@recipe("add_window", {
    "width": "metres", "height": "metres", "sill": "metres above the wall's base",
    "along": "centre, metres from the wall's start; omit for the widest free stretch",
    "panels": "list of {pos: left|center|right, kind: fixed|sliding|casement}",
})
def add_window(f, targets: list, params: dict, si: SpatialIndex) -> dict:
    wall = _wall(targets)
    width, height, sill = params["width"], params["height"], params["sill"]
    panels = kit.normalize_panels(params["panels"])
    along = params.get("along")
    if along is None:
        along = kit.best_along(f, wall, width, sill, height)
    styles = kit.styles_from(f, _reference(f, "IfcWindow", None))
    opening = kit.cut_opening(f, wall, along, sill, width, height, "Fenster")
    item_map = kit.rep_map(f, kit.body(f, kit.window_items(f, width, height, panels, styles)))
    window = kit.fill_opening(f, "IfcWindow", opening, width, height, kit.mapped_body(f, item_map), "Fenster")
    kit.assign_type(f, [window], kit.window_type(f, _window_type_name(panels), panels, [item_map]))
    _set_partitioning(window, panels)
    return {"changed": [window.id(), wall.id()], "warnings": [],
            "summary": f"added {width:.2f} x {height:.2f} m window #{window.id()} in wall #{wall.id()} at {along:.2f} m: {_describe_panels(panels, _sides(f, si, window))}"}


@recipe("add_door", {
    "width": "metres", "height": "metres",
    "along": "centre, metres from the wall's start; omit for the widest free stretch",
    "like": "existing door to copy the look of",
})
def add_door(f, targets: list, params: dict, si: SpatialIndex) -> dict:  # noqa: ARG001
    wall = _wall(targets)
    width, height = params["width"], params["height"]
    along = params.get("along")
    if along is None:
        along = kit.best_along(f, wall, width, 0.0, height)
    styles = kit.styles_from(f, _reference(f, "IfcDoor", params.get("like")))
    opening = kit.cut_opening(f, wall, along, 0.0, width, height, "Tür")
    door = kit.fill_opening(f, "IfcDoor", opening, width, height, kit.body(f, kit.door_items(f, width, height, styles)), "Tür")
    return {"changed": [door.id(), wall.id()], "warnings": [],
            "summary": f"added {width:.2f} x {height:.2f} m door #{door.id()} in wall #{wall.id()} at {along:.2f} m"}


@recipe("set_material", {
    "material": "existing material name or '#id'", "layer_index": "layer of a multi-layer element",
    "color": "[r, g, b] 0..1", "create_if_missing": "create the material if absent", "category": "category of a new material",
}, enforce_verify=False)
def set_material(f, targets: list, params: dict, si: SpatialIndex) -> dict:  # noqa: ARG001
    return _each(targets, lambda el: edits.set_material(
        f, el, params["material"], params.get("layer_index"), params.get("color"),
        params.get("create_if_missing", False), params.get("category")))


@recipe("resize_door_or_window", {"width": "metres", "height": "metres", "anchor": "center | left | right"})
def resize_door_or_window(f, targets: list, params: dict, si: SpatialIndex) -> dict:  # noqa: ARG001
    return _each(targets, lambda el: edits.resize_filling(
        f, el, params.get("width"), params.get("height"), params.get("anchor", "center"), params.get("force", False)))


@recipe("set_property", {"pset": "property set name", "name": "property name", "value": "new value"}, enforce_verify=False)
def set_property(f, targets: list, params: dict, si: SpatialIndex) -> dict:  # noqa: ARG001
    return _each(targets, lambda el: edits.set_property(f, el, params["pset"], params["name"], params["value"]))
