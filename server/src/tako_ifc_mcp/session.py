"""Model session: one working IFC file, saved as numbered revisions.

Layout of the work root (default <repo>/work):
    selected.json        {"model": "<repo-relative path>"}: which model is active.
                         Written by open_model and by the viewer's model picker;
                         the server follows it before every tool call.
    <model-slug>/        one directory per model, so each keeps its own history:
    current.ifc          the file the viewer watches
    revisions/0000.ifc   pristine copy of the source model
    revisions/NNNN.ifc   state after edit N
    history.json         [{rev, summary, changed: [expressID, ...], edit_id, recipe, params, targets, rev_before}]
    selection.json       {"expressID": n}: what is selected in the viewer
    edits/<edit_id>.py   code of edits made by script, for revise_edit
    last_change.json     what the most recent edit touched (viewer highlights it)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path

import ifcopenshell

REPO_ROOT = Path(__file__).resolve().parents[3]


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    if not raw:
        return default
    p = Path(raw)
    return p if p.is_absolute() else (REPO_ROOT / p)


def slug(source: Path) -> str:
    try:
        rel = source.resolve().relative_to(REPO_ROOT)
    except ValueError:
        rel = Path(source.name)
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(rel.with_suffix("")))


@dataclass
class Session:
    source: Path
    workroot: Path
    model: ifcopenshell.file = field(init=False)
    history: list[dict] = field(init=False, default_factory=list)
    # Bumped on every model change; caches compare against it.
    generation: int = field(init=False, default=0)

    @classmethod
    def from_env(cls) -> "Session":
        source = _env_path("TAKO_MODEL", REPO_ROOT / "example_data" / "AC20-Institute-Var-2.ifc")
        workroot = _env_path("TAKO_WORKDIR", REPO_ROOT / "work")
        selected = cls._read_selected(workroot)
        if selected is not None and selected.exists():
            source = selected  # the viewer (or a previous session) picked a model
        s = cls(source=source, workroot=workroot)
        s.open(source, resume=os.environ.get("TAKO_RESUME", "1") != "0")
        return s

    # -- model selection (shared with the viewer) ----------------------------
    @staticmethod
    def _read_selected(workroot: Path) -> Path | None:
        try:
            rel = json.loads((workroot / "selected.json").read_text())["model"]
        except (OSError, ValueError, KeyError):
            return None
        p = Path(rel)
        return (p if p.is_absolute() else REPO_ROOT / p).resolve()

    def _write_selected(self) -> None:
        try:
            rel = str(self.source.relative_to(REPO_ROOT))
        except ValueError:
            rel = str(self.source)
        self.workroot.mkdir(parents=True, exist_ok=True)
        path = self.workroot / "selected.json"
        try:
            if json.loads(path.read_text()).get("model") == rel:
                return
        except (OSError, ValueError):
            pass
        path.write_text(json.dumps({"model": rel}))

    def sync_selection(self) -> bool:
        """Switch to the model selected in the viewer, if it changed. Returns True on switch."""
        sel = self._read_selected(self.workroot)
        if sel is None or sel == self.source or not sel.exists():
            return False
        self.open(sel, resume=True)
        return True

    # -- paths ---------------------------------------------------------------
    @property
    def workdir(self) -> Path:
        return self.workroot / slug(self.source)

    @property
    def current_path(self) -> Path:
        return self.workdir / "current.ifc"

    @property
    def rev_dir(self) -> Path:
        return self.workdir / "revisions"

    def _rev_path(self, rev: int) -> Path:
        return self.rev_dir / f"{rev:04d}.ifc"

    @property
    def selection_path(self) -> Path:
        return self.workdir / "selection.json"

    @property
    def edits_dir(self) -> Path:
        return self.workdir / "edits"

    @property
    def history_path(self) -> Path:
        return self.workdir / "history.json"

    # -- lifecycle -----------------------------------------------------------
    def open(self, source: Path, resume: bool = True) -> None:
        """Open `source`. With resume=True and a work dir created from the same
        source, continue from its latest revision instead of starting over."""
        source = source.resolve()
        self.source = source
        self._write_selected()
        self.rev_dir.mkdir(parents=True, exist_ok=True)
        meta_path = self.workdir / "source.json"
        same_source = meta_path.exists() and json.loads(meta_path.read_text()).get("source") == str(source)
        if resume and same_source and self.history_path.exists() and self._rev_path(0).exists():
            self.history = json.loads(self.history_path.read_text())
            latest = self.history[-1]["rev"] if self.history else 0
            self.model = ifcopenshell.open(str(self._rev_path(latest)))
        else:
            for p in self.rev_dir.glob("*.ifc"):
                p.unlink()
            shutil.copyfile(source, self._rev_path(0))
            meta_path.write_text(json.dumps({"source": str(source)}))
            self.history = []
            self._write_history()
            self.model = ifcopenshell.open(str(self._rev_path(0)))
        self._publish(changed=[], summary="opened model")
        self.generation += 1

    @property
    def rev(self) -> int:
        return self.history[-1]["rev"] if self.history else 0

    def commit(self, summary: str, changed: list[int], edit: dict | None = None, replace_last: bool = False) -> int:
        """Persist the in-memory model as a revision and notify the viewer.

        `edit` records how to redo it. With replace_last the latest revision is
        overwritten in place, so one undo still goes back past the whole edit."""
        record = dict(edit or {})
        if replace_last:
            last = self.history.pop()
            rev = last["rev"]
            changed = [*changed, *last["changed"]]
            record["edit_id"] = last["edit_id"]
        else:
            rev = self.rev + 1
            record["edit_id"] = f"e{rev}"
        self.model.write(str(self._rev_path(rev)))
        self.history.append({"rev": rev, "summary": summary, "changed": sorted(set(changed)), "time": time.time(), **record})
        self._write_history()
        self._publish(changed=changed, summary=summary)
        self.generation += 1
        return rev

    def undo(self, steps: int = 1) -> dict:
        if not self.history:
            return {"ok": False, "message": "nothing to undo"}
        steps = max(1, min(steps, len(self.history)))
        undone = self.history[-steps:]
        self.history = self.history[:-steps]
        for h in undone:
            self._rev_path(h["rev"]).unlink(missing_ok=True)
        self.model = ifcopenshell.open(str(self._rev_path(self.rev)))
        self._write_history()
        changed = sorted({i for h in undone for i in h["changed"]})
        self._publish(changed=changed, summary=f"undo: {', '.join(h['summary'] for h in undone)}")
        self.generation += 1
        return {"ok": True, "undone": [h["summary"] for h in undone], "now_at_revision": self.rev}

    def open_revision(self, rev: int) -> None:
        """Load an older revision for re-applying an edit. Not published; reload() returns to the latest."""
        self.model = ifcopenshell.open(str(self._rev_path(rev)))

    def reload(self) -> None:
        """Discard unsaved in-memory changes. The content matches the current
        revision again, so caches keyed on `generation` stay valid."""
        self.model = ifcopenshell.open(str(self._rev_path(self.rev)))

    # -- internals -----------------------------------------------------------
    def _write_history(self) -> None:
        self.history_path.write_text(json.dumps(self.history, indent=1))

    def _publish(self, changed: list[int], summary: str) -> None:
        # Write to a temp file then rename, so the viewer never reads a half-written file.
        tmp = self.current_path.with_suffix(".ifc.tmp")
        shutil.copyfile(self._rev_path(self.rev), tmp)
        os.replace(tmp, self.current_path)
        (self.workdir / "last_change.json").write_text(
            json.dumps({"rev": self.rev, "summary": summary, "changed": sorted(set(changed)), "time": time.time()})
        )
