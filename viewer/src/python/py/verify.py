"""Checks run on every commit, so the model doesn't need separate inspection calls."""

from __future__ import annotations

import ifcopenshell
import ifcopenshell.util.element as ue
import numpy as np

from . import edits
from .spatial import local_matrix

MAX_GEOMETRY_CHECKS = 150  # keeps a huge batch edit from stalling the commit


def _filling_problems(f: ifcopenshell.file, el, verts) -> list[str]:
    fills = getattr(el, "FillsVoids", None) or ()
    if not fills:
        return [f"#{el.id()} {el.is_a()} fills no opening"]
    opening = fills[0].RelatingOpeningElement
    voids = opening.VoidsElements or ()
    if not voids:
        return [f"#{el.id()}: opening #{opening.id()} cuts no host element"]
    host = voids[0].RelatingBuildingElement
    m = local_matrix(f, opening)
    x_world, z_world = m[:3, 0], m[:3, 2]
    try:
        v = verts(opening)
    except Exception as e:  # noqa: BLE001
        return [f"#{el.id()}: opening #{opening.id()} has no geometry: {e}"]
    along, up = v @ x_world, v @ z_world
    problems = edits.clearance_problems(host, opening, x_world, z_world, float(along.min()), float(along.max()), float(up.min()), float(up.max()), verts)
    return [f"#{el.id()}: {p}" for p in problems]


def check_elements(f: ifcopenshell.file, ids: list[int]) -> dict:
    """Problems with the elements an edit touched. Deleted ids are ignored."""
    cache: dict[int, np.ndarray] = {}

    def verts(entity) -> np.ndarray:
        if entity.id() not in cache:
            cache[entity.id()] = edits._world_verts(entity)  # noqa: SLF001
        return cache[entity.id()]

    problems: list[str] = []
    unique = list(dict.fromkeys(ids))
    checked = 0
    for i in unique:
        try:
            el = f.by_id(i)
        except RuntimeError:
            continue
        if not el.is_a("IfcElement") or el.is_a("IfcOpeningElement"):
            continue  # annotations, grids and the like have no solid body to check
        if checked >= MAX_GEOMETRY_CHECKS:
            break
        checked += 1
        if ue.get_container(el) is None and ue.get_aggregate(el) is None and not getattr(el, "FillsVoids", None):
            problems.append(f"#{el.id()} {el.is_a()} is in no storey or space")
        if el.Representation is not None:
            try:
                if not len(verts(el)):
                    problems.append(f"#{el.id()} {el.is_a()} has empty geometry")
            except Exception as e:  # noqa: BLE001
                problems.append(f"#{el.id()} {el.is_a()} has no geometry: {e}")
        if el.is_a("IfcDoor") or el.is_a("IfcWindow"):
            problems += _filling_problems(f, el, verts)
    result: dict = {"ok": not problems, "problems": problems[:30]}
    if len(problems) > 30:
        result["more_problems"] = len(problems) - 30
    if checked < sum(1 for _ in unique) and checked >= MAX_GEOMETRY_CHECKS:
        result["note"] = f"only the first {MAX_GEOMETRY_CHECKS} elements were checked"
    return result
