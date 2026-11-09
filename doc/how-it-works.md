# How it works

## Document ownership

The IFC model has one owner: `viewer/src/ifc-worker.ts`. The worker keeps the
`web-ifc` model open, extracts render and collision geometry, builds semantic
facts, applies commands, serializes revisions, and stores projects in OPFS. The
main thread and the MCP bridge cannot mutate IFC entities directly.

An imported project contains its immutable source, current IFC, manifest,
history metadata, and revision snapshots. The manifest is written last so an
interrupted import is not presented as a project. Each edit is serialized and
reopened before it becomes durable. Failed commands reopen the pre-edit bytes.

Selection is browser-local. `get_focus` reads the selected express ID and latest
command from the open project, so “this” stays tied to the visible document.

## Agent access

`bridge/` is a Node/TypeScript MCP server over stdio. It listens only on
`127.0.0.1:47831`, accepts localhost browser origins, and forwards requests to
one active tab. It never opens, stores, or validates an IFC file.

The browser exposes model overview, semantic search, element inspection,
nearby context, materials, focus, simple IFC attributes and properties,
placement-aware move, relationship-aware deletion, mapped door/window
resize, undo/redo, and `run_ifcopenshell` for anything else. Unsupported
representation shapes are refused without committing.

`get_focus` and `get_element` include an element's relations (opening, host,
openings, type), read from IFC relationships on demand, so resolving "this
window" doesn't need a script. Deleting a door or window also deletes its
opening, unless another filling still uses that opening.

`run_ifcopenshell` scripts can read `si`, a spatial index whose first read
tessellates the whole model. The Python worker keeps the last index built by a
read-only script, keyed by project and latest command, so later scripts on the
same model state reuse it. It keeps no copy of the model itself.

In VR, each request carries a compact state block: where the user stands, and
any spray paint summarised by colour and element (centre, size, dot count), in
IFC world metres. Paint is session-only, lives in the viewer, and is dropped
when an edit touches what it marks.

Agent sessions from the headset are traced; see `agent-tracing.md`.

All agent-facing lengths are metres. IFC unit conversion happens at the worker
boundary. Spatial facts include provenance; exterior and facing currently use
the tessellated building envelope and are labelled as geometric inference.

## Rendering and XR

Parsing and geometry generation remain off the UI thread. Successful edits
currently rebuild the complete render/collision result and swap it into the
scene, preserving the XR session position.

Standalone WebXR supports viewing, walking and teleporting through local
projects. The developer’s desktop browser is the authoritative agentic session
for this proof of concept.

## Current limits

- OPFS belongs to an origin and browser profile; export before clearing site
  data or changing the deployment origin.
- Projects are single-user and single-device. There is no hosted sync or
  cross-device agent rendezvous.
- Door/window resizing requires a mapped body representation and center
  anchoring. Unsupported geometry is rejected atomically.
- Setting properties updates existing single-value properties; creating a new
  property-set graph is not implemented yet.
- Operations cover the safe proof-of-concept core rather than structural, MEP,
  regulatory, or specialist-analysis authoring.
