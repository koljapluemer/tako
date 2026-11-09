"""Runs one script against IFC bytes written to the virtual filesystem."""

from __future__ import annotations

import contextlib
import io
import json
import traceback

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as ue

from . import kit, kit_docs, verify
from .spatial import SpatialIndex


class _LazyIndex:
    """Builds the spatial index only if a script reads it: it tessellates the whole model."""

    def __init__(self, f):
        self._f = f
        self._index = None

    def __getattr__(self, name):
        if self._index is None:
            self._index = SpatialIndex(self._f)
        return getattr(self._index, name)


def run(source: str, output: str, code: str, params_json: str, commit: bool) -> str:
    f = ifcopenshell.open(source)
    ns = {
        "f": f, "si": _LazyIndex(f), "kit": kit, "PARAMS": json.loads(params_json),
        "ifcopenshell": ifcopenshell, "api": ifcopenshell.api, "ue": ue, "changed": [],
    }
    printed = io.StringIO()
    try:
        with contextlib.redirect_stdout(printed):
            exec(compile(code, "<run_ifcopenshell>", "exec"), ns)  # noqa: S102 - running model scripts is this module's job
    except (Exception, SystemExit):  # noqa: BLE001
        return json.dumps({"ok": False, "output": printed.getvalue()[-4000:], "error": traceback.format_exc(limit=3)[-4000:]})
    if not commit:
        return json.dumps({"ok": True, "output": printed.getvalue()[-8000:]})
    changed = [int(c) for c in ns.get("changed") or []]
    check = verify.check_elements(f, changed)
    f.write(output)
    return json.dumps({"ok": True, "output": printed.getvalue()[-8000:], "changed": changed, "verify": check})


def kit_help(topic: str | None) -> str:
    return kit_docs.help_text(topic)
