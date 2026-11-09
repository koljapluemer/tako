"""Runs one script against IFC bytes written to the virtual filesystem."""

from __future__ import annotations

import contextlib
import io
import json
import time
import traceback

import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element as ue

from . import kit, kit_docs, verify
from .spatial import SpatialIndex

MAX_OUTPUT = 8000
MAX_FAILURE_OUTPUT = 4000

# The last index a read-only script built, as (model state key, index). Building one tessellates the whole model.
_cached: tuple[str, SpatialIndex] | None = None


def _ms(since: float) -> int:
    return round((time.perf_counter() - since) * 1000)


def _tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"[output truncated: last {limit} of {len(text)} chars]\n{text[-limit:]}"


class _LazyIndex:
    """Builds the spatial index only if a script reads it, and reuses one built for the same model state.

    Only read-only scripts store what they build: a committing script may have changed
    the model by the time it reads `si`, which would file those facts under the old state.
    """

    def __init__(self, f, key: str, store: bool):
        self._f = f
        self._key = key
        self._store = store
        self._index = None
        self.build_ms = 0

    def __getattr__(self, name):
        if self._index is None:
            self._index = self._load()
        return getattr(self._index, name)

    def _load(self) -> SpatialIndex:
        global _cached  # noqa: PLW0603
        if _cached is not None and _cached[0] == self._key:
            _cached[1].f = self._f
            return _cached[1]
        started = time.perf_counter()
        index = SpatialIndex(self._f)
        self.build_ms = _ms(started)
        if self._store:
            _cached = (self._key, index)
        return index


def run(source: str, output: str, code: str, params_json: str, commit: bool, index_key: str) -> str:
    started = time.perf_counter()
    f = ifcopenshell.open(source)
    timing = {"open_ms": _ms(started)}
    index = _LazyIndex(f, index_key, store=not commit)
    ns = {
        "f": f, "si": index, "kit": kit, "PARAMS": json.loads(params_json),
        "ifcopenshell": ifcopenshell, "api": ifcopenshell.api, "ue": ue, "changed": [],
    }
    printed = io.StringIO()
    try:
        started = time.perf_counter()
        with contextlib.redirect_stdout(printed):
            exec(compile(code, "<run_ifcopenshell>", "exec"), ns)  # noqa: S102 - running model scripts is this module's job
        timing["index_ms"] = index.build_ms
        timing["exec_ms"] = _ms(started) - index.build_ms
    except (Exception, SystemExit):  # noqa: BLE001
        return json.dumps({"ok": False, "output": _tail(printed.getvalue(), MAX_FAILURE_OUTPUT), "error": traceback.format_exc(limit=3)[-MAX_FAILURE_OUTPUT:]})
    finally:
        if _cached is not None:
            _cached[1].f = None  # the cached facts must not pin a copy of the model
    text = _tail(printed.getvalue(), MAX_OUTPUT)
    if not commit:
        return json.dumps({"ok": True, "output": text, "timing": timing})
    changed = [int(c) for c in ns.get("changed") or []]
    started = time.perf_counter()
    check = verify.check_elements(f, changed)
    timing["verify_ms"] = _ms(started)
    started = time.perf_counter()
    f.write(output)
    timing["write_ms"] = _ms(started)
    return json.dumps({"ok": True, "output": text, "changed": changed, "verify": check, "timing": timing})


def kit_help(topic: str | None) -> str:
    return kit_docs.help_text(topic)
