"""Benchmark cases: prompts taken from real sessions, graded by inspecting the final IFC."""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
from tako_ifc_mcp.spatial import SpatialIndex, compass_label

MODEL = "example_data/AC20-Institute-Var-2.ifc"
TOLERANCE_M = 0.02


@dataclass
class State:
    base: ifcopenshell.file
    final: ifcopenshell.file
    history: list[dict]
    reply: str = ""

    def new(self, ifc_class: str) -> list:
        known = {e.GlobalId for e in self.base.by_type(ifc_class)}
        return [e for e in self.final.by_type(ifc_class) if e.GlobalId not in known]

    def changed(self, ifc_class: str) -> list:
        ids = {i for h in self.history for i in h.get("changed", [])}
        out = []
        for i in sorted(ids):
            try:
                el = self.final.by_id(i)
            except RuntimeError:
                continue
            if el.is_a(ifc_class):
                out.append(el)
        return out


Check = Callable[[State], list[str]]


def _geometry_problem(el) -> str | None:
    settings = ifcopenshell.geom.settings()
    try:
        shape = ifcopenshell.geom.create_shape(settings, el)
    except Exception as e:  # noqa: BLE001
        return f"#{el.id()} has no geometry: {e}"
    return None if len(shape.geometry.verts) else f"#{el.id()} has empty geometry"


def _filling_problems(el) -> list[str]:
    problems = []
    fills = getattr(el, "FillsVoids", None) or ()
    if not fills:
        problems.append(f"#{el.id()} fills no opening")
    elif not fills[0].RelatingOpeningElement.VoidsElements:
        problems.append(f"#{el.id()}: opening voids no host")
    if ue.get_container(el) is None:
        problems.append(f"#{el.id()} has no spatial container")
    if (p := _geometry_problem(el)) is not None:
        problems.append(p)
    return problems


def _close(value, target: float) -> bool:
    return value is not None and abs(float(value) - target) <= TOLERANCE_M


def _storey(f: ifcopenshell.file, name: str):
    return next(s for s in f.by_type("IfcBuildingStorey") if s.Name == name)


def _in_storey(f: ifcopenshell.file, name: str, ifc_class: str) -> list:
    return [e for e in ue.get_decomposition(_storey(f, name)) if e.is_a(ifc_class)]


def _panel_kinds(window) -> list[str]:
    window_type = ue.get_type(window)
    if window_type is None:
        return []
    return [p.OperationType for p in window_type.HasPropertySets or () if p.is_a("IfcWindowPanelProperties")]


def main_door_wider(s: State) -> list[str]:
    widths_before = {d.GlobalId: d.OverallWidth for d in s.base.by_type("IfcDoor")}
    for door in s.changed("IfcDoor"):
        before = widths_before.get(door.GlobalId)
        if before is not None and _close(door.OverallWidth - before, 0.30):
            return [] if (p := _geometry_problem(door)) is None else [p]
    return ["no changed door is 30 cm wider"]


def simple_door(s: State) -> list[str]:
    new = s.new("IfcDoor")
    if len(new) != 1:
        return [f"expected 1 new door, found {len(new)}"]
    problems = _filling_problems(new[0])
    if not (_close(new[0].OverallWidth, 1.0) and _close(new[0].OverallHeight, 2.1)):
        problems.append(f"size is {new[0].OverallWidth} x {new[0].OverallHeight}")
    return problems


def sliding_floor(s: State) -> list[str]:
    windows = _in_storey(s.final, "2. Obergeschoss", "IfcWindow")
    wrong = [w.id() for w in windows if not any((k or "").startswith("SLIDING") for k in _panel_kinds(w))]
    return [f"{len(wrong)} of {len(windows)} windows are not sliding"] if wrong or not windows else []


def double_windows(s: State) -> list[str]:
    new = s.new("IfcWindow")
    if len(new) != 2:
        return [f"expected 2 new windows, found {len(new)}"]
    problems = [p for w in new for p in _filling_problems(w)]
    for w in new:
        if not (_close(w.OverallWidth, 2.0) and _close(w.OverallHeight, 1.5)):
            problems.append(f"#{w.id()} size is {w.OverallWidth} x {w.OverallHeight}")
    storeys = {ue.get_container(w).Name for w in new if ue.get_container(w)}
    if storeys != {"1. Obergeschoss", "2. Obergeschoss"}:
        problems.append(f"windows are on {sorted(storeys)}")
    return problems


def _new_products(s: State, minimum: int) -> list[str]:
    new = s.new("IfcElement")
    new = [e for e in new if not e.is_a("IfcOpeningElement") and not e.is_a("IfcVirtualElement")]
    if len(new) < minimum:
        return [f"expected at least {minimum} new elements, found {len(new)}"]
    return [p for e in new if (p := _geometry_problem(e)) is not None]


def wc_fit_out(s: State) -> list[str]:
    return _new_products(s, 4)


def sliding_iteration(s: State) -> list[str]:
    windows = s.changed("IfcWindow")
    if not windows:
        return ["no window changed"]
    kinds = sorted(k or "" for k in _panel_kinds(windows[-1]))
    if len(kinds) != 2 or not kinds[1].startswith("SLIDING") or not kinds[0].startswith("FIXED"):
        return [f"panel kinds are {kinds}"]
    return []


def width_iteration(s: State) -> list[str]:
    new = s.new("IfcWindow")
    if len(new) != 1:
        return [f"expected 1 new window, found {len(new)}"]
    problems = _filling_problems(new[0])
    if not (_close(new[0].OverallWidth, 1.6) and _close(new[0].OverallHeight, 1.4)):
        problems.append(f"size is {new[0].OverallWidth} x {new[0].OverallHeight}")
    return problems


def remove_wall(s: State) -> list[str]:
    """The partition between meeting rooms 001 and 002 (x = 5.9..6.1) is gone, and only it."""
    si = SpatialIndex(s.base)
    rooms = {r.name: r for r in si.rooms.values()}
    shared = rooms["001"].elements & rooms["002"].elements
    partition = {si.facts[i].global_id for i in shared if i in si.facts and si.facts[i].ifc_class.startswith("IfcWall") and 5.9 <= si.facts[i].center[0] <= 6.1}
    if not partition:
        return ["benchmark model has no partition between 001 and 002"]
    remaining = {w.GlobalId for w in s.final.by_type("IfcWall")}
    before = {w.GlobalId for w in s.base.by_type("IfcWall")}
    problems = []
    if partition & remaining:
        problems.append("the partition still exists")
    if lost := len(before - remaining - partition):
        problems.append(f"{lost} other walls were removed")
    return problems


def window_question(s: State) -> list[str]:
    """Answered from the model, with both numbers right and nothing edited."""
    si = SpatialIndex(s.base)
    windows = [fa for fa in si.facts.values() if fa.ifc_class.startswith("IfcWindow") and fa.storey == "2. Obergeschoss" and fa.outward is not None and compass_label(si.bearing(fa.outward)) == "N"]
    area = sum(w.width * w.height for w in windows)
    numbers = [float(n.replace(",", ".")) for n in re.findall(r"\d+(?:[.,]\d+)?", s.reply)]
    problems = [f"edited the model: {h['summary']}" for h in s.history]
    if len(windows) not in numbers:
        problems.append(f"reply doesn't give the count {len(windows)}")
    if not any(abs(n - area) <= 0.02 * area for n in numbers):
        problems.append(f"reply doesn't give the area {area:.2f}")
    return problems


@dataclass
class Case:
    name: str
    turns: list[str]
    check: Check


CASES = [
    Case("main_door", ["Make the main door 30 cm wider."], main_door_wider),
    Case("simple_door", ["Add a simple door, 1 m wide and 2.1 m high, in the north wall of the ground floor (Erdgeschoss)."], simple_door),
    Case("sliding_floor", ["Make all windows on 2. Obergeschoss two-panel sliding windows."], sliding_floor),
    Case("double_windows", ["Add one double window, 2 m wide and 1.5 m high, in the north wall on 1. Obergeschoss and on 2. Obergeschoss."], double_windows),
    Case("wc", ["Fit out room 314 on 2. Obergeschoss as a standard public WC with two cubicles. Don't ask me anything, use sensible defaults."], wc_fit_out),
    Case("remove_wall", ["Remove the wall between rooms 001 and 002 in the basement (Keller), so they become one space."], remove_wall),
    Case("window_question", ["How many windows on 2. Obergeschoss face north, and what is their total area in square metres?"], window_question),
    Case(
        "iter_sliding",
        [
            "Make window #91346 a two-panel sliding window.",
            "No, actually, make just the left panel sliding and keep the right panel fixed.",
        ],
        sliding_iteration,
    ),
    Case(
        "iter_width",
        [
            "Add a window, 1.2 m wide and 1.4 m high, in wall #98796.",
            "Make it 1.6 m wide instead.",
        ],
        width_iteration,
    ),
]
