from pathlib import Path

import pytest

from tako_ifc_mcp import kit_docs, server

EXAMPLES = sorted(Path(kit_docs.EXAMPLES).glob("*.py"))


def test_help_lists_functions_and_examples():
    text = kit_docs.help_text()
    assert "cut_opening" in text and "add_window_to_wall" in text
    assert "_extrude" not in text


def test_help_topics():
    assert "along" in kit_docs.help_text("cut_opening")
    assert "kit.best_along" in kit_docs.help_text("add_window_to_wall")
    assert "unknown" in kit_docs.help_text("nope")


def test_every_function_is_documented():
    undocumented = [n for n, fn in kit_docs._functions().items() if not fn.__doc__ and n not in ("shape",)]
    assert not undocumented


@pytest.mark.parametrize("example", EXAMPLES, ids=lambda p: p.stem)
def test_examples_run_and_verify(open_session, example):
    s = open_session()
    out = server.run_ifcopenshell(example.read_text(), example.stem)
    assert out["ok"], out
    assert out["verify"]["ok"], out["verify"]
    assert s.rev == 1
