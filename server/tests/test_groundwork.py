import json

import ifcopenshell.guid
import numpy as np

from tako_ifc_mcp import server, verify
from tako_ifc_mcp.spatial import SpatialIndex


def _north_window(si):
    return next(fa for fa in si.facts.values() if fa.ifc_class == "IfcWindow" and fa.exterior and fa.outward is not None)


def test_read_only_script_keeps_the_index_and_stays_on_the_live_model(open_session):
    s = open_session()
    before = server.index()
    generation = s.generation
    out = server.run_ifcopenshell("print(len(si.facts))", "inspect", commit=False)
    assert out["ok"] and int(out["output"]) == len(before.facts)
    assert server.index() is before and s.generation == generation
    fa = _north_window(before)
    server.index().resolve(f"#{fa.id}").Name = "Through index"
    assert s.model.by_id(fa.id).Name == "Through index"


def test_failed_script_discards_changes_and_keeps_the_index(open_session):
    s = open_session()
    before = server.index()
    fa = _north_window(before)
    out = server.run_ifcopenshell(f"f.by_id({fa.id}).Name = 'BROKEN'\nraise ValueError('nope')", "broken")
    assert not out["ok"]
    assert s.model.by_id(fa.id).Name != "BROKEN"
    assert server.index() is before


def test_commit_invalidates_the_index_and_reports_verification(open_session):
    s = open_session()
    before = server.index()
    fa = _north_window(before)
    out = server.run_ifcopenshell(f"f.by_id({fa.id}).Name = 'Renamed'\nchanged = [{fa.id}]", "rename")
    assert out["ok"] and out["verify"]["ok"]
    assert server.index() is not before
    assert server.index().facts[fa.id].name == "Renamed"
    assert s.rev == 1


def test_verify_accepts_existing_windows(ac20):
    ids = [w.id() for w in ac20.by_type("IfcWindow")[:10]]
    assert verify.check_elements(ac20, ids)["ok"]


def test_verify_catches_a_window_without_an_opening(open_session):
    s = open_session()
    w = s.model.by_type("IfcWindow")[0]
    for rel in list(w.FillsVoids):
        s.model.remove(rel)
    result = verify.check_elements(s.model, [w.id()])
    assert not result["ok"] and "fills no opening" in result["problems"][0]


def test_verify_catches_overlapping_openings(open_session):
    s = open_session()
    f = s.model
    w = next(w for w in f.by_type("IfcWindow") if w.FillsVoids)
    opening = w.FillsVoids[0].RelatingOpeningElement
    wall = opening.VoidsElements[0].RelatingBuildingElement
    twin = f.createIfcOpeningElement(ifcopenshell.guid.new(), opening.OwnerHistory, "twin", None, None,
                                     opening.ObjectPlacement, opening.Representation, None)
    f.createIfcRelVoidsElement(ifcopenshell.guid.new(), opening.OwnerHistory, None, None, wall, twin)
    result = verify.check_elements(f, [w.id()])
    assert not result["ok"] and "overlaps opening" in result["problems"][0]


def test_verify_ignores_deleted_elements(ac20):
    assert verify.check_elements(ac20, [999_999_999])["ok"]


def test_rooms_are_neighbours_only_side_by_side(ac20):
    si = SpatialIndex(ac20)
    wc = next(r for r in si.rooms.values() if r.name == "314")
    assert wc.neighbours
    for n in wc.neighbours:
        other = si.rooms[n]
        assert other.storey == wc.storey, other.name
        assert np.linalg.norm(np.maximum(np.maximum(other.bbox_min - wc.bbox_max, wc.bbox_min - other.bbox_max), 0)) <= 0.8


def test_context_around_room_and_element_is_compact(ac20):
    si = SpatialIndex(ac20)
    by_name = si.context_around("314", 1.5, 10)
    assert by_name["target"]["long_name"] == "WC Damen"
    assert len(by_name["nearby"]) == 10 and by_name["omitted"] > 0
    assert len(json.dumps(by_name)) < 6000
    window = _north_window(si)
    around = si.context_around(f"#{window.id}", 1.0, 10)
    assert around["room"]["id"].startswith("#")
    assert any(row["id"] == f"#{window.host}" for row in around["nearby"])


def test_context_around_unknown_target(ac20):
    assert "error" in SpatialIndex(ac20).context_around("no such room")
