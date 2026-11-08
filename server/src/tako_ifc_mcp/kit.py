"""Tested building blocks for `run_ifcopenshell` scripts.

Every length is in metres, whatever the file's unit. Solids are described in the
coordinates of the element they will belong to. These helpers create new
entities and never edit representations or types shared with other elements.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.guid
import ifcopenshell.util.element as ue
import numpy as np

from . import edits
from .edits import EditError
from .spatial import local_matrix, unit_scale

PANEL_ORDER = ("left", "center", "right")
PANEL_POSITION = {"left": "LEFT", "center": "MIDDLE", "right": "RIGHT"}
PARTITIONING = {1: "SINGLE_PANEL", 2: "DOUBLE_PANEL_VERTICAL", 3: "TRIPLE_PANEL_VERTICAL"}
FRAME = 0.07
MULLION = 0.06
WINDOW_DEPTH = 0.07
SASH = 0.05


# ----------------------------------------------------------------------------
# file context
# ----------------------------------------------------------------------------

def _m(f, value: float) -> float:
    return float(value) / unit_scale(f)


def _point(f, xyz: Iterable[float]):
    return f.createIfcCartesianPoint(tuple(_m(f, v) for v in xyz))


def owner(f):
    """The file's owner history (IFC2X3 requires one on every rooted entity)."""
    histories = f.by_type("IfcOwnerHistory")
    return histories[0] if histories else None


def body_context(f):
    """The representation context that body geometry belongs to."""
    for ctx in f.by_type("IfcGeometricRepresentationSubContext"):
        if ctx.ContextIdentifier == "Body":
            return ctx
    for ctx in f.by_type("IfcGeometricRepresentationContext"):
        if ctx.ContextType == "Model":
            return ctx
    raise EditError("the model has no 3D representation context")


def _set_if_exists(entity, attribute: str, value) -> None:
    if hasattr(entity, attribute):
        setattr(entity, attribute, value)


def _rooted(f, ifc_class: str, name: str | None = None, **attributes):
    return f.create_entity(ifc_class, GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner(f), Name=name, **attributes)


# ----------------------------------------------------------------------------
# styles
# ----------------------------------------------------------------------------

def style(f, name: str, rgb: tuple[float, float, float], transparency: float = 0.0):
    """A new surface style. rgb and transparency are 0..1."""
    colour = f.create_entity("IfcColourRgb", None, *map(float, rgb))
    rendering = f.create_entity("IfcSurfaceStyleRendering", SurfaceColour=colour, Transparency=float(transparency), ReflectanceMethod="NOTDEFINED")
    return f.create_entity("IfcSurfaceStyle", Name=name, Side="BOTH", Styles=(rendering,))


def _apply_style(f, item, surface_style) -> None:
    if surface_style is None:
        return
    styles = (f.createIfcPresentationStyleAssignment((surface_style,)),) if f.schema == "IFC2X3" else (surface_style,)
    f.create_entity("IfcStyledItem", Item=item, Styles=styles)


def _transparency(surface_style) -> float:
    for s in surface_style.Styles or ():
        value = getattr(s, "Transparency", None)
        if value is not None:
            return float(value)
    return 0.0


def styles_from(f, reference=None) -> dict:
    """{'frame', 'sash', 'glass'} styles copied from a reference door or window,
    with neutral defaults for whatever it doesn't have."""
    found = [s for item in (edits._body_items(reference) if reference is not None else []) for s in edits._item_styles(item)]  # noqa: SLF001
    glass = max((s for s in found if _transparency(s) > 0.05), key=_transparency, default=None)
    opaque = [s for s in found if _transparency(s) <= 0.05]
    frame = max(opaque, key=lambda s: sum(x == s for x in opaque), default=None)
    frame = frame or style(f, "Rahmen", (0.75, 0.75, 0.73))
    glass = glass or style(f, "Glas", (0.6, 0.75, 0.85), 0.6)
    return {"frame": frame, "sash": frame, "glass": glass}


# ----------------------------------------------------------------------------
# solids and representations (element-local metres)
# ----------------------------------------------------------------------------

def _p2(f):
    return f.createIfcAxis2Placement2D(f.createIfcCartesianPoint((0.0, 0.0)), None)


def _extrude(f, profile, x: float, y: float, z0: float, z1: float, surface_style=None):
    position = f.createIfcAxis2Placement3D(_point(f, (x, y, z0)), None, None)
    solid = f.createIfcExtrudedAreaSolid(profile, position, f.createIfcDirection((0.0, 0.0, 1.0)), _m(f, z1 - z0))
    _apply_style(f, solid, surface_style)
    return solid


def box(f, x0: float, x1: float, y0: float, y1: float, z0: float, z1: float, surface_style=None):
    """An axis-aligned solid."""
    profile = f.createIfcRectangleProfileDef("AREA", None, _p2(f), _m(f, x1 - x0), _m(f, y1 - y0))
    return _extrude(f, profile, (x0 + x1) / 2, (y0 + y1) / 2, z0, z1, surface_style)


def cylinder(f, x: float, y: float, radius: float, z0: float, z1: float, surface_style=None):
    """A vertical cylinder."""
    return _extrude(f, f.createIfcCircleProfileDef("AREA", None, _p2(f), _m(f, radius)), x, y, z0, z1, surface_style)


def ellipse(f, x: float, y: float, radius_x: float, radius_y: float, z0: float, z1: float, surface_style=None):
    """A vertical solid with an elliptical footprint."""
    profile = f.createIfcEllipseProfileDef("AREA", None, _p2(f), _m(f, radius_x), _m(f, radius_y))
    return _extrude(f, profile, x, y, z0, z1, surface_style)


def _facing_solid(f, profile, x: float, y_back: float, z: float, depth: float, surface_style=None):
    """Extrude a profile drawn in the XZ plane toward -Y, starting at y_back."""
    position = f.createIfcAxis2Placement3D(_point(f, (x, y_back, z)), f.createIfcDirection((0.0, -1.0, 0.0)), f.createIfcDirection((1.0, 0.0, 0.0)))
    solid = f.createIfcExtrudedAreaSolid(profile, position, f.createIfcDirection((0.0, 0.0, 1.0)), _m(f, depth))
    _apply_style(f, solid, surface_style)
    return solid


def rect_ring(f, width: float, height: float, thickness: float, x: float, z: float, y_back: float, depth: float, surface_style=None):
    """A rectangular frame in the XZ plane, centred on (x, z)."""
    profile = f.createIfcRectangleHollowProfileDef("AREA", None, _p2(f), _m(f, width), _m(f, height), _m(f, thickness), None, None)
    return _facing_solid(f, profile, x, y_back, z, depth, surface_style)


def pane(f, width: float, height: float, x: float, z: float, y_back: float, depth: float, surface_style=None):
    """A flat rectangle in the XZ plane, centred on (x, z)."""
    profile = f.createIfcRectangleProfileDef("AREA", None, _p2(f), _m(f, width), _m(f, height))
    return _facing_solid(f, profile, x, y_back, z, depth, surface_style)


def body(f, items: list, representation_type: str = "SweptSolid"):
    """A new Body representation from solids."""
    return f.createIfcShapeRepresentation(body_context(f), "Body", representation_type, items)


def shape(f, representations: list):
    return f.createIfcProductDefinitionShape(None, None, representations)


def place(f, at: tuple[float, float, float] = (0.0, 0.0, 0.0), relative_to=None):
    """A local placement, `at` metres from `relative_to` (world if None)."""
    return f.createIfcLocalPlacement(relative_to, f.createIfcAxis2Placement3D(_point(f, at), None, None))


def rep_map(f, representation):
    """Wrap a representation so a type can share it between occurrences."""
    return f.createIfcRepresentationMap(f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, 0.0)), None, None), representation)


def mapped_body(f, representation_map, at: tuple[float, float, float] = (0.0, 0.0, 0.0)):
    """A Body representation that reuses a representation map, offset by `at`."""
    operator = f.createIfcCartesianTransformationOperator3D(None, None, _point(f, at), None, None)
    return body(f, [f.createIfcMappedItem(representation_map, operator)], "MappedRepresentation")


# ----------------------------------------------------------------------------
# relationships
# ----------------------------------------------------------------------------

def contain(f, elements: list, structure) -> None:
    """Put elements in a storey or space, joining its containment relation."""
    relations = structure.ContainsElements or ()
    if relations:
        relations[0].RelatedElements = list(relations[0].RelatedElements) + list(elements)
    else:
        f.create_entity("IfcRelContainedInSpatialStructure", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner(f), RelatedElements=list(elements), RelatingStructure=structure)


def assign_type(f, elements: list, element_type) -> None:
    """Make elements use `element_type`, leaving other users of their old type alone."""
    for el in elements:
        for rel in [*(getattr(el, "IsDefinedBy", None) or ()), *(getattr(el, "IsTypedBy", None) or ())]:
            if not rel.is_a("IfcRelDefinesByType"):
                continue
            remaining = [o for o in rel.RelatedObjects if o != el]
            if remaining:
                rel.RelatedObjects = remaining
            else:
                f.remove(rel)
    f.create_entity("IfcRelDefinesByType", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner(f), RelatedObjects=list(elements), RelatingType=element_type)


def add_pset(f, element, name: str, properties: dict):
    """Add a property set to one element."""
    pset = ifcopenshell.api.run("pset.add_pset", f, product=element, name=name)
    ifcopenshell.api.run("pset.edit_pset", f, pset=pset, properties=properties)
    return pset


def join_relations_of(f, reference, new_elements: list) -> None:
    """Give new elements the storey, type and material of `reference`."""
    container = ue.get_container(reference)
    if container is not None:
        contain(f, new_elements, container)
    reference_type = ue.get_type(reference)
    if reference_type is not None:
        assign_type(f, new_elements, reference_type)
    for rel in getattr(reference, "HasAssociations", None) or ():
        if rel.is_a("IfcRelAssociatesMaterial"):
            rel.RelatedObjects = list(rel.RelatedObjects) + list(new_elements)


def product(f, ifc_class: str, name: str, storey, at: tuple[float, float, float], items: list, **attributes):
    """A new element contained in `storey`. `at` is relative to the storey, and
    `items` are solids relative to `at`."""
    el = _rooted(f, ifc_class, name, ObjectPlacement=place(f, at, storey.ObjectPlacement), Representation=shape(f, [body(f, items)]), **attributes)
    contain(f, [el], storey)
    return el


# ----------------------------------------------------------------------------
# walls and openings
# ----------------------------------------------------------------------------

@dataclass
class WallSpan:
    x0: float
    x1: float
    y0: float
    y1: float
    z0: float
    z1: float

    @property
    def length(self) -> float:
        return self.x1 - self.x0

    @property
    def thickness(self) -> float:
        return self.y1 - self.y0

    @property
    def height(self) -> float:
        return self.z1 - self.z0


def wall_span(wall) -> WallSpan:
    """The wall's extent in its own coordinates. Its length runs along local X."""
    v = edits._local_verts(wall)  # noqa: SLF001
    span = WallSpan(*(float(x) for pair in zip(v.min(0), v.max(0), strict=True) for x in pair))
    if span.length <= span.thickness:
        raise EditError(f"wall #{wall.id()} doesn't run along its local X axis")
    return span


def free_intervals(f, wall, sill: float, height: float, margin: float = 0.1) -> list[tuple[float, float]]:
    """Free stretches of the wall at this height band, as (start, end) metres
    measured from the wall's start, the same measure `along` uses."""
    span = wall_span(wall)
    to_local = np.linalg.inv(local_matrix(f, wall))
    blocked = []
    for rel in wall.HasOpenings or ():
        world = edits._world_verts(rel.RelatedOpeningElement)  # noqa: SLF001
        local = (to_local[:3, :3] @ world.T).T + to_local[:3, 3]
        z0, z1 = span.z0 + sill, span.z0 + sill + height
        if local[:, 2].max() <= z0 or local[:, 2].min() >= z1:
            continue
        blocked.append((float(local[:, 0].min()) - span.x0, float(local[:, 0].max()) - span.x0))
    free, cursor = [], margin
    for start, end in sorted(blocked):
        if start - margin > cursor:
            free.append((round(cursor, 3), round(start - margin, 3)))
        cursor = max(cursor, end + margin)
    if span.length - margin > cursor:
        free.append((round(cursor, 3), round(span.length - margin, 3)))
    return free


def best_along(f, wall, width: float, sill: float, height: float) -> float:
    """Centre of the widest free stretch that fits `width`."""
    fits = [(b - a, (a + b) / 2) for a, b in free_intervals(f, wall, sill, height) if b - a >= width]
    if not fits:
        raise EditError(f"no free stretch of wall #{wall.id()} fits {width:.2f} m at this height")
    return max(fits)[1]


def cut_opening(f, wall, along: float, sill: float, width: float, height: float, name: str | None = None):
    """A new opening through `wall`. `along` is the opening's centre, measured from
    the wall's start; `sill` is its bottom, measured from the wall's base."""
    span = wall_span(wall)
    y = (span.y0 + span.y1) / 2
    half_through = span.thickness / 2 + 0.1
    placement = place(f, (span.x0 + along, y, span.z0 + sill), wall.ObjectPlacement)
    geometry = shape(f, [body(f, [box(f, -width / 2, width / 2, -half_through, half_through, 0.0, height)])])
    opening = _rooted(f, "IfcOpeningElement", name, ObjectPlacement=placement, Representation=geometry)
    _set_if_exists(opening, "PredefinedType", "OPENING")
    f.create_entity("IfcRelVoidsElement", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner(f), RelatingBuildingElement=wall, RelatedOpeningElement=opening)
    return opening


def fill_opening(f, ifc_class: str, opening, width: float, height: float, representation, name: str | None = None):
    """A door or window filling `opening`, contained in the host wall's storey.
    Its body is centred on the opening in X and starts at the sill."""
    wall = opening.VoidsElements[0].RelatingBuildingElement
    filling = _rooted(f, ifc_class, name, ObjectPlacement=place(f, relative_to=opening.ObjectPlacement), Representation=shape(f, [representation]),
                      OverallWidth=_m(f, width), OverallHeight=_m(f, height))
    f.create_entity("IfcRelFillsElement", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner(f), RelatingOpeningElement=opening, RelatedBuildingElement=filling)
    container = ue.get_container(wall)
    if container is not None:
        contain(f, [filling], container)
    return filling


# ----------------------------------------------------------------------------
# windows and doors
# ----------------------------------------------------------------------------

def normalize_panels(panels: list[dict]) -> list[dict]:
    """Validate panels and sort them left to right."""
    if not 1 <= len(panels) <= 3:
        raise EditError("a window has 1 to 3 panels")
    out = []
    for panel in panels:
        pos, kind = panel.get("pos", "center"), panel.get("kind")
        if pos not in PANEL_ORDER:
            raise EditError(f"panel pos must be one of {PANEL_ORDER}, got {pos!r}")
        if kind not in ("fixed", "sliding", "casement"):
            raise EditError(f"panel kind must be fixed, sliding or casement, got {kind!r}")
        out.append({"pos": pos, "kind": kind})
    if len({p["pos"] for p in out}) != len(out):
        raise EditError("two panels have the same pos")
    return sorted(out, key=lambda p: PANEL_ORDER.index(p["pos"]))


def _operation(panel: dict) -> str:
    if panel["kind"] == "fixed":
        return "FIXEDCASEMENT"
    if panel["kind"] == "sliding":
        return "SLIDINGHORIZONTAL"
    return "SIDEHUNGRIGHTHAND" if panel["pos"] == "right" else "SIDEHUNGLEFTHAND"


def window_items(f, width: float, height: float, panels: list[dict], styles: dict) -> list:
    """Window solids, centred on X and Y, standing on z=0."""
    panels = normalize_panels(panels)
    if width < 0.3 + len(panels) * 0.15 or height < 0.3:
        raise EditError(f"{width:.2f} x {height:.2f} m is too small for {len(panels)} panel(s)")
    y_back = WINDOW_DEPTH / 2
    items = [rect_ring(f, width, height, FRAME, 0.0, height / 2, y_back, WINDOW_DEPTH, styles["frame"])]
    inner_w, inner_h = width - 2 * FRAME, height - 2 * FRAME
    all_sliding = len(panels) > 1 and all(p["kind"] == "sliding" for p in panels)
    gap = 0.0 if all_sliding else MULLION
    cell = (inner_w - gap * (len(panels) - 1)) / len(panels)
    for i, panel in enumerate(panels):
        x = -inner_w / 2 + cell / 2 + i * (cell + gap)
        if i and gap:
            items.append(pane(f, MULLION, inner_h, x - (cell + MULLION) / 2, height / 2, y_back, WINDOW_DEPTH, styles["frame"]))
        sash_w = cell + (0.02 if all_sliding else -0.01)
        if panel["kind"] == "fixed":
            items.append(pane(f, cell, inner_h, x, height / 2, 0.003, 0.006, styles["glass"]))
            continue
        offset = (0.018 if i % 2 else -0.012) if panel["kind"] == "sliding" else 0.0
        items.append(rect_ring(f, sash_w, inner_h - 0.01, SASH, x, height / 2, offset + 0.012, 0.024, styles["sash"]))
        items.append(pane(f, sash_w - 2 * SASH, inner_h - 0.01 - 2 * SASH, x, height / 2, offset + 0.003, 0.006, styles["glass"]))
    return items


def window_type(f, name: str, panels: list[dict], representation_maps: list):
    """A new window type (IfcWindowStyle on IFC2X3) that declares its panels."""
    panels = normalize_panels(panels)
    properties = [
        f.create_entity("IfcWindowPanelProperties", GlobalId=ifcopenshell.guid.new(), OwnerHistory=owner(f), Name=f"{name} - Panel {i + 1}",
                        OperationType=_operation(p), PanelPosition=PANEL_POSITION[p["pos"]])
        for i, p in enumerate(panels)
    ]
    partitioning = PARTITIONING[len(panels)]
    if f.schema == "IFC2X3":
        return _rooted(f, "IfcWindowStyle", name, HasPropertySets=properties, RepresentationMaps=representation_maps,
                       ConstructionType="NOTDEFINED", OperationType=partitioning, ParameterTakesPrecedence=True, Sizeable=False)
    return _rooted(f, "IfcWindowType", name, HasPropertySets=properties, RepresentationMaps=representation_maps,
                   PredefinedType="WINDOW", PartitioningType=partitioning, ParameterTakesPrecedence=True)


def door_items(f, width: float, height: float, styles: dict) -> list:
    """A plain framed door, centred on X and Y, standing on z=0."""
    frame, depth = 0.06, 0.1
    leaf_thickness = 0.04
    return [
        box(f, -width / 2, -width / 2 + frame, -depth / 2, depth / 2, 0.0, height, styles["frame"]),
        box(f, width / 2 - frame, width / 2, -depth / 2, depth / 2, 0.0, height, styles["frame"]),
        box(f, -width / 2, width / 2, -depth / 2, depth / 2, height - frame, height, styles["frame"]),
        box(f, -width / 2 + frame, width / 2 - frame, -leaf_thickness / 2, leaf_thickness / 2, 0.005, height - frame, styles["sash"]),
    ]


# ----------------------------------------------------------------------------
# storeys
# ----------------------------------------------------------------------------

_SHARED_ON_COPY = (
    "IfcOwnerHistory", "IfcRepresentationContext", "IfcRepresentationMap", "IfcMaterialDefinition", "IfcPresentationStyle",
    "IfcNamedUnit", "IfcUnitAssignment", "IfcPresentationLayerAssignment",
)


def _raise_placement(f, storey, height: float) -> None:
    placement = storey.ObjectPlacement.RelativePlacement
    placement.Location = f.createIfcCartesianPoint(tuple(c + (_m(f, height) if i == 2 else 0.0) for i, c in enumerate(placement.Location.Coordinates)))


def copy_storey(f, source, name: str, height: float | None = None) -> dict:
    """Duplicate a storey directly above `source`, raising the storeys above it.
    `height` defaults to the distance to the next storey up.
    Returns {'storey': new storey, 'changed': ids}."""
    above = sorted((s for s in f.by_type("IfcBuildingStorey") if (s.Elevation or 0) > (source.Elevation or 0)), key=lambda s: s.Elevation)
    if height is None:
        if not above:
            raise EditError("nothing above this storey, so pass height")
        height = (above[0].Elevation - source.Elevation) * unit_scale(f)
    products = set(ue.get_decomposition(source)) | {source}
    parent_placement = source.ObjectPlacement.PlacementRelTo
    memo = {parent_placement.id(): parent_placement} if parent_placement is not None else {}

    def copy(entity):
        if entity.id() in memo:
            return memo[entity.id()]
        if entity.is_a("IfcObjectDefinition") and entity not in products:
            return entity
        if any(entity.is_a(t) for t in _SHARED_ON_COPY):
            return entity

        def convert(value):
            if isinstance(value, ifcopenshell.entity_instance):
                return copy(value) if value.id() else value
            if isinstance(value, (list, tuple)):
                return type(value)(convert(x) for x in value)
            return value

        attributes = list(entity)
        new = f.create_entity(entity.is_a())
        memo[entity.id()] = new
        for i, value in enumerate(attributes):
            if entity.is_a("IfcRoot") and i == 0:
                new[0] = ifcopenshell.guid.new()
            elif value is not None:
                new[i] = convert(value)
        return new

    for p in sorted(products, key=lambda x: x.id()):
        copy(p)
    new_storey = memo[source.id()]
    new_storey.Name = name
    new_storey.Elevation = source.Elevation + _m(f, height)
    _raise_placement(f, new_storey, height)

    def object_refs(rel) -> list:
        found = []
        for value in rel:
            for v in value if isinstance(value, (list, tuple)) else [value]:
                if isinstance(v, ifcopenshell.entity_instance) and v.is_a("IfcObjectDefinition"):
                    found.append(v)
        return found

    for rel in list(f.by_type("IfcRelationship")):
        refs = object_refs(rel)
        if not refs or not any(v in products for v in refs):
            continue
        if all(v in products for v in refs):
            memo.pop(rel.id(), None)
            copy(rel)
            continue
        related = [i for i in range(len(rel)) if rel.attribute_name(i).startswith("Related") and isinstance(rel[i], (list, tuple))]
        if rel.is_a("IfcRelSpaceBoundary") or not related:
            continue
        extra = [memo[v.id()] for v in rel[related[0]] if v in products]
        if extra:
            rel[related[0]] = list(rel[related[0]]) + extra

    for old_id, new in list(memo.items()):
        old = f.by_id(old_id)
        if old is new or not old.is_a("IfcRepresentationItem"):
            continue
        for styled in old.StyledByItem or ():
            f.create_entity("IfcStyledItem", Item=new, Styles=styled.Styles, Name=styled.Name)

    changed = [memo[p.id()].id() for p in products]
    for storey in above:
        _raise_placement(f, storey, height)
        storey.Elevation = storey.Elevation + _m(f, height)
        changed += [e.id() for e in ue.get_decomposition(storey)]
    return {"storey": new_storey, "changed": changed}
