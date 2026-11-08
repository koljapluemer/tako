# Moving tako's business logic into the browser

Status: architecture options and migration plan, not an implementation specification. Research checked 2026-11-08.

## Executive decision

The recommended end state is a static web application whose IFC document, semantic index, edit recipes, validation, history and persistence all run in a dedicated browser worker, implemented in TypeScript on `web-ifc`. Keep a very small local TypeScript MCP bridge only for the current external-chat workflow. The bridge should transport tool calls and events; it must not own the model or contain IFC business rules.

Do **not** make Pyodide + IfcOpenShell the production architecture. It is the fastest way to prove that a browser can reproduce the current Python behavior, and may be valuable as a temporary differential-testing oracle, but it moves rather than removes the large runtime and memory cost. IfcOpenShell's own documentation calls its browser technology preview “incredibly heavy” and warns of a long load time, even though it exposes the full API ([IfcOpenShell WebAssembly installation notes](https://docs.ifcopenshell.org/ifcopenshell-python/installation.html#web-assembly)).

This recommendation deliberately separates two questions:

1. **Where does IFC business logic run?** In the user's browser.
2. **How does an external MCP client reach a browser tab?** Through a replaceable local relay, an embedded chat client, or a future host integration. A public static page cannot listen on stdio or accept inbound HTTP from Claude Code.

“Fully client-side business logic” is therefore achievable without claiming that every deployment mode is literally serverless. Static asset hosting and an optional zero-domain-logic relay are not application backends.

## What has to move

Today the split is not “viewer versus API”; it is two different IFC engines and two sources of truth:

| Concern | Current owner | Browser-native target |
|---|---|---|
| Parsing, tessellation, inspection | `viewer/src/ifc-worker.ts`, `web-ifc` | One long-lived document worker |
| Model selection and selected element | Node filesystem plus HTTP endpoints | Browser project store and worker messages |
| Semantic facts and reference resolution | Python `SpatialIndex` + NumPy | TypeScript indexes built from IFC entities and tessellated bounds |
| Recipes and low-level mutation | IfcOpenShell Python | Typed TypeScript commands over `web-ifc` entities |
| Verification and transactional rollback | Python model reload | Validate a candidate transaction before publishing it |
| Revisions and undo | Complete IFC snapshots on disk | Command log plus bounded checkpoints in OPFS |
| Viewer refresh | File publication and HTTP polling/HMR | Worker event with affected express IDs and changed geometry |
| MCP tools | Python MCP server over stdio | Thin local TS bridge forwarding to a live tab, or embedded chat |
| `run_ifcopenshell` | Arbitrary Python `exec` | No direct equivalent; replace with a constrained edit plan/command IR |

The current viewer already proves that browser-side parsing and geometry generation work on the supported model corpus. `web-ifc` is explicitly a browser/Node WebAssembly library for reading **and writing** IFC ([project documentation](https://github.com/ThatOpen/engine_web-ifc)); the installed API also exposes `WriteLine`, `DeleteLine`, `CreateIfcEntity`, `SaveModel` and callback-based saving. That is sufficient substrate, not parity with IfcOpenShell's high-level API. Relationships, inverse consistency, units, owner history, placements, representation sharing and schema differences become tako's responsibility.

## Options

### A. Port the Python stack to Pyodide

Load Pyodide, NumPy and the IfcOpenShell WASM wheel in a worker, then adapt filesystem calls to browser storage. This preserves the greatest amount of `spatial.py`, `edits.py`, `kit.py`, recipes and verification code.

Advantages:

- Shortest route to behavioral parity and a useful way to establish browser performance baselines.
- Existing recipes, schema handling and IfcOpenShell utilities survive with fewer semantic rewrites.
- `run_ifcopenshell` remains technically possible inside the browser sandbox.

Costs and warnings:

- It retains CPython, NumPy and IfcOpenShell in the client. Pyodide recommends workers for long-running computation because main-thread execution can make the UI unresponsive ([Pyodide worker guidance](https://pyodide.org/en/stable/usage/index.html#web-workers)).
- First load, decompression, compilation and heap growth move to every client, including headsets and mobile hardware. Cache hits improve repeat visits but do not reduce runtime memory.
- The viewer would probably hold the model twice: once in IfcOpenShell and again in `web-ifc`, plus exported IFC bytes and tessellated geometry during refresh. This is the same architectural duplication as today in a smaller address space.
- Python-to-JavaScript crossings complicate cancellation, progress, typed errors and disposal. Pyodide proxy objects should be explicitly destroyed rather than left to nondeterministic finalization ([Pyodide JS API](https://pyodide.org/en/latest/usage/api/js-api.html)).
- Packaging depends on third-party WASM wheels and their Python/Pyodide/IfcOpenShell version matrix. Native dependencies cannot be treated like ordinary PyPI packages.

Verdict: build a time-boxed spike if it materially reduces porting risk; do not select it as the destination merely because it minimizes the initial diff.

### B. Rewrite the domain core in TypeScript on `web-ifc` (recommended)

Use the IFC engine already shipped to the browser as the only open model. Port semantic indexing and the named recipes into an engine-independent TypeScript domain layer, with a narrow adapter around `web-ifc` reads and writes.

Advantages:

- One IFC parse, one model identity and one worker-owned source of truth.
- Small runtime compared with a Python scientific stack; the existing single-threaded `web-ifc` WASM in this repository is roughly 1.6 MB on disk.
- Direct integration with the viewer's geometry, picking, change highlighting and browser persistence.
- Static hosting and offline/PWA operation are natural rather than emulated.
- Strong types can make recipe parameters, results and migrations explicit.

Costs and warnings:

- This is a real rewrite. `web-ifc` provides entity-level mutation and serialization, not drop-in equivalents for `ifcopenshell.api`, `util.element`, geometry helpers or NumPy calculations.
- Each edit must explicitly preserve graph integrity. Updating a line is easy; correctly cloning shared representations/material sets, maintaining relationship entities and regenerating affected geometry is the work.
- Schema coverage must be tested across IFC2X3, IFC4 and IFC4X3. Generated TypeScript classes do not remove semantic differences between schemas.
- `web-ifc` is under active development. Pin the exact JS and WASM pair, keep regression fixtures, and never replace only one artifact; its project documentation explicitly warns that live-build replacement requires both ([web-ifc build notes](https://github.com/ThatOpen/engine_web-ifc#current-build)).

Verdict: preferred production architecture, gated by the mutation and round-trip spikes below.

### C. Keep a thin remote or local compute service

Move the Python service to on-demand jobs, serverless containers, or a user's local machine while leaving the browser primarily a viewer.

This can remove an always-warm VPS and may be the lowest operational change, but it does not meet the stated architectural goal: the service still owns model state and business behavior. Cold start, model transfer, job cancellation and concurrent revision control replace the current memory problem. Treat this only as a fallback for operations proven infeasible in the browser, and make such operations explicit capability extensions rather than silently routing ordinary edits to a server.

### D. Hybrid TypeScript core with a temporary Pyodide fallback

Port read tools and named recipes incrementally, dispatching unsupported operations to IfcOpenShell in a second worker.

This permits gradual delivery but risks becoming permanent dual-engine architecture. It also requires serializing the whole IFC between engines, invalidating indexes and proving that both engines interpret representations consistently. If used, give the fallback a removal date and telemetry that records exactly which capability required it.

## Recommended architecture

### Worker-owned document

The IFC model must be owned by one dedicated worker. UI, XR and MCP adapters send typed commands; they never mutate `web-ifc` directly.

```text
UI / XR ───────────────┐
                       │ typed requests and events
optional MCP bridge ───┼──> Document worker
                       │      ├─ web-ifc model + serialization
import/export UI ──────┘      ├─ semantic/spatial indexes
                              ├─ recipe executor + verifier
                              ├─ command log + checkpoints
                              └─ geometry extraction
                                       │
                                  OPFS project store
```

Use request IDs, cancellation and progress as protocol primitives. Transfer `ArrayBuffer`s instead of cloning them when ownership genuinely moves. Avoid having a second worker open the same IFC merely to render; the document worker can emit tessellated buffers or a renderer-facing cache keyed by express ID.

Keep three layers distinct:

- **Domain:** queries, derived facts, command schemas, validation rules and summaries. No DOM, MCP or storage calls.
- **IFC adapter:** entity traversal/mutation, units, schema compatibility, placement and representation operations.
- **Ports:** worker protocol, persistence, import/export and MCP presentation.

Tools and UI actions should invoke the same command handlers. Do not create a privileged “AI edit path.” A recipe is a serializable command with a versioned schema, deterministic target IDs and a structured result.

### Transactions, history and recovery

The current complete-file-per-revision scheme is simple and robust but scales as model size × revision count. In the browser:

1. Import the original IFC into an OPFS project directory.
2. Record successful domain commands in an append-only, checksummed log.
3. Store periodic serialized IFC checkpoints (for example every N edits or M MiB of log), retaining the original and at least one known-good recent checkpoint.
4. To undo, restore the nearest checkpoint and deterministically replay commands up to the desired cursor. Redo is then the same mechanism.
5. Before publishing an edit, validate the candidate state. If `web-ifc` cannot cheaply fork a model, use an inverse patch for known recipes or checkpoint/reopen on failure; benchmark both rather than assuming line-level rollback is complete.
6. Export an IFC after every session boundary and offer an explicit project bundle containing the source, command log, metadata and checkpoints.

OPFS is designed for performant, origin-private, in-place file access and exposes synchronous access handles in workers ([MDN OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)). It is not a backup: clearing site data deletes it, quotas apply, and data is best-effort unless persistence is granted. Request `navigator.storage.persist()`, monitor `navigator.storage.estimate()`, handle `QuotaExceededError`, and keep user-visible export/recovery workflows. Browser quota and eviction behavior varies substantially ([MDN storage quotas and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).

This follows a useful local-first distinction: the device copy is primary and a server, if later added for collaboration, holds a secondary copy ([Ink & Switch, *Local-first software*](https://www.inkandswitch.com/essay/local-first/)). OpenZCAD is relevant prior art for browser CAD: it uses a worker-hosted WASM geometry kernel, replayable feature history, local autosave, explicit export and recovery-copy-first conflict handling ([OpenZCAD](https://github.com/esaueng/OpenZCAD)). Its exact kernel and document format differ, but its failure policy is worth copying.

### MCP and chat topology

The existing MCP server is stdio: the MCP client launches a child process and exchanges JSON-RPC over its standard streams. The TypeScript SDK documents stdio as the local, process-spawned transport and Streamable HTTP as the network transport ([MCP TypeScript server transports](https://ts.sdk.modelcontextprotocol.io/server)). Neither lets an ordinary browser page accept inbound connections.

There are three viable product shapes:

1. **External Claude Code/desktop client:** install a tiny local TypeScript MCP bridge. The page establishes an outbound authenticated connection to it (WebSocket, WebTransport or long polling on localhost); the bridge forwards tool calls to the currently paired tab and returns results. It owns no IFC file and can exit when the MCP session ends. Define behavior for no tab, multiple tabs, reload during a call, cancellation, stale pairing and tab takeover.
2. **Chat embedded in tako:** the browser is the MCP client or calls a model-facing agent layer directly, and tool execution stays in-process. This removes the bridge but changes the product and moves model-provider integration into the web app.
3. **Hosted remote MCP endpoint:** a remote endpoint can use Streamable HTTP, which supports request/response and optional SSE ([MCP transport documentation](https://ts.sdk.modelcontextprotocol.io/server#streamable-http)). For browser-owned models it still needs a rendezvous channel to the correct live tab and cannot operate while that tab is offline. The endpoint is therefore coordination infrastructure, not the business-logic host.

Do not let the relay cache an authoritative IFC or reimplement recipe validation. Pairing should bind a client session to an origin, tab and random capability; tool results should include document ID and revision so late responses cannot land on a different model.

### Replacing `run_ifcopenshell`

Arbitrary Python execution is not a feature that can be faithfully rewritten as ordinary TypeScript recipes. Shipping Pyodide only for this escape hatch defeats much of the size/memory objective, while `eval`-style JavaScript would couple generated code to unstable internals and make commands non-replayable.

Replace it with a versioned edit-plan IR composed of tested primitives: create entity, clone shared graph, create representation, place product, relate/unrelate, set typed attribute/property, assign material/style, and declare affected elements. The plan is validated before execution and recorded in history. `kit_help` becomes machine-readable primitive documentation plus examples. Operations that cannot be expressed in the IR should first become a tested primitive; they should not receive unrestricted access to the document worker.

This is not primarily a sandboxing argument. Deterministic, serializable operations are required for undo/replay, migration, differential tests, crash recovery and future collaboration.

## Performance and platform warnings

- **Measure peak memory, not bundle size.** Import can simultaneously retain source bytes, WASM heap, entity graph, output bytes, geometry buffers, BVH and a checkpoint. Test with browser memory limits and standalone headsets, not only a desktop heap profiler.
- **Keep heavy work off the UI thread.** Parsing, indexing, edits, verification, serialization and checkpoint replay belong in workers. XR frame stability is a hard requirement.
- **Single-thread first.** The current viewer intentionally initializes `web-ifc` single-threaded. WASM threads require shared memory and cross-origin isolation; COOP/COEP headers enable `SharedArrayBuffer` but constrain cross-origin resources and window relationships ([MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)). Adopt multithreading only after profiling shows a need and the hosting/XR matrix passes.
- **Serialization may be the dominant pause.** `SaveModel` creates a complete byte buffer; evaluate callback/stream-like saving and checkpoint frequency on large files.
- **Indexes have explicit invalidation rules.** Geometry, containment, materials, boundaries, type relationships and derived façade facts do not all invalidate together. Each command must declare touched entities and index domains; a missed invalidation is worse than a slow rebuild.
- **Express IDs are document-local.** Commands should store GlobalIds where stable and explicit lineage for newly created entities, plus the source document fingerprint. Replay must not assume express IDs survive external round trips.
- **Round-trip fidelity is a release gate.** Compare entity counts, relationship integrity, properties, units, placements and rendered geometry after open/save/reopen. Byte equality is neither expected nor sufficient.
- **Origin is part of the storage address.** Moving from localhost to a production hostname, changing scheme, or using a different port creates a different storage silo. A deployment migration needs export/import or an explicit origin migration path.
- **Multiple tabs need a writer protocol.** Use Web Locks or an equivalent lease and make secondary tabs read-only. Do not rely on last-writer-wins over OPFS files.
- **A local-first file is not automatically collaborative.** Concurrent IFC graph edits need operation semantics, conflict detection and identity rules. Do not bolt a generic CRDT onto serialized IFC lines and call the problem solved.

## Migration plan and gates

### Phase 0: characterize before choosing

Build a corpus from the existing tested models plus deliberately awkward files: shared mapped geometry, shared layer sets, nested placements, IFC2X3/4/4X3, millimetre units, malformed-but-common relationships and large production-sized files. Record on target desktop and headset hardware:

- initial load and geometry-ready time;
- peak and retained memory after load, edit, serialize and repeated model switching;
- index build time;
- edit, verify, checkpoint, undo and reopen latency;
- exported size and open/save/reopen differences.

Run two narrow spikes, not two architectures: (a) load/query/edit/export with Pyodide IfcOpenShell, and (b) mutate/export/reopen the same cases with `web-ifc`. Stop the Pyodide spike once it has supplied parity and resource data.

### Phase 1: browser document core

- Introduce the document-worker protocol and make the current viewer consume its geometry/events.
- Implement import, export, close/dispose and model switching without the Node model endpoints.
- Add OPFS projects, persistent-storage request, explicit backup export and a single-writer tab lease.
- Prove repeated open/close does not retain WASM models or transferred geometry.

Gate: the viewer and XR work from static hosting, offline after assets are cached, with no Node application server.

### Phase 2: read-side parity

Port unit conversion, entity descriptions, material traversal, storey/containment mapping, bounding facts, facing/exterior inference, `find_elements`, `context_around` and focus. Preserve provenance fields rather than merely matching answers.

Use golden JSON outputs from the Python implementation with documented intentional differences. Property-based tests should exercise transforms, bearings, units and relationship traversal.

Gate: existing read tools match the reference corpus and meet an agreed latency/memory budget.

### Phase 3: named edit recipes

Port in risk order: typed property updates, material assignment with copy-on-write, door/window resize, panel replacement, then opening/product creation. Add transaction handling, structured warnings, affected-ID reporting and verification alongside each recipe; do not postpone verification into a later “hardening” phase.

For every fixture and edit, compare Python and TypeScript results semantically and render both exports. Include reopen in both `web-ifc` and native IfcOpenShell as an interoperability check.

Gate: all named recipes, `revise_edit` and undo pass round-trip and failure-atomicity tests without loading Python in production.

### Phase 4: command history and edit-plan IR

- Version every command schema and define migrations before persisted projects exist in the wild.
- Implement checkpoint/replay, crash injection during writes and recovery from the last valid log record.
- Replace current `kit` examples with IR examples and port the useful scripted cases.

Gate: a project created by the previous released version opens, replays and exports correctly; corrupt/incomplete tail records do not destroy the last good state.

### Phase 5: MCP bridge and Python removal

Generate MCP tool schemas from the same domain command definitions used by the UI. Implement pairing and revision checks in the thin local bridge, then delete the Python runtime only after tool-level differential tests pass.

Gate: package and deploy only static assets plus the optional small bridge; no VPS process loads a model, Python, NumPy or IfcOpenShell. Measure the bridge at idle and under calls to verify it has not acquired stateful application responsibilities.

## Decision checkpoints

Before committing the full rewrite, require answers backed by the spikes:

1. Can `web-ifc` save and reopen every supported schema and all current recipe mutations without semantic or geometric loss?
2. What are peak memory and worst-case latency for the largest supported model on the weakest supported headset?
3. Can one worker own both mutation and geometry without unacceptable message or rebuild costs?
4. Is command replay deterministic across app/engine upgrades, or must checkpoints be tied to exact engine versions?
5. Which scripted `kit` examples cannot be represented by the proposed edit-plan primitives?
6. Which chat topology is a product requirement: external MCP client, embedded chat, or both?

If (1) fails for a narrow class of representations, isolate that class behind an explicit unsupported-operation result or a separately deployable capability. Do not allow a rare edge case to turn a temporary dual-engine fallback into the permanent architecture.
