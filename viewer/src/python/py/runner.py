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
import numpy as np

from . import kit, kit_docs, verify
from .spatial import GEOMETRY_ROW, SpatialIndex

MAX_OUTPUT = 8000
MAX_FAILURE_OUTPUT = 4000

# The parsed model for one model state, kept between scripts so each doesn't reopen the IFC.
_model: tuple[str, ifcopenshell.file] | None = None
# The last index a read-only script built for that state.
_index: tuple[str, SpatialIndex] | None = None


def _ms(since: float) -> int:
    return round((time.perf_counter() - since) * 1000)


def _tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return f"[output truncated: last {limit} of {len(text)} chars]\n{text[-limit:]}"


def _drop() -> None:
    global _model, _index  # noqa: PLW0603
    _model = _index = None


def _geometry(directory: str | None) -> dict[int, np.ndarray] | None:
    """Rows the viewer measured, written by the worker as ids.bin and values.bin."""
    if directory is None:
        return None
    ids = np.fromfile(f"{directory}/ids.bin", dtype="<i4")
    values = np.fromfile(f"{directory}/values.bin", dtype="<f8").reshape(-1, GEOMETRY_ROW)
    return dict(zip(ids.tolist(), values, strict=True))


def _open(key: str, source: str | None) -> tuple[ifcopenshell.file | None, int]:
    """The model for `key`: the kept one, else `source` parsed and kept. None if neither is available."""
    global _model, _index  # noqa: PLW0603
    if _model is not None and _model[0] == key:
        return _model[1], 0
    if source is None:
        return None, 0
    _drop()
    started = time.perf_counter()
    f = ifcopenshell.open(source)
    _model = (key, f)
    return f, _ms(started)


class _LazyIndex:
    """Builds the spatial index only if a script reads it, and reuses one built for the same model state.

    Only read-only scripts store what they build: a committing script may have changed
    the model by the time it reads `si`, which would file those facts under the old state.
    """

    def __init__(self, f, key: str, store: bool, geometry_dir: str | None):
        self._f = f
        self._key = key
        self._store = store
        self._geometry_dir = geometry_dir
        self._index = None
        self.build_ms = 0

    def __getattr__(self, name):
        if self._index is None:
            self._index = self._load()
        return getattr(self._index, name)

    def _load(self) -> SpatialIndex:
        global _index  # noqa: PLW0603
        if _index is not None and _index[0] == self._key:
            return _index[1]
        started = time.perf_counter()
        index = SpatialIndex(self._f, _geometry(self._geometry_dir))
        self.build_ms = _ms(started)
        if self._store:
            _index = (self._key, index)
        return index


def prime(key: str, source: str, geometry_dir: str | None) -> str:
    """Parses the model ahead of the first script, and builds its index when that is cheap."""
    global _index  # noqa: PLW0603
    f, open_ms = _open(key, source)
    timing = {"open_ms": open_ms}
    if geometry_dir is not None and (_index is None or _index[0] != key):
        started = time.perf_counter()
        _index = (key, SpatialIndex(f, _geometry(geometry_dir)))
        timing["index_ms"] = _ms(started)
    return json.dumps({"ok": True, "timing": timing})


def run(key: str, source: str | None, output: str, code: str, params_json: str, commit: bool, geometry_dir: str | None) -> str:
    f, open_ms = _open(key, source)
    if f is None:
        return json.dumps({"ok": False, "stale": True})
    timing = {"open_ms": open_ms}
    if not commit:
        # Read-only scripts share the kept model, so anything they change must be noticed.
        f.begin_transaction()
    index = _LazyIndex(f, key, store=not commit, geometry_dir=geometry_dir)
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
        failed = {"ok": False, "output": _tail(printed.getvalue(), MAX_FAILURE_OUTPUT), "error": traceback.format_exc(limit=3)[-MAX_FAILURE_OUTPUT:]}
        return json.dumps({**failed, "held": _release(f, commit)})
    text = _tail(printed.getvalue(), MAX_OUTPUT)
    if not commit:
        held = _release(f, commit)
        return json.dumps({"ok": True, "output": text, "held": held, "timing": timing})
    try:
        changed = [int(c) for c in ns.get("changed") or []]
        started = time.perf_counter()
        check = verify.check_elements(f, changed)
        timing["verify_ms"] = _ms(started)
        started = time.perf_counter()
        f.write(output)
        timing["write_ms"] = _ms(started)
    finally:
        _release(f, commit)
    return json.dumps({"ok": True, "output": text, "changed": changed, "verify": check, "held": False, "timing": timing})


def _release(f: ifcopenshell.file, commit: bool) -> bool:
    """Ends a run; True if the model is still kept. A changed model is dropped rather than rolled back."""
    if commit:
        _drop()
        return False
    transaction = f.transaction
    if transaction is None or transaction.operations:
        f.transaction = None
        _drop()
        return False
    f.discard_transaction()
    return True


def kit_help(topic: str | None) -> str:
    return kit_docs.help_text(topic)
