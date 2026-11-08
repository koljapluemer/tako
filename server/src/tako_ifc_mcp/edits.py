"""Model edits. Rules followed by every function here:

* Never mutate entities that might be shared with other elements (type geometry,
  material sets, styles, representations). Create new ones and repoint only the
  target element.
* Return a dict with `changed` (expressIDs the viewer should highlight),
  `summary`, and `warnings` for anything that was approximated or skipped.
"""

from __future__ import annotations

import colorsys
import hashlib
from collections import Counter

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.geom
import ifcopenshell.guid
import ifcopenshell.util.element as ue
import numpy as np

from .spatial import local_matrix, unit_scale


class EditError(Exception):
    pass


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------

def _local_verts(el) -> np.ndarray:
    s = ifcopenshell.geom.settings()  # local coordinates (relative to ObjectPlacement)
    sh = ifcopenshell.geom.create_shape(s, el)
    return np.asarray(sh.geometry.verts, dtype=float).reshape(-1, 3)


def _world_verts(el) -> np.ndarray:
    s = ifcopenshell.geom.settings()
    s.set("use-world-coords", True)
    sh = ifcopenshell.geom.create_shape(s, el)
    return np.asarray(sh.geometry.verts, dtype=float).reshape(-1, 3)


def geometry_ok(el) -> str | None:
    """Return None if the element still produces geometry, else an error string."""
    try:
        v = _world_verts(el)
        return None if len(v) else "no geometry produced"
    except Exception as e:  # noqa: BLE001
        return str(e)


def _users_of(f: ifcopenshell.file, entity) -> int:
    return len(f.get_inverse(entity))


def _replace_representation(f, el, old_rep, new_rep) -> None:
    """Point `el` at a new IfcProductDefinitionShape where old_rep is swapped for
    new_rep. The old shape objects are left for anything else that uses them."""
    pds = el.Representation
    reps = [new_rep if r == old_rep else r for r in pds.Representations]
    el.Representation = f.createIfcProductDefinitionShape(pds.Name, pds.Description, reps)


def _axis_placement(f):
    return f.createIfcAxis2Placement3D(f.createIfcCartesianPoint((0.0, 0.0, 0.0)), None, None)


def _scaled_rep(f, rep, scale: np.ndarray, center: np.ndarray):
    """New representation = `rep` scaled by per-axis `scale` about local point `center`.

    Implemented as an IfcMappedItem with a non-uniform transformation operator so
    the original items (which may be shared with a type) are reused untouched.
    """
    origin = (1 - scale) * center / unit_scale(f)  # x' = s*x + (1-s)*c, in project units
    op = f.createIfcCartesianTransformationOperator3DnonUniform(
        f.createIfcDirection((1.0, 0.0, 0.0)),
        f.createIfcDirection((0.0, 1.0, 0.0)),
        f.createIfcCartesianPoint(tuple(float(x) for x in origin)),
        float(scale[0]),
        f.createIfcDirection((0.0, 0.0, 1.0)),
        float(scale[1]),
        float(scale[2]),
    )
    inner = f.createIfcShapeRepresentation(
        rep.ContextOfItems, rep.RepresentationIdentifier, rep.RepresentationType, rep.Items
    )
    rmap = f.createIfcRepresentationMap(_axis_placement(f), inner)
    item = f.createIfcMappedItem(rmap, op)
    # Carry over styles applied to the original items' representation? Styles live
    # on the items themselves, which are reused, so nothing to copy.
    return f.createIfcShapeRepresentation(rep.ContextOfItems, rep.RepresentationIdentifier, "MappedRepresentation", (item,))


def _refresh_bbox_rep(f, el, warnings: list) -> None:
    for rep in el.Representation.Representations:
        if rep.RepresentationType == "BoundingBox":
            try:
                v = _local_verts(el)
            except Exception:  # noqa: BLE001
                warnings.append("could not recompute bounding box representation")
                return
            mn, mx = v.min(0) / unit_scale(f), v.max(0) / unit_scale(f)
            bb = f.createIfcBoundingBox(f.createIfcCartesianPoint(tuple(float(x) for x in mn)), *(float(x) for x in mx - mn))
            new = f.createIfcShapeRepresentation(rep.ContextOfItems, rep.RepresentationIdentifier, "BoundingBox", (bb,))
            _replace_representation(f, el, rep, new)


def _body(el):
    for rep in el.Representation.Representations if el.Representation else ():
        if rep.RepresentationIdentifier == "Body":
            return rep
    raise EditError(f"#{el.id()} has no Body representation")


def _set_quantity(f, el, names: tuple[str, ...], value: float, changed: list) -> None:
    for rel in getattr(el, "IsDefinedBy", None) or ():
        if not rel.is_a("IfcRelDefinesByProperties"):
            continue
        qto = rel.RelatingPropertyDefinition
        if not qto.is_a("IfcElementQuantity"):
            continue
        for q in qto.Quantities:
            if q.Name in names and q.is_a("IfcQuantityLength"):
                q.LengthValue = float(value) / unit_scale(f)


# ----------------------------------------------------------------------------
# resize door / window
# ----------------------------------------------------------------------------

def resize_filling(f, el, width: float | None, height: float | None, anchor: str, force: bool) -> dict:
    """Change width/height of a door or window and its opening in the host wall."""
    if not (el.is_a("IfcDoor") or el.is_a("IfcWindow")):
        raise EditError(f"#{el.id()} is {el.is_a()}, expected IfcDoor or IfcWindow")
    if width is None and height is None:
        raise EditError("give width and/or height")
    warnings: list[str] = []
    changed = [el.id()]

    m_el = local_matrix(f, el)
    v = _local_verts(el)
    mn, mx = v.min(0), v.max(0)
    ext = mx - mn
    u = unit_scale(f)
    cur_w = el.OverallWidth * u if el.OverallWidth else float(ext[0])
    cur_h = el.OverallHeight * u if el.OverallHeight else float(ext[2])
    dw = 0.0 if width is None else width - cur_w
    dh = 0.0 if height is None else height - cur_h

    # Anchor point in the element's local frame. Width runs along local X, height
    # along local Z (IFC convention for doors and windows).
    ax = {"center": (mn[0] + mx[0]) / 2, "left": mn[0], "right": mx[0]}.get(anchor)
    if ax is None:
        raise EditError("anchor must be center, left or right")
    anchor_local = np.array([ax, (mn[1] + mx[1]) / 2, mn[2]])
    anchor_world = (m_el @ np.append(anchor_local, 1))[:3]
    x_world = m_el[:3, 0]
    z_world = m_el[:3, 2]

    # --- find the opening + host wall
    opening = host = None
    for rel in getattr(el, "FillsVoids", None) or ():
        opening = rel.RelatingOpeningElement
        for vr in getattr(opening, "VoidsElements", None) or ():
            host = vr.RelatingBuildingElement
    if opening is None:
        warnings.append("element fills no opening; only the element geometry was resized")

    # --- clearance check against the host wall and its other openings
    if host is not None and dw:
        new_lo = anchor_world @ x_world + (mn[0] - ax) * (cur_w + dw) / cur_w
        new_hi = anchor_world @ x_world + (mx[0] - ax) * (cur_w + dw) / cur_w
        lo, hi = sorted((new_lo, new_hi))
        hw = _world_verts(host) @ x_world
        problems = []
        if lo < hw.min() - 1e-3 or hi > hw.max() + 1e-3:
            problems.append(f"new extent [{lo:.2f}, {hi:.2f}] exceeds host wall #{host.id()} [{hw.min():.2f}, {hw.max():.2f}]")
        for vr in host.HasOpenings or ():
            o = vr.RelatedOpeningElement
            if o == opening:
                continue
            try:
                wv = _world_verts(o)
            except Exception:  # noqa: BLE001
                continue
            # Only openings at overlapping heights can collide.
            zs = wv @ z_world
            ez = (m_el @ np.append(mn, 1))[:3] @ z_world
            if zs.max() < ez or zs.min() > ez + cur_h + dh:
                continue
            olo, ohi = (wv @ x_world).min(), (wv @ x_world).max()
            if olo < hi - 1e-3 and ohi > lo + 1e-3:
                fill = [r.RelatedBuildingElement for r in (o.HasFillings or ())]
                problems.append(f"overlaps opening #{o.id()}" + (f" (filled by #{fill[0].id()} {fill[0].Name})" if fill else ""))
        if problems and not force:
            raise EditError("clearance check failed: " + "; ".join(problems) + ". Pass force=true to apply anyway, or pick another anchor.")
        warnings += problems

    # --- scale the element's body
    def scale_for(target, axis_world: np.ndarray, delta: float) -> tuple[int, float, float]:
        m = local_matrix(f, target)
        local_axis = m[:3, :3].T @ axis_world
        i = int(np.argmax(np.abs(local_axis)))
        if abs(local_axis[i]) < 0.99:
            raise EditError(f"#{target.id()} is not axis-aligned with #{el.id()}; cannot scale safely")
        tv = _local_verts(target)
        extent = float(np.ptp(tv[:, i]))
        c_local = (np.linalg.inv(m) @ np.append(anchor_world, 1))[:3]
        return i, (extent + delta) / extent, float(c_local[i])

    for target in [el] + ([opening] if opening is not None else []):
        scale = np.ones(3)
        center = np.zeros(3)
        if dw:
            i, s, c = scale_for(target, x_world, dw)
            scale[i], center[i] = s, c
        if dh:
            i, s, c = scale_for(target, z_world, dh)
            scale[i], center[i] = s, c
        body = _body(target)
        _replace_representation(f, target, body, _scaled_rep(f, body, scale, center))
        _refresh_bbox_rep(f, target, warnings)
        if target is not el:
            changed.append(target.id())

    if width is not None:
        el.OverallWidth = float(width) / u
        _set_quantity(f, el, ("Width",), width, changed)
        if opening is not None:
            _set_quantity(f, opening, ("Width",), width, changed)
    if height is not None:
        el.OverallHeight = float(height) / u
        _set_quantity(f, el, ("Height",), height, changed)
        if opening is not None:
            _set_quantity(f, opening, ("Height",), height, changed)

    for target in [el] + ([opening] if opening is not None else []):
        if (err := geometry_ok(target)) is not None:
            raise EditError(f"geometry of #{target.id()} broke after resize: {err}")
    if host is not None:
        changed.append(host.id())
        if (err := geometry_ok(host)) is not None:
            raise EditError(f"host wall #{host.id()} geometry broke after resize: {err}")
    if any(r.RepresentationIdentifier in ("Plan", "FootPrint", "Profile") for r in el.Representation.Representations):
        warnings.append("2D plan/profile representation was not updated")
    if getattr(el, "ProvidesBoundaries", None):
        warnings.append("space boundaries referencing this element still have the old geometry")

    parts = []
    if width is not None:
        parts.append(f"width {cur_w:.3f} -> {width:.3f} m (anchor {anchor})")
    if height is not None:
        parts.append(f"height {cur_h:.3f} -> {height:.3f} m")
    return {"changed": changed, "summary": f"resized {el.is_a()} #{el.id()} {el.Name!r}: " + ", ".join(parts), "warnings": warnings}


# ----------------------------------------------------------------------------
# materials
# ----------------------------------------------------------------------------

def material_overview(f) -> list[dict]:
    usage = Counter()
    for rel in f.by_type("IfcRelAssociatesMaterial"):
        mats = _leaf_materials(rel.RelatingMaterial)
        for m in mats:
            usage[m.id()] += len(rel.RelatedObjects)
    out = []
    for m in f.by_type("IfcMaterial"):
        style = _material_style(f, m)
        out.append({
            "id": f"#{m.id()}", "name": m.Name, "category": getattr(m, "Category", None),
            "used_by_elements": usage.get(m.id(), 0),
            "color": _style_rgb(style) if style else None,
        })
    return sorted(out, key=lambda d: -d["used_by_elements"])


def _leaf_materials(mat) -> list:
    if mat is None:
        return []
    if mat.is_a("IfcMaterial"):
        return [mat]
    if mat.is_a("IfcMaterialLayerSetUsage"):
        return _leaf_materials(mat.ForLayerSet)
    if mat.is_a("IfcMaterialLayerSet"):
        return [l.Material for l in mat.MaterialLayers if l.Material]
    if mat.is_a("IfcMaterialLayer") or mat.is_a("IfcMaterialConstituent") or mat.is_a("IfcMaterialProfile"):
        return [mat.Material] if mat.Material else []
    if mat.is_a("IfcMaterialConstituentSet"):
        return [c.Material for c in mat.MaterialConstituents or () if c.Material]
    if mat.is_a("IfcMaterialProfileSetUsage"):
        return _leaf_materials(mat.ForProfileSet)
    if mat.is_a("IfcMaterialProfileSet"):
        return [p.Material for p in mat.MaterialProfiles if p.Material]
    if mat.is_a("IfcMaterialList"):
        return list(mat.Materials)
    return []


def describe_material(f, el) -> dict | None:
    """Material summary; layer thicknesses in metres."""
    u = unit_scale(f)
    mat = ue.get_material(el)
    if mat is None:
        return None
    d = {"kind": mat.is_a(), "via_type": ue.get_material(el, should_inherit=False) is None}
    if mat.is_a("IfcMaterialLayerSetUsage") or mat.is_a("IfcMaterialLayerSet"):
        ls = mat.ForLayerSet if mat.is_a("IfcMaterialLayerSetUsage") else mat
        d["layers"] = [{"index": i, "material": l.Material.Name if l.Material else None, "thickness": round(l.LayerThickness * u, 4)}
                       for i, l in enumerate(ls.MaterialLayers)]
    else:
        d["materials"] = [m.Name for m in _leaf_materials(mat)]
    return d


def _material_style(f, mat):
    for rep in getattr(mat, "HasRepresentation", None) or ():
        for r in rep.Representations:
            for it in r.Items:
                for s in it.Styles or ():
                    if s.is_a("IfcSurfaceStyle"):
                        return s
                    if s.is_a("IfcPresentationStyleAssignment"):
                        for ss in s.Styles:
                            if ss.is_a("IfcSurfaceStyle"):
                                return ss
    return None


def _style_rgb(style):
    for st in style.Styles or ():
        if st.is_a("IfcSurfaceStyleShading"):
            c = st.SurfaceColour
            return [round(c.Red, 3), round(c.Green, 3), round(c.Blue, 3)]
    return None


def _item_styles(item) -> list:
    out = []
    for si in getattr(item, "StyledByItem", None) or ():
        for s in si.Styles or ():
            if s.is_a("IfcSurfaceStyle"):
                out.append(s)
            elif s.is_a("IfcPresentationStyleAssignment"):
                out += [x for x in s.Styles if x.is_a("IfcSurfaceStyle")]
    return out


def _body_items(el) -> list:
    """Geometric items of the body, descending into mapped items."""
    try:
        rep = _body(el)
    except EditError:
        return []
    out = []

    def walk(r):
        for it in r.Items:
            if it.is_a("IfcMappedItem"):
                walk(it.MappingSource.MappedRepresentation)
            else:
                out.append(it)
    walk(rep)
    return out


def _style_for_material(f, mat, color: list[float] | None):
    """Pick a surface style for `mat`: explicit color > material's own style >
    the style most used on elements of that material > a generated one."""
    if color is None:
        s = _material_style(f, mat)
        if s is not None:
            return s
        # Known material words beat votes: many tools (e.g. ArchiCAD) style by
        # surface finish, so "what concrete elements look like" is often plaster.
        color = _known_color(mat.Name)
    if color is None:
        votes = Counter()
        for rel in f.by_type("IfcRelAssociatesMaterial"):
            if mat not in _leaf_materials(rel.RelatingMaterial):
                continue
            for obj in rel.RelatedObjects:
                for it in _body_items(obj):
                    for st in _item_styles(it):
                        votes[st.id()] += 1
        if votes:
            return f.by_id(votes.most_common(1)[0][0])
        color = _color_from_name(mat.Name)
    style = f.createIfcSurfaceStyle(mat.Name, "BOTH", (
        f.createIfcSurfaceStyleShading(f.createIfcColourRgb(None, *map(float, color)), 0.0),
    ))
    # Also attach it to the material so other tools pick it up.
    ctx = next((c for c in f.by_type("IfcGeometricRepresentationContext") if c.ContextType == "Model"), None)
    if ctx is not None:
        si = f.createIfcStyledItem(None, (style,), None)
        f.createIfcMaterialDefinitionRepresentation(None, None, (f.createIfcStyledRepresentation(ctx, "Style", "Material", (si,)),), mat)
    return style


_KNOWN_COLORS = {  # rough defaults when nothing in the file tells us
    "concrete": (0.66, 0.66, 0.64), "beton": (0.66, 0.66, 0.64), "brick": (0.62, 0.30, 0.22),
    "ziegel": (0.62, 0.30, 0.22), "wood": (0.65, 0.48, 0.30), "holz": (0.65, 0.48, 0.30),
    "glass": (0.6, 0.75, 0.85), "glas": (0.6, 0.75, 0.85), "steel": (0.55, 0.57, 0.6),
    "stahl": (0.55, 0.57, 0.6), "aluminium": (0.75, 0.76, 0.78), "plaster": (0.92, 0.91, 0.88),
    "putz": (0.92, 0.91, 0.88), "stone": (0.55, 0.53, 0.5), "stein": (0.55, 0.53, 0.5),
}


def _known_color(name: str):
    low = (name or "").lower()
    for k, c in _KNOWN_COLORS.items():
        if k in low:
            return c
    return None


def _color_from_name(name: str) -> tuple[float, float, float]:
    low = (name or "").lower()
    h = int(hashlib.md5(low.encode()).hexdigest()[:4], 16) / 0xFFFF
    return colorsys.hls_to_rgb(h, 0.6, 0.35)


def _find_or_create_material(f, name: str, category: str | None, create: bool, warnings: list):
    if name.startswith("#") and name[1:].isdigit():
        m = f.by_id(int(name[1:]))
        if not m.is_a("IfcMaterial"):
            raise EditError(f"{name} is {m.is_a()}, not IfcMaterial")
        return m
    exact = [m for m in f.by_type("IfcMaterial") if (m.Name or "").lower() == name.lower()]
    if exact:
        return exact[0]
    if not create:
        raise EditError(f"no material named {name!r}; call list_materials, or pass create_if_missing=true")
    warnings.append(f"created new material {name!r}")
    return ifcopenshell.api.run("material.add_material", f, name=name, category=category)


def _assign_direct(f, el, mat) -> None:
    """Associate exactly `mat` with `el` only, leaving other elements alone."""
    for rel in list(getattr(el, "HasAssociations", None) or ()):
        if rel.is_a("IfcRelAssociatesMaterial"):
            if len(rel.RelatedObjects) == 1:
                rel.RelatingMaterial = mat
                return
            rel.RelatedObjects = [o for o in rel.RelatedObjects if o != el]
    f.createIfcRelAssociatesMaterial(ifcopenshell.guid.new(), None, None, None, [el], mat)


def set_material(f, el, material: str, layer_index: int | None, color: list[float] | None,
                 create_if_missing: bool, category: str | None) -> dict:
    warnings: list[str] = []
    new_mat = _find_or_create_material(f, material, category, create_if_missing, warnings)
    cur = ue.get_material(el)  # includes inherited-from-type
    note = ""

    if cur is not None and (cur.is_a("IfcMaterialLayerSetUsage") or cur.is_a("IfcMaterialLayerSet")):
        usage = cur if cur.is_a("IfcMaterialLayerSetUsage") else None
        ls = usage.ForLayerSet if usage else cur
        layers = ls.MaterialLayers
        if layer_index is None:
            if len(layers) != 1:
                raise EditError(
                    "element has a multi-layer material: "
                    + ", ".join(f"[{i}] {l.Material.Name if l.Material else '?'} {l.LayerThickness * unit_scale(f):.3f}m" for i, l in enumerate(layers))
                    + ". Pass layer_index (or ask the user which layer).")
            layer_index = 0
        if not 0 <= layer_index < len(layers):
            raise EditError(f"layer_index out of range 0..{len(layers) - 1}")
        old_name = layers[layer_index].Material.Name if layers[layer_index].Material else None
        # Copy the layer set (and usage) so other elements sharing it keep theirs.
        new_layers = []
        for i, l in enumerate(layers):
            nl = ifcopenshell.util.element.copy(f, l)
            if i == layer_index:
                nl.Material = new_mat
            new_layers.append(nl)
        new_ls = ifcopenshell.util.element.copy(f, ls)
        new_ls.MaterialLayers = new_layers
        if getattr(new_ls, "LayerSetName", None) is not None:
            new_ls.LayerSetName = f"{ls.LayerSetName} ({new_mat.Name})"
        if usage is not None:
            new_usage = ifcopenshell.util.element.copy(f, usage)
            new_usage.ForLayerSet = new_ls
            _assign_direct(f, el, new_usage)
        else:
            _assign_direct(f, el, new_ls)
        note = f"layer [{layer_index}] {old_name!r} -> {new_mat.Name!r}"
    elif cur is not None and cur.is_a("IfcMaterialConstituentSet"):
        cons = cur.MaterialConstituents or ()
        if layer_index is None and len(cons) != 1:
            raise EditError("element has constituents: " + ", ".join(
                f"[{i}] {c.Name or ''} {c.Material.Name if c.Material else '?'}" for i, c in enumerate(cons)) + ". Pass layer_index.")
        idx = layer_index or 0
        new_cons = [ifcopenshell.util.element.copy(f, c) for c in cons]
        new_cons[idx].Material = new_mat
        new_set = ifcopenshell.util.element.copy(f, cur)
        new_set.MaterialConstituents = new_cons
        _assign_direct(f, el, new_set)
        note = f"constituent [{idx}] -> {new_mat.Name!r}"
    elif cur is not None and (cur.is_a("IfcMaterialProfileSetUsage") or cur.is_a("IfcMaterialProfileSet")):
        raise EditError("profile-set materials (beams/columns) are not supported by this tool yet; use run_ifcopenshell")
    else:
        old = [m.Name for m in _leaf_materials(cur)]
        _assign_direct(f, el, new_mat)
        note = f"{old or 'none'} -> {new_mat.Name!r}"

    # --- appearance: restyle the body so the change is visible
    style = _style_for_material(f, new_mat, color)
    items = _body_items(el)
    shared = [it for it in items if _item_shared(f, el, it)]
    if shared:
        warnings.append(f"{len(shared)} geometry item(s) are shared with other elements (type geometry); "
                        "appearance not changed for those to avoid recoloring the other elements")
    for it in items:
        if it in shared:
            continue
        for si in list(getattr(it, "StyledByItem", None) or ()):
            si.Styles = [s for s in si.Styles if not (s.is_a("IfcSurfaceStyle") or s.is_a("IfcPresentationStyleAssignment"))] or [style]
            if style not in si.Styles:
                si.Styles = list(si.Styles) + [style]
        if not getattr(it, "StyledByItem", None):
            f.createIfcStyledItem(it, (style,), None)

    rgb = _style_rgb(style)
    return {"changed": [el.id()], "summary": f"material of {el.is_a()} #{el.id()} {el.Name!r}: {note}" + (f", color {rgb}" if rgb else ""),
            "warnings": warnings}


def _item_shared(f, el, item) -> bool:
    """True if `item` is reachable from any element other than `el`."""
    seen = set()
    stack = [item]
    while stack:
        e = stack.pop()
        if e.id() in seen:
            continue
        seen.add(e.id())
        for inv in f.get_inverse(e):
            if inv.is_a("IfcStyledItem") or inv.is_a("IfcPresentationLayerAssignment"):
                continue
            if inv.is_a("IfcTypeProduct"):
                # A type holding this geometry is not rendered itself; occurrences
                # that reuse it do so via IfcMappedItem and are caught by the walk.
                continue
            if inv.is_a("IfcProduct"):
                if inv != el:
                    return True
                continue
            stack.append(inv)
    return False


# ----------------------------------------------------------------------------
# properties
# ----------------------------------------------------------------------------

def set_property(f, el, pset: str, name: str, value) -> dict:
    """Set one property. Edits the element's own pset in place only if no other
    element uses it; otherwise (shared, or inherited from the type) the element
    gets its own copy, which overrides the type's values."""
    own = ue.get_psets(el, psets_only=True, should_inherit=False).get(pset)
    ps = None
    if own and own.get("id"):
        cand = f.by_id(own["id"])
        rels = [r for r in f.get_inverse(cand) if r.is_a("IfcRelDefinesByProperties")]
        if len(rels) == 1 and len(rels[0].RelatedObjects) == 1:
            ps = cand
    if ps is None:
        base = ue.get_psets(el, psets_only=True).get(pset) or {}
        ps = ifcopenshell.api.run("pset.add_pset", f, product=el, name=pset)
        carried = {k: v for k, v in base.items() if k != "id" and v is not None}
        if carried:
            ifcopenshell.api.run("pset.edit_pset", f, pset=ps, properties=carried)
    ifcopenshell.api.run("pset.edit_pset", f, pset=ps, properties={name: value})
    return {"changed": [el.id()], "summary": f"{pset}.{name} = {value!r} on #{el.id()}", "warnings": []}
