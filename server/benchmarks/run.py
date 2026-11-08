"""Run the edit benchmark through the Claude CLI and grade the resulting IFC files.

    just bench --label baseline
    just bench --label sonnet --model sonnet --cases main_door,iter_width
    just bench --compare baseline sonnet

Runs use the CLI's own login. API credentials are removed from the child
environment so a run can never fall back to API billing. Results go to
.bench/<label>/results.json.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

import ifcopenshell

from cases import CASES, MODEL, Case, State

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH_ROOT = REPO_ROOT / ".bench"
TRANSCRIPTS = Path.home() / ".claude/projects" / str(REPO_ROOT).replace("/", "-")
TURN_TIMEOUT_S = 1200
BLOCKED_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")
USAGE_FIELDS = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens")


def write_mcp_config(path: Path, workdir: Path) -> None:
    path.write_text(json.dumps({"mcpServers": {"tako-ifc": {
        "command": "uv",
        "args": ["run", "--quiet", "--directory", "server", "tako-ifc-mcp"],
        "env": {"TAKO_MODEL": MODEL, "TAKO_WORKDIR": str(workdir)},
    }}}))


def tool_counts(session_id: str) -> dict[str, int]:
    counts: Counter[str] = Counter()
    path = TRANSCRIPTS / f"{session_id}.jsonl"
    if not path.exists():
        return {}
    for line in path.read_text().splitlines():
        record = json.loads(line)
        if record.get("type") != "assistant":
            continue
        for block in record["message"].get("content") or []:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                counts[block["name"].split("__")[-1]] += 1
    return dict(counts)


def run_turn(prompt: str, config: Path, args: argparse.Namespace, session_id: str | None) -> dict:
    command = [
        "claude", "-p", prompt, "--output-format", "json",
        "--mcp-config", str(config), "--strict-mcp-config",
        "--allowedTools", "mcp__tako-ifc", "ToolSearch",
    ]
    if args.model:
        command += ["--model", args.model]
    if args.effort:
        command += ["--effort", args.effort]
    if session_id:
        command += ["--resume", session_id]
    env = {k: v for k, v in os.environ.items() if k not in BLOCKED_ENV}
    done = subprocess.run(command, cwd=REPO_ROOT, env=env, capture_output=True, text=True, timeout=TURN_TIMEOUT_S, check=False)
    if done.returncode != 0 and not done.stdout.strip():
        raise RuntimeError(f"claude exited {done.returncode}: {done.stderr[-2000:]}")
    return json.loads(done.stdout)


def grade(case: Case, workdir: Path, reply: str) -> list[str]:
    model_dir = workdir / "example_data_AC20-Institute-Var-2"
    current = model_dir / "current.ifc"
    if not current.exists():
        return ["no working model was written"]
    history = json.loads((model_dir / "history.json").read_text())
    state = State(ifcopenshell.open(str(REPO_ROOT / MODEL)), ifcopenshell.open(str(current)), history, reply)
    try:
        return case.check(state)
    except Exception as e:  # noqa: BLE001
        return [f"check crashed: {type(e).__name__}: {e}"]


def run_case(case: Case, out: Path, args: argparse.Namespace) -> dict:
    case_dir = out / case.name
    shutil.rmtree(case_dir, ignore_errors=True)
    workdir = case_dir / "work"
    workdir.mkdir(parents=True)
    config = case_dir / "mcp.json"
    write_mcp_config(config, workdir)
    session_id = None
    turns = []
    for prompt in case.turns:
        result = run_turn(prompt, config, args, session_id)
        session_id = result.get("session_id", session_id)
        usage = result.get("usage") or {}
        turns.append({
            "prompt": prompt,
            "duration_s": round(result.get("duration_ms", 0) / 1000, 1),
            "requests": result.get("num_turns"),
            "is_error": result.get("is_error"),
            **{f: usage.get(f, 0) for f in USAGE_FIELDS},
            "reply": (result.get("result") or "")[:1500],
        })
    problems = grade(case, workdir, turns[-1]["reply"])
    return {"case": case.name, "ok": not problems, "problems": problems, "session_id": session_id, "tools": tool_counts(session_id or ""), "turns": turns}


def totals(result: dict) -> dict:
    t = {f: sum(turn[f] for turn in result["turns"]) for f in USAGE_FIELDS}
    t["duration_s"] = round(sum(turn["duration_s"] for turn in result["turns"]), 1)
    t["requests"] = sum(turn["requests"] or 0 for turn in result["turns"])
    t["last_turn_output"] = result["turns"][-1]["output_tokens"]
    t["last_turn_s"] = result["turns"][-1]["duration_s"]
    return t


def print_table(results: list[dict]) -> None:
    print(f"\n{'case':16}{'ok':>5}{'time s':>9}{'reqs':>6}{'output':>9}{'cache rd':>11}{'cache wr':>10}  tools / problems")
    for r in results:
        t = totals(r)
        detail = "; ".join(r["problems"]) if r["problems"] else json.dumps(r["tools"])
        print(f"{r['case']:16}{'yes' if r['ok'] else 'NO':>5}{t['duration_s']:>9}{t['requests']:>6}{t['output_tokens']:>9}"
              f"{t['cache_read_input_tokens']:>11}{t['cache_creation_input_tokens']:>10}  {detail[:110]}")
    passed = sum(r["ok"] for r in results)
    sums = [totals(r) for r in results]
    print(f"\npassed {passed}/{len(results)}, time {sum(t['duration_s'] for t in sums):.0f} s, output {sum(t['output_tokens'] for t in sums)} tokens")


def load(label: str) -> dict[str, dict]:
    return {r["case"]: r for r in json.loads((BENCH_ROOT / label / "results.json").read_text())}


def compare(a_label: str, b_label: str) -> None:
    a, b = load(a_label), load(b_label)
    print(f"{'case':16}{'pass':>13}{'time s':>18}{'output':>18}{'requests':>12}")
    for name in [n for n in a if n in b]:
        x, y = totals(a[name]), totals(b[name])
        ok = f"{'y' if a[name]['ok'] else 'N'} -> {'y' if b[name]['ok'] else 'N'}"
        print(f"{name:16}{ok:>13}{x['duration_s']:>9} ->{y['duration_s']:>6}{x['output_tokens']:>9} ->{y['output_tokens']:>6}{x['requests']:>6} ->{y['requests']:>3}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--label", default="latest")
    parser.add_argument("--cases", help="comma-separated names (default: all)")
    parser.add_argument("--model")
    parser.add_argument("--effort")
    parser.add_argument("--compare", nargs=2, metavar=("A", "B"))
    parser.add_argument("--regrade", action="store_true", help="re-run the checks on an existing run, without calling Claude")
    args = parser.parse_args()
    if args.compare:
        compare(*args.compare)
        return

    known = {c.name: c for c in CASES}
    names = args.cases.split(",") if args.cases else list(known)
    if unknown := [n for n in names if n not in known]:
        sys.exit(f"unknown cases: {unknown}; known: {list(known)}")

    out = BENCH_ROOT / args.label
    results_path = out / "results.json"
    if args.regrade:
        results = json.loads(results_path.read_text())
        for r in results:
            r["problems"] = grade(known[r["case"]], out / r["case"] / "work", r["turns"][-1]["reply"])
            r["ok"] = not r["problems"]
        results_path.write_text(json.dumps(results, indent=1))
        print_table(results)
        return

    out.mkdir(parents=True, exist_ok=True)
    previous = {r["case"]: r for r in json.loads(results_path.read_text())} if results_path.exists() else {}
    for name in names:
        print(f"running {name} ...", flush=True)
        previous[name] = run_case(known[name], out, args)
        results_path.write_text(json.dumps(list(previous.values()), indent=1))
    print_table([previous[n] for n in names])


if __name__ == "__main__":
    main()
