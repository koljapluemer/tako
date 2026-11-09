"""Text for the kit_help tool, generated from the kit itself so it can't drift."""

from __future__ import annotations

import inspect
from pathlib import Path

from . import kit

EXAMPLES = Path(__file__).parent / "kit_examples"


def _functions() -> dict:
    return {name: fn for name, fn in inspect.getmembers(kit, inspect.isfunction)
            if not name.startswith("_") and fn.__module__ == kit.__name__}


def _summary(obj) -> str:
    return (inspect.getdoc(obj) or "").split("\n")[0]


def _example_summary(path: Path) -> str:
    source = path.read_text()
    return source.split('"""')[1].strip() if source.startswith('"""') else ""


def help_text(topic: str | None = None) -> str:
    functions = _functions()
    if topic is None:
        lines = ["kit functions, all lengths in metres; `f` is the first argument unless the signature says otherwise:"]
        lines += [f"  {name}{inspect.signature(fn)}: {_summary(fn)}" for name, fn in functions.items()]
        lines += ["", "worked examples (kit_help('<name>') shows the code):"]
        lines += [f"  {p.stem}: {_example_summary(p)}" for p in sorted(EXAMPLES.glob("*.py"))]
        return "\n".join(lines)
    if topic in functions:
        fn = functions[topic]
        return f"{topic}{inspect.signature(fn)}\n{inspect.getdoc(fn) or ''}"
    example = EXAMPLES / f"{topic}.py"
    if example.exists():
        return example.read_text()
    return f"unknown topic {topic!r}. Call kit_help() for the list."
