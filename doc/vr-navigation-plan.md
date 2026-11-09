# VR navigation plan

Goal: make tako properly usable in VR on a **standalone Meta Quest, opened from
Quest Browser**, with natural walking, teleport, high-level navigation points
and quick switching between versions of a building.

Status: implemented, and tested in an emulated headset but not on a real one.
The "Done when" criteria that need a real Quest are tracked in
[vr-headset-checklist.md](vr-headset-checklist.md), and thresholds stay
provisional until those results are in.

## Decisions

- **Target:** standalone Quest. PCVR/Link is not a target.
- **Locomotion:** natural walking plus teleport. No joystick translation.
- **Content on the headset:** for now, Quest users look at the demo models.
  Versions are only ever what users create, stored in the browser. No revision
  files are committed.
- **Desktop-to-headset sync is deferred.** Edits made through the desktop agent
  do not reach the headset. See "Deferred".
- **No wrist anchoring, tabs or flat multi-page menus.** A control opens an
  object placed in the world; the arm is free afterwards.
- **Generality:** analysis is geometry-first. Any IFC element, relationship or
  property may be missing or wrong. IFC semantics only enrich the result.
  `IfcSpace` in particular is
  [often omitted](https://mdpi.com/1996-1073/15/8/2937) and
  [often geometrically inaccurate](https://mdpi.com/2075-5309/13/2/350).
- **The bundled samples are not design evidence.** Do not tune thresholds or
  decide what can be relied on by inspecting them. Evaluate on the corpus in
  step 1.

## Already in place

| Area | Where | State |
|---|---|---|
| Natural walking | `viewer/src/xr/walking.ts` | Head tracked 1:1, rig follows floor height, walls fade to black rather than pushing the user |
| Teleport and placement | `viewer/src/xr/floor-aim.ts`, `viewer/src/xr/session.ts` | Stick-held aim paths, landing validation, one job per hand, choice of facing on the right stick |
| Station | `viewer/src/xr/station.ts` | Mini model, revision cards and their buttons, anchored on the floor |
| Collision | `viewer/src/collision.ts` | BVH built in the worker, floor and solid parts |
| Notices | `viewer/src/xr/notice.ts` | Status text in the headset |
| Position across revisions | `XRWalk.setModel` in `viewer/src/xr/session.ts` | Preserved, including origin shifts; lost when switching files |

Known gaps:

- Each door still needs its own material when near, so doors cost one draw call
  each inside the nearby cell.
- Revisions cannot reach the headset yet (see "Deferred"), so on a Quest the arc
  normally shows the current version and "Other buildings".

## Interaction design

### Placing the station

See `vr-controls.svg` for the full mapping.

- **Right stick:** push forward to aim a curved teleport, release to go. Turning
  it while aiming chooses the landing direction; left or right snap turns
  otherwise.
- **Left stick:** push forward to aim a straight ray at the floor, release to
  place the station there. A new station replaces the old one.
- **Either trigger:** press a panel.
- The station turns to face the user once, when placed, and then stays put. It
  holds the mini model at about waist height, with the cards behind it, and
  Close and Buildings/Revisions buttons at either end of the cards.
- It is an object in the building: walls hide it and block pressing it.

### Revision arc

- A short, gravity-aligned arc of cards, placed once and world-locked.
- Each card shows a title and age, and the current version is marked. Long
  histories scroll sideways.
- Selecting a card fades, swaps and keeps position. The arc stays open for A/B
  comparison, and closes only from the station's Close button.
- The station's Buildings button swaps the cards for the list of buildings.

### Mini model (world-in-miniature)

- About 50-60 cm on its longest side, gravity-aligned and world-locked, with a
  "you are here" marker showing facing.
- The building's own meshes and colours at a uniform small scale, sharing their
  geometry. An Opacity slider lets the user see inside.
- Only pins are selectable, never model geometry.

| Input | Action |
|---|---|
| One-hand grab | Turntable spin around the vertical axis |
| Two-hand grab | Move, zoom and turn around the midpoint of the hands |
| Fingertip or controller tip | Touch a pin |
| Ray | Fallback, snaps to the nearest pin |

- Grab is `squeeze` on controllers and a pinch near the model with hands.
  Teleporting is on the stick, so a grab cannot start one.
- Pins are flat discs on their floor. Contact highlights and
  shows the name, pressing about 1 cm arms, lifting off commits, sliding off
  sideways cancels.
- Committing does the normal fade-teleport and closes the model. Position, spin
  and zoom reset on next open.
- Pin spacing is at least about 8 cm at default scale, to be tuned on a headset.
  Lower-importance pins appear as the user zooms in.

## Build order

### 1. Headset baseline

- In-VR readout of frame time, draw calls, triangles and memory.
- Test corpus: varied real models, plus synthetic cases with no spaces, no
  stairs, proxy floors, atriums, broken relationships and large file sizes.
- Record budgets on a real Quest, following
  [Meta's performance guidance](https://developers.meta.com/horizon/documentation/web/webxr-perf-bp/).

Done when: we have measured budgets and a repeatable way to test against them.

### 2. Rendering

- Split colour batches by storey and spatial cell so frustum culling works.
- Merge doors away from the user; only nearby doors need individual opacity.
- Multiview is not available: three.js 0.187 has no multiview path in
  `WebGLRenderer`, and `WebGPURenderer` disables it for XR.

Done when: large corpus models hold frame rate on the headset.

### 3. Walkability

- Generate a navmesh in the worker with
  [recast-navigation-js](https://npmjs.com/package/recast-navigation), from
  up-facing geometry. IFC classes only exclude things such as furniture.
- Add floor patches at door thresholds, because slabs often stop at door
  openings and rooms would otherwise be disconnected.
- Keep the BVH for runtime collision.
  [IWSDK's locomotor](https://cdn.jsdelivr.net/npm/@iwsdk/locomotor@0.4.2/README.md)
  is thumbstick-capsule oriented and does not document room-scale head handling.
- Reject teleport landings that are not on the reachable navmesh.
- Add a body-height warning for low obstacles, in the same non-pushing style as
  wall fades.

Done when: walkability works on corpus models that have no usable class data.

### 4. Navigation points

Runs in the worker and is deterministic.

1. **Candidates:** region centres (widest point of the distance field),
   corridor junctions (branch points of the medial axis), stair and ramp ends,
   door thresholds between regions.
2. **Enrichment when present:** space names, external doors. Every point has a
   generic fallback name.
3. **Importance:** region size, candidate type and betweenness on the region
   graph.
4. **Spreading:** weighted greedy elimination. Take the highest score, remove
   candidates within radius r, adjust r per storey to reach a target count.
   Distances are **walking distances**, not straight-line. Entrances and stair
   landings are always kept.
5. **Stability:** anchor points to GlobalIds and matched regions, so they do not
   jump between versions.
6. **Arrival:** each point has a facing direction into its space.

Done when: points are evenly spread and sensible across the corpus, including
models with no `IfcSpace` at all.

### 5. Versions

- One version source interface, implemented by project history.
- Add a real title field to history entries, and jump-to-revision in the worker.
- Keep position across versions. They are the same building, so they share coordinates.
- If the spot no longer exists, go to the nearest walkable point.
- Cancel stale loads instead of queueing them.
- Keep recent revisions' geometry in memory so A/B switching is instant.
  Persistent caching waits for the measured storage quota.
- Build the revision arc.

Done when: A/B switching in the headset keeps position and feels immediate.

### 6. Mini model

Build the mesh, pins and interactions described above, and add hand and
controller models.

Done when: intended pins can be hit reliably with both hands and controllers.

### 7. Finish

- Request `bounded-floor`, [falling back to `local-floor`](https://developer.mozilla.org/docs/Web/API/WebXR_Device_API/Bounded_reference_spaces).
- Spawn at an entrance when one can be identified.
- Optional snap turn for seated use (rotation only).

## Open questions

- How much local storage does Quest Browser actually allow? (Step 1)
- How heavy is Recast's WASM on the headset? (Step 3)
- The medial-axis, Recast partitioning and elimination details above have not
  been validated against sources or prototyped yet.

## Deferred

**Desktop-to-headset sync.** Projects live in per-device browser storage and the
agent bridge only accepts local origins, so desktop revisions cannot reach the
headset. If this becomes necessary, the preferred option is uploading
client-side encrypted revision bundles to a blob store behind Caddy, with the
key in the URL fragment. Alternatives are direct WebRTC transfer and manual
export and import.
