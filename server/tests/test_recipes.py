import json

import ifcopenshell.util.element as ue
import pytest

from tako_ifc_mcp import server

SLIDING = [{"pos": "left", "kind": "sliding"}, {"pos": "right", "kind": "sliding"}]
ONE_SIDE = [{"pos": "left", "kind": "sliding"}, {"pos": "right", "kind": "fixed"}]


def _kinds(window):
    return sorted(p.OperationType for p in ue.get_type(window).HasPropertySets if p.is_a("IfcWindowPanelProperties"))


def _window(s):
    return next(w for w in s.model.by_type("IfcWindow") if w.FillsVoids)


def _free_wall(s, width=1.2):
    from tako_ifc_mcp import kit
    return next(w for w in s.model.by_type("IfcWall") if any(b - a >= width for a, b in kit.free_intervals(s.model, w, 0.9, 1.4)))


def test_set_window_panels_keeps_the_type_of_other_windows(open_session):
    s = open_session()
    w = _window(s)
    old = ue.get_type(w)
    siblings = [x.GlobalId for x in s.model.by_type("IfcWindow") if ue.get_type(x) == old and x != w]
    out = server.set_window_panels([f"#{w.id()}"], SLIDING)
    assert out["ok"], out
    assert out["verify"]["ok"]
    assert _kinds(s.model.by_guid(w.GlobalId)) == ["SLIDINGHORIZONTAL", "SLIDINGHORIZONTAL"]
    assert siblings and all(ue.get_type(s.model.by_guid(g)) == old for g in siblings)
    assert "end)" in out["summary"]


def test_revise_changes_one_side_in_a_single_undo_step(open_session):
    s = open_session()
    w = _window(s)
    first = server.set_window_panels([f"#{w.id()}"], SLIDING)
    revised = server.revise_edit(first["edit"]["edit_id"], {"panels": ONE_SIDE})
    assert revised["ok"], revised
    assert s.rev == first["revision"] == revised["revision"]
    assert len(s.history) == 1
    assert _kinds(s.model.by_guid(w.GlobalId)) == ["FIXEDCASEMENT", "SLIDINGHORIZONTAL"]
    assert server.undo()["ok"] and s.rev == 0
    assert _kinds(s.model.by_guid(w.GlobalId)) != ["FIXEDCASEMENT", "SLIDINGHORIZONTAL"]


def test_revise_matches_a_fresh_apply(open_session):
    s = open_session()
    wall = _free_wall(s)
    count = len(s.model.by_type("IfcWindow"))
    first = server.add_window(f"#{wall.id()}", 1.2, 1.4)
    assert first["ok"], first
    revised = server.revise_edit(first["edit"]["edit_id"], {"width": 1.0})
    assert revised["ok"], revised
    assert len(s.model.by_type("IfcWindow")) == count + 1
    new = [w for w in s.model.by_type("IfcWindow") if w.Name == "Fenster"]
    assert len(new) == 1 and new[0].OverallWidth == pytest.approx(1.0)
    assert revised["verify"]["ok"]


def test_failed_revise_leaves_the_revision_intact(open_session):
    s = open_session()
    w = _window(s)
    first = server.set_window_panels([f"#{w.id()}"], SLIDING)
    bad = server.revise_edit(first["edit"]["edit_id"], {"panels": [{"pos": "left", "kind": "glass"}]})
    assert not bad["ok"]
    assert _kinds(s.model.by_guid(w.GlobalId)) == ["SLIDINGHORIZONTAL", "SLIDINGHORIZONTAL"]
    assert len(s.history) == 1 and s.rev == 1


def test_only_the_latest_edit_can_be_revised(open_session):
    s = open_session()
    w = _window(s)
    first = server.set_window_panels([f"#{w.id()}"], SLIDING)
    server.set_property(f"#{w.id()}", "Pset_WindowCommon", "FireRating", "F30")
    out = server.revise_edit(first["edit"]["edit_id"], {"panels": ONE_SIDE})
    assert not out["ok"] and "latest" in out["error"]


def test_verification_failure_applies_nothing(open_session):
    s = open_session()
    w = _window(s)
    wall = w.FillsVoids[0].RelatingOpeningElement.VoidsElements[0].RelatingBuildingElement
    from tako_ifc_mcp import kit
    span = kit.wall_span(wall)
    count = len(s.model.by_type("IfcWindow"))
    occupied = next(iter(kit.free_intervals(s.model, wall, 0.9, 1.4)))[1] + 0.3
    out = server.add_window(f"#{wall.id()}", 1.0, 1.4, along=occupied)
    assert not out["ok"] and "verification failed" in out["error"]
    assert len(s.model.by_type("IfcWindow")) == count and s.rev == 0
    assert span.length > 0


def test_script_revision_by_params_and_text(open_session):
    s = open_session()
    w = _window(s)
    code = f"el = f.by_id({w.id()})\nel.Name = PARAMS['name'] + ' A'\nchanged = [el.id()]"
    first = server.run_ifcopenshell(code, "rename", params={"name": "One"})
    assert first["ok"], first
    edit_id = first["edit"]["edit_id"]
    assert server.revise_edit(edit_id, {"name": "Two"})["ok"]
    assert s.model.by_id(w.id()).Name == "Two A"
    assert server.revise_edit(edit_id, replacements=[{"old": "' A'", "new": "' B'"}])["ok"]
    assert s.model.by_id(w.id()).Name == "Two B"
    assert len(s.history) == 1
    assert not server.revise_edit(edit_id, replacements=[{"old": "absent", "new": "x"}])["ok"]


def test_get_focus_reports_selection_and_latest_edit(open_session):
    s = open_session()
    w = _window(s)
    assert server.get_focus() == {"selection": None, "latest_edit": None}
    s.selection_path.write_text(json.dumps({"expressID": w.id()}))
    server.set_window_panels([f"#{w.id()}"], SLIDING)
    focus = server.get_focus()
    assert focus["selection"]["id"] == f"#{w.id()}"
    assert focus["latest_edit"]["recipe"] == "set_window_panels"
    assert "panels" in focus["latest_edit"]["revisable"]
    s.selection_path.write_text(json.dumps({"expressID": 999_999_999}))
    assert "no longer exists" in server.get_focus()["selection_note"]


def test_old_history_without_edit_fields_still_loads(open_session, monkeypatch):
    s = open_session()
    w = _window(s)
    server.set_property(f"#{w.id()}", "Pset_WindowCommon", "FireRating", "F30")
    for key in ("edit_id", "recipe", "params", "targets", "rev_before"):
        del s.history[-1][key]
    s._write_history()
    monkeypatch.setattr(server, "_session", None)
    monkeypatch.setattr(server, "_index", None)
    again = server.session()
    assert again.rev == 1
    assert server.get_focus()["latest_edit"] is None
    assert not server.revise_edit("e1", {})["ok"]
    assert server.undo()["ok"]


def test_existing_tools_are_revisable(open_session):
    s = open_session()
    w = _window(s)
    out = server.set_property(f"#{w.id()}", "Pset_WindowCommon", "FireRating", "F30")
    assert server.revise_edit(out["edit"]["edit_id"], {"value": "F60"})["ok"]
    assert ue.get_pset(s.model.by_id(w.id()), "Pset_WindowCommon", "FireRating") == "F60"
