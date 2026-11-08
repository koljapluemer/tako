"""Derive file-independent spatial facts about elements.

Nothing here relies on element names (they are authoring-tool and language
specific). Every derived fact carries the *source* it came from so the LLM can
judge how much to trust it and tell the user when it had to guess.

Facts per element:
    storey      containing storey (via spatial containment, host element, or elevation)
    footprint   oriented 2D rectangle from a PCA of the world-space vertices
    exterior    True/False/None, with the signal used:
                  pset        Pset_*Common.IsExternal
                  boundary    IfcRelSpaceBoundary marked EXTERNAL*
                  host        door/window inherits from its host wall
                  geometry    ray test: one side of the element sees no other wall
    facing      compass bearing of the outward normal (exterior elements only)
"""

from __future__ import annotations

import math
import multiprocessing
from dataclasses import dataclass, field

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as ue
import ifcopenshell.util.placement as up
import ifcopenshell.util.unit
import numpy as np

COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
COMPASS_WORDS = {
    "north": 0, "n": 0, "northeast": 45, "ne": 45, "east": 90, "e": 90, "southeast": 135, "se": 135,
    "south": 180, "s": 180, "southwest": 225, "sw": 225, "west": 270, "w": 270, "northwest": 315, "nw": 315,
}
# Classes that physically separate inside from outside, used as obstacles in the ray test.
ENCLOSING = ("IfcWall", "IfcCurtainWall")
# Only these get geometry (footprint, facing). Furniture, MEP etc. would dominate
# indexing time on large models without helping to resolve references.
GEOMETRY_CLASSES = (
    "IfcWall", "IfcCurtainWall", "IfcDoor", "IfcWindow", "IfcSlab", "IfcRoof", "IfcColumn",
    "IfcBeam", "IfcStair", "IfcRamp", "IfcRailing", "IfcCovering", "IfcPlate", "IfcMember",
)
SKIP = ("IfcOpeningElement", "IfcVirtualElement", "IfcSpace", "IfcAnnotation", "IfcGrid")


def compass_label(bearing: float) -> str:
    return COMPASS[int(((bearing % 360) + 22.5) // 45) % 8]


def bearing_diff(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


@dataclass
class Facts:
    id: int
    ifc_class: str
    global_id: str | None
    name: str | None
    type_name: str | None
    storey: str | None = None
    storey_elevation: float | None = None
    storey_source: str | None = None
    center: np.ndarray | None = None  # world xyz of bbox center
    bbox_min: np.ndarray | None = None
    bbox_max: np.ndarray | None = None
    axis: np.ndarray | None = None  # 2D unit vector, principal horizontal direction
    length: float | None = None  # extent along axis
    thickness: float | None = None  # extent across axis
    exterior: bool | None = None
    exterior_source: str | None = None
    outward: np.ndarray | None = None  # 2D unit normal pointing outside
    host: int | None = None  # for doors/windows: the wall they sit in
    width: float | None = None
    height: float | None = None
    extras: dict = field(default_factory=dict)


class SpatialIndex:
    """Lazily computed per-model facts. Rebuilt when the session generation changes."""

    def __init__(self, model: ifcopenshell.file):
        self.f = model
        self.unit = unit_scale(model)
        self.facts: dict[int, Facts] = {}
        self.north = self._true_north()
        self._ext_boundary: set[int] = set()
        self._int_boundary: set[int] = set()
        self._index_boundaries()
        self._build()

    # -- north ---------------------------------------------------------------
    def _true_north(self) -> np.ndarray:
        for ctx in self.f.by_type("IfcGeometricRepresentationContext"):
            if ctx.is_a("IfcGeometricRepresentationSubContext"):
                continue
            tn = getattr(ctx, "TrueNorth", None)
            if tn is not None and ctx.ContextType == "Model":
                v = np.array(tn.DirectionRatios[:2], dtype=float)
                if np.linalg.norm(v) > 0:
                    self.north_source = f"IfcGeometricRepresentationContext.TrueNorth {tuple(round(float(x), 4) for x in v)}"
                    return v / np.linalg.norm(v)
        self.north_source = "assumed +Y (model has no TrueNorth)"
        return np.array([0.0, 1.0])

    def bearing(self, v2: np.ndarray) -> float:
        """Compass bearing (deg, clockwise from true north) of a 2D world vector."""
        n = self.north
        east = np.array([n[1], -n[0]])
        return math.degrees(math.atan2(float(v2 @ east), float(v2 @ n))) % 360

    def direction(self, bearing: float) -> np.ndarray:
        n = self.north
        east = np.array([n[1], -n[0]])
        r = math.radians(bearing)
        return math.cos(r) * n + math.sin(r) * east

    # -- signals -------------------------------------------------------------
    def _index_boundaries(self) -> None:
        for b in self.f.by_type("IfcRelSpaceBoundary"):
            el = b.RelatedBuildingElement
            if el is None:
                continue
            kind = getattr(b, "InternalOrExternalBoundary", None) or ""
            (self._ext_boundary if kind.startswith("EXTERNAL") else self._int_boundary).add(el.id())

    @staticmethod
    def _pset_external(el) -> bool | None:
        for pname, props in ue.get_psets(el).items():
            if pname.endswith("Common") and isinstance(props.get("IsExternal"), bool):
                return props["IsExternal"]
        return None

    # -- build ---------------------------------------------------------------
    def _elements(self):
        for el in self.f.by_type("IfcElement"):
            if el.is_a() in SKIP or any(el.is_a(c) for c in SKIP):
                continue
            if el.Representation is None:
                continue
            yield el

    def _build(self) -> None:
        els = list(self._elements())
        for el in els:
            t = ue.get_type(el)
            self.facts[el.id()] = Facts(
                id=el.id(), ifc_class=el.is_a(), global_id=el.GlobalId, name=el.Name,
                type_name=t.Name if t else None,
            )
        self._geometry([e for e in els if any(e.is_a(c) for c in GEOMETRY_CLASSES)])
        for fa in self.facts.values():
            self._host(fa)
        for fa in self.facts.values():
            self._storey(fa)
            self._size(fa)
        for fa in self.facts.values():
            self._exterior(fa)

    def _geometry(self, els) -> None:
        if not els:
            return
        s = ifcopenshell.geom.settings()
        s.set("use-world-coords", True)
        it = ifcopenshell.geom.iterator(s, self.f, multiprocessing.cpu_count(), include=els)
        if not it.initialize():
            return
        while True:
            sh = it.get()
            v = np.asarray(sh.geometry.verts, dtype=float).reshape(-1, 3)
            fa = self.facts.get(sh.id)
            if fa is not None and len(v):
                self._set_geometry(fa, v)
            if not it.next():
                break

    @staticmethod
    def _set_geometry(fa: Facts, v: np.ndarray) -> None:
        fa.bbox_min, fa.bbox_max = v.min(0), v.max(0)
        fa.center = (fa.bbox_min + fa.bbox_max) / 2
        xy = v[:, :2] - v[:, :2].mean(0)
        if len(xy) >= 2 and np.ptp(xy, axis=0).max() > 1e-6:
            _, _, vt = np.linalg.svd(xy, full_matrices=False)
            axis = vt[0]
        else:
            axis = np.array([1.0, 0.0])
        # Canonical sign so the same wall always yields the same axis.
        if axis[0] < -1e-9 or (abs(axis[0]) <= 1e-9 and axis[1] < 0):
            axis = -axis
        perp = np.array([-axis[1], axis[0]])
        a, p = xy @ axis, xy @ perp
        fa.axis = axis
        fa.length = float(np.ptp(a))
        fa.thickness = float(np.ptp(p))
        fa.extras["footprint_center"] = v[:, :2].mean(0) + axis * (a.max() + a.min()) / 2 + perp * (p.max() + p.min()) / 2

    def _host(self, fa: Facts) -> None:
        el = self.f.by_id(fa.id)
        for rel in getattr(el, "FillsVoids", None) or ():
            opening = rel.RelatingOpeningElement
            for v in getattr(opening, "VoidsElements", None) or ():
                fa.host = v.RelatingBuildingElement.id()
                fa.extras["opening"] = opening.id()
                return

    def _storey(self, fa: Facts) -> None:
        el = self.f.by_id(fa.id)
        cont = ue.get_container(el)
        src = "containment"
        if cont is None and fa.host is not None:
            cont = ue.get_container(self.f.by_id(fa.host))
            src = "host element"
        if cont is None:
            agg = ue.get_aggregate(el)
            while agg is not None and not agg.is_a("IfcBuildingStorey"):
                cont = ue.get_container(agg)
                if cont is not None:
                    break
                agg = ue.get_aggregate(agg)
            cont = cont or agg
            src = "aggregate"
        if cont is None and fa.bbox_min is not None:
            storeys = sorted(self.f.by_type("IfcBuildingStorey"), key=lambda s: s.Elevation or 0)
            below = [s for s in storeys if (s.Elevation or 0) * self.unit <= fa.bbox_min[2] + 0.05]
            cont = below[-1] if below else (storeys[0] if storeys else None)
            src = "elevation"
        if cont is not None and cont.is_a("IfcBuildingStorey"):
            elev = cont.Elevation * self.unit if cont.Elevation is not None else None
            fa.storey, fa.storey_elevation, fa.storey_source = cont.Name, elev, src

    def _size(self, fa: Facts) -> None:
        el = self.f.by_id(fa.id)
        if el.is_a("IfcDoor") or el.is_a("IfcWindow"):
            fa.width = el.OverallWidth * self.unit if el.OverallWidth else fa.length
            fa.height = el.OverallHeight * self.unit if el.OverallHeight else (float(fa.bbox_max[2] - fa.bbox_min[2]) if fa.bbox_min is not None else None)
        elif fa.bbox_min is not None:
            fa.width = fa.length
            fa.height = float(fa.bbox_max[2] - fa.bbox_min[2])

    # -- exterior + facing ---------------------------------------------------
    def _exterior(self, fa: Facts) -> None:
        el = self.f.by_id(fa.id)
        ext, src = self._pset_external(el), "pset"
        if ext is None and (fa.id in self._ext_boundary or fa.id in self._int_boundary):
            ext, src = fa.id in self._ext_boundary, "space boundary"
        if ext is None and fa.host is not None and fa.host in self.facts:
            h = self.facts[fa.host]
            if h.exterior is None:
                self._exterior(h)
            ext, src = h.exterior, f"host wall #{fa.host} ({h.exterior_source})"
        free = self._free_sides(fa)
        if ext is None and free is not None:
            ext, src = (len(free) == 1), "geometry ray test"
        fa.exterior, fa.exterior_source = ext, (src if ext is not None else None)
        if ext and fa.axis is not None:
            perp = np.array([-fa.axis[1], fa.axis[0]])
            if free is not None and len(free) == 1:
                fa.outward = free[0]
            elif fa.host is not None and self.facts.get(fa.host) is not None and self.facts[fa.host].outward is not None:
                fa.outward = self.facts[fa.host].outward
            else:  # fall back: away from the building centre
                c = self._building_center()
                d = fa.extras["footprint_center"] - c
                fa.outward = perp if d @ perp >= 0 else -perp

    def _building_center(self) -> np.ndarray:
        if not hasattr(self, "_bc"):
            pts = [fa.extras["footprint_center"] for fa in self.facts.values()
                   if "footprint_center" in fa.extras and fa.ifc_class.startswith(ENCLOSING)]
            self._bc = np.mean(pts, axis=0) if pts else np.zeros(2)
        return self._bc

    def _obstacles(self, fa: Facts):
        for o in self.facts.values():
            if o.id == fa.id or o.id == fa.host or o.axis is None or o.bbox_min is None:
                continue
            if not any(o.ifc_class.startswith(c) for c in ENCLOSING):
                continue
            # Same vertical band (overlapping z ranges).
            if o.bbox_max[2] < fa.bbox_min[2] + 0.1 or o.bbox_min[2] > fa.bbox_max[2] - 0.1:
                continue
            yield o

    def _free_sides(self, fa: Facts, reach: float = 200.0):
        """Cast rays from the element's footprint centre along both normals.
        Returns the list of normals that hit no other enclosing element, or None if
        the element has no usable footprint."""
        if fa.axis is None or "footprint_center" not in fa.extras:
            return None
        if fa.host is not None:  # doors/windows: ask the host wall
            return None
        perp = np.array([-fa.axis[1], fa.axis[0]])
        c = fa.extras["footprint_center"]
        obstacles = list(self._obstacles(fa))
        free = []
        # Sample a few points along the wall so a single gap doesn't flip the result.
        offsets = np.linspace(-0.3, 0.3, 3) * (fa.length or 0)
        for n in (perp, -perp):
            hits = 0
            for off in offsets:
                origin = c + fa.axis * off + n * ((fa.thickness or 0) / 2 + 0.05)
                if any(_ray_hits_obb(origin, n, o, reach) for o in obstacles):
                    hits += 1
            if hits <= len(offsets) // 2:
                free.append(n)
        return free

    # -- queries -------------------------------------------------------------
    def describe(self, fa: Facts) -> dict:
        d = {
            "id": f"#{fa.id}",
            "global_id": fa.global_id,
            "class": fa.ifc_class,
            "name": fa.name,
            "type": fa.type_name,
            "storey": fa.storey,
            "storey_elevation": fa.storey_elevation,
            "exterior": fa.exterior,
            "exterior_source": fa.exterior_source,
        }
        if fa.outward is not None:
            b = self.bearing(fa.outward)
            d["facing"] = compass_label(b)
            d["facing_bearing_deg"] = round(b, 1) % 360
        elif fa.axis is not None and fa.ifc_class.startswith(ENCLOSING):
            b = self.bearing(fa.axis) % 180
            d["runs"] = f"{compass_label(b)}-{compass_label(b + 180)}"
        if fa.center is not None:
            d["center"] = [round(float(x), 3) for x in fa.center]
        if fa.width is not None:
            d["width"] = round(fa.width, 3)
        if fa.height is not None:
            d["height"] = round(fa.height, 3)
        if fa.ifc_class.startswith(ENCLOSING) and fa.thickness is not None:
            d["thickness"] = round(fa.thickness, 3)
        if fa.host is not None:
            d["host"] = f"#{fa.host}"
        return d

    def find(self, ifc_class=None, storey=None, exterior=None, facing=None, text=None,
             sort_by=None, limit=20) -> list[dict]:
        out = []
        target = None
        if facing is not None:
            target = COMPASS_WORDS.get(str(facing).lower().replace("-", "").replace(" ", ""))
            if target is None:
                target = float(facing)
        for fa in self.facts.values():
            el = self.f.by_id(fa.id)
            if ifc_class and not el.is_a(ifc_class):
                continue
            if storey is not None and not _storey_match(storey, fa):
                continue
            if exterior is not None and fa.exterior is not exterior:
                continue
            reasons = []
            if target is not None:
                if fa.outward is None:
                    continue
                diff = bearing_diff(self.bearing(fa.outward), target)
                if diff > 45:
                    continue
                reasons.append(f"faces {compass_label(self.bearing(fa.outward))} ({diff:.0f}° off)")
            if text:
                hay = " ".join(str(x) for x in (fa.name, fa.type_name, el.Description if hasattr(el, "Description") else "",
                                                getattr(el, "ObjectType", None)) if x).lower()
                if text.lower() not in hay:
                    continue
            d = self.describe(fa)
            if reasons:
                d["match"] = "; ".join(reasons)
            out.append((fa, d))
        out = self._sort(out, sort_by)
        total = len(out)
        res = [d for _, d in out[:limit]]
        if total > limit:
            res.append({"note": f"{total - limit} more matches not shown; narrow the query or raise limit"})
        return res

    def _sort(self, items, sort_by):
        if not sort_by:
            return items
        key = sort_by.lower()
        if key in ("width", "height", "length", "thickness"):
            return sorted(items, key=lambda t: -(getattr(t[0], key) or 0))
        if key in ("elevation", "storey"):
            return sorted(items, key=lambda t: (t[0].storey_elevation if t[0].storey_elevation is not None else 1e9))
        if key.replace("most", "") in COMPASS_WORDS:  # "north" / "northmost": extremal along a direction
            d = self.direction(COMPASS_WORDS[key.replace("most", "")])
            return sorted(items, key=lambda t: -(float(t[0].center[:2] @ d) if t[0].center is not None else -1e9))
        return items

    def resolve(self, ref: str) -> ifcopenshell.entity_instance:
        """Accept '#123', '123', or a GlobalId."""
        ref = ref.strip()
        if ref.lstrip("#").isdigit():
            return self.f.by_id(int(ref.lstrip("#")))
        return self.f.by_guid(ref)


def _storey_match(q, fa: Facts) -> bool:
    if fa.storey is None:
        return False
    if isinstance(q, (int, float)) or str(q).lstrip("-").replace(".", "").isdigit():
        return fa.storey_elevation is not None and abs(fa.storey_elevation - float(q)) < 0.5
    return str(q).lower() in fa.storey.lower()


def _ray_hits_obb(origin: np.ndarray, d: np.ndarray, o: Facts, reach: float) -> bool:
    """2D ray vs oriented rectangle (slab test in the rectangle's frame)."""
    ax = o.axis
    perp = np.array([-ax[1], ax[0]])
    c = o.extras["footprint_center"]
    half = np.array([o.length / 2 + 0.05, o.thickness / 2 + 0.05])
    rel = origin - c
    p = np.array([rel @ ax, rel @ perp])
    dv = np.array([d @ ax, d @ perp])
    tmin, tmax = 0.0, reach
    for i in range(2):
        if abs(dv[i]) < 1e-12:
            if abs(p[i]) > half[i]:
                return False
        else:
            t1, t2 = (-half[i] - p[i]) / dv[i], (half[i] - p[i]) / dv[i]
            tmin, tmax = max(tmin, min(t1, t2)), min(tmax, max(t1, t2))
            if tmin > tmax:
                return False
    return True


_UNIT_CACHE: dict[int, float] = {}


def unit_scale(f: ifcopenshell.file) -> float:
    """Metres per project length unit (e.g. 0.001 for millimetre models).

    Geometry from ifcopenshell.geom is always in metres; attribute values,
    placements and quantities are in project units. Everything exposed to the
    LLM is in metres, so convert at the boundary."""
    key = id(f)
    if key not in _UNIT_CACHE:
        _UNIT_CACHE[key] = float(ifcopenshell.util.unit.calculate_unit_scale(f))
    return _UNIT_CACHE[key]


def local_matrix(f: ifcopenshell.file, el) -> np.ndarray:
    """Object placement as a 4x4 matrix with the translation in metres."""
    m = up.get_local_placement(el.ObjectPlacement) if el.ObjectPlacement else np.eye(4)
    m = np.array(m, dtype=float)
    m[:3, 3] *= unit_scale(f)
    return m
