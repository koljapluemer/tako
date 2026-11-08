import ifcopenshell
import ifcopenshell.util.element as ue
import numpy as np
import pytest

from conftest import AC20, ALL_MODELS
from tako_ifc_mcp import edits, kit, verify
from tako_ifc_mcp.spatial import unit_scale


def longest_wall(f):
    def length(w):
        try:
            return kit.wall_span(w).length
        except Exception:  # noqa: BLE001
            return 0.0
    usable = [w for w in f.by_type("IfcWall") if ue.get_container(w) is not None and w.Representation is not None]
    return max(usable, key=length)


@pytest.fixture(params=ALL_MODELS, ids=lambda p: p.stem)
def model(request):
    return ifcopenshell.open(str(request.param))


TWO = [{"pos": "right", "kind": "fixed"}, {"pos": "left", "kind": "sliding"}]


def add_window(f, wall, width=1.0, height=1.0, sill=0.9):
    along = kit.best_along(f, wall, width, sill, height)
    opening = kit.cut_opening(f, wall, along, sill, width, height, "o")
    styles = kit.styles_from(f)
    item_map = kit.rep_map(f, kit.body(f, kit.window_items(f, width, height, TWO, styles)))
    window = kit.fill_opening(f, "IfcWindow", opening, width, height, kit.mapped_body(f, item_map), "w")
    kit.assign_type(f, [window], kit.window_type(f, "t", TWO, [item_map]))
    return window, opening


def test_window_in_wall_on_every_schema_and_unit(model):
    wall = longest_wall(model)
    window, opening = add_window(model, wall)
    assert verify.check_elements(model, [window.id()]) == {"ok": True, "problems": []}
    v = edits._world_verts(window)
    assert np.isclose(np.ptp(v[:, 2]), 1.0, atol=0.01)
    assert np.isclose(window.OverallWidth * unit_scale(model), 1.0)
    assert ue.get_container(window) == ue.get_container(wall)
    kinds = [p.OperationType for p in ue.get_type(window).HasPropertySets]
    assert kinds == ["SLIDINGHORIZONTAL", "FIXEDCASEMENT"]


def test_door_in_wall_on_every_schema_and_unit(model):
    wall = longest_wall(model)
    along = kit.best_along(model, wall, 0.9, 0.0, 2.0)
    opening = kit.cut_opening(model, wall, along, 0.0, 0.9, 2.0, "o")
    door = kit.fill_opening(model, "IfcDoor", opening, 0.9, 2.0, kit.body(model, kit.door_items(model, 0.9, 2.0, kit.styles_from(model))), "d")
    assert verify.check_elements(model, [door.id()])["ok"]


def test_new_opening_really_cuts_the_wall(model):
    wall = longest_wall(model)
    before = len(edits._world_verts(wall))
    add_window(model, wall)
    assert len(edits._world_verts(wall)) > before


def test_free_intervals_avoid_existing_openings():
    f = ifcopenshell.open(str(AC20))
    wall = next(w for w in f.by_type("IfcWall") if len(w.HasOpenings or ()) >= 2 and any(b - a >= 2.0 for a, b in kit.free_intervals(f, w, 0.9, 1.0)))
    before = kit.free_intervals(f, wall, 0.9, 1.0)
    window, _ = add_window(f, wall, 0.8, 1.0)
    after = kit.free_intervals(f, wall, 0.9, 1.0)
    assert sum(b - a for a, b in after) < sum(b - a for a, b in before)
    assert verify.check_elements(f, [window.id()])["ok"]


def test_no_room_on_the_wall_is_an_error():
    f = ifcopenshell.open(str(AC20))
    with pytest.raises(edits.EditError):
        kit.best_along(f, longest_wall(f), 500.0, 0.9, 1.0)


def test_assign_type_leaves_other_users_alone():
    f = ifcopenshell.open(str(AC20))
    users = [w for w in f.by_type("IfcWindow") if ue.get_type(w) is not None]
    old = ue.get_type(users[0])
    siblings = [w for w in users if ue.get_type(w) == old and w != users[0]]
    item_map = kit.rep_map(f, kit.body(f, kit.window_items(f, 1.0, 1.0, TWO, kit.styles_from(f))))
    new = kit.window_type(f, "t", TWO, [item_map])
    kit.assign_type(f, [users[0]], new)
    assert ue.get_type(users[0]) == new
    assert siblings and all(ue.get_type(w) == old for w in siblings)


@pytest.mark.parametrize("panels", [[], [{"pos": "left", "kind": "glass"}], [{"pos": "left", "kind": "fixed"}, {"pos": "left", "kind": "fixed"}]])
def test_bad_panels_are_refused(panels):
    with pytest.raises(edits.EditError):
        kit.normalize_panels(panels)


def test_product_is_contained_and_has_geometry(model):
    storey = model.by_type("IfcBuildingStorey")[0]
    el = kit.product(model, "IfcFurnishingElement", "Bench", storey, (1.0, 1.0, 0.0), [kit.box(model, 0, 1, 0, 0.5, 0, 0.45), kit.cylinder(model, 0.2, 0.2, 0.05, 0.45, 0.8)])
    assert ue.get_container(el) == storey
    assert verify.check_elements(model, [el.id()])["ok"]
    assert np.isclose(np.ptp(edits._world_verts(el)[:, 2]), 0.8, atol=0.01)


def test_copy_storey():
    f = ifcopenshell.open(str(AC20))
    source = next(s for s in f.by_type("IfcBuildingStorey") if s.Name == "2. Obergeschoss")
    roof = next(s for s in f.by_type("IfcBuildingStorey") if s.Name == "Dachgeschoss")
    roof_elevation = roof.Elevation
    count = len([e for e in ue.get_decomposition(source) if e.is_a("IfcElement")])
    result = kit.copy_storey(f, source, "3. Obergeschoss")
    copied = [e for e in ue.get_decomposition(result["storey"]) if e.is_a("IfcElement")]
    assert len(copied) == count
    assert result["storey"].Elevation == source.Elevation + 3.0 and roof.Elevation == roof_elevation + 3.0
    assert len({e.GlobalId for e in f.by_type("IfcRoot")}) == len(f.by_type("IfcRoot"))
    wall = next(e for e in copied if e.is_a("IfcWall"))
    original_top = max(edits._world_verts(e)[:, 2].max() for e in ue.get_decomposition(source) if e.is_a("IfcWall"))
    assert edits._world_verts(wall)[:, 2].max() > original_top + 0.1
