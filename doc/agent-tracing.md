# Agent tracing and benchmark

`just vr-agent` writes one JSONL file per session to `work/traces/`. The events
are listed at the top of `bridge/src/trace.ts`.

## Reading a trace

`just trace-report` summarises the newest trace; `just trace-report path/to/file.jsonl`
reads a specific one. For each request it shows total, tool and model time, each
tool call with its phases, and tokens.

Phases of a `tool` event, in milliseconds:

| Phase | Meaning |
|---|---|
| `snapshot_ms` | Counting classes and saving the pre-edit model for rollback |
| `apply_ms` | Applying the command, including any script |
| `serialize_ms` | Writing the edited model to bytes |
| `reopen_ms` | Reopening the edited model to confirm it parses |
| `persist_ms` | Saving the revision to OPFS |
| `render_ms` | Rebuilding all geometry |
| `swap_ms` | Swapping the built geometry into the scene and refreshing the project picker |
| `pyodide_load_ms` | Python cold start, reported by the first script after it; usually absent, since Python starts when the agent connects |
| `open_ms` | Python parsing the IFC; 0 when it reused the model it kept |
| `index_ms` | Building `si`; 0 if the script didn't read it or reused the cached index |
| `exec_ms` | Running the script, excluding `index_ms` |
| `verify_ms`, `write_ms` | Checking changed elements and writing the IFC, for committing scripts |

Traces recorded before these phases existed have `publish_ms` instead of
`swap_ms`, and no other phases.

A `model` event records one attempt to open a model in web-ifc, with `ok: false`
when it failed. The browser replays its last 20 when it connects to a bridge, so a
trace can start with opens that happened before the session. Use `at`, the time
the browser opened the model, rather than `ts`. A socket reconnect can repeat them.

## Benchmark

`bridge/benchmark/cases.json` holds prompts that work on any IFC and need no
selection. Each case states the expected number of new revisions and the expected
entity count change per IFC class, checked against what the edit really did.

1. Start `just viewer`, then the agent with
   `node --env-file=deploy/.env bridge/dist/vr-agent.js`. (`just vr-agent` also
   runs `adb reverse`, which fails without a connected headset.)
2. Open a building whose revisions you can spare. The cases really edit it.
3. Run `just benchmark`, then `just trace-report`.

Claude restarts before each case, so cases don't share context. The benchmark
takes over the agent connection, so reload the viewer before using voice again.

Run it on several varied models and compare across all of them, so changes aren't
tuned to one file. A case fails, without indicating a bug, on a model that lacks
what it needs, such as windows on the lowest storey.
