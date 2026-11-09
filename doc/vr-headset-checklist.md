# VR headset checklist

Things only a real Quest can confirm. Fill this in as you test; results replace
the provisional constants named below.

## Setup

1. `just corpus` builds the test models in `viewer/.corpus/` (not committed).
2. `just vr` serves over HTTPS on the LAN. Open `https://<lan-ip>:5173/?hud=1` in
   Quest Browser and accept the certificate warning.
3. Corpus models appear in the building list with the prefix `Corpus:`.
4. The readout shows frame time, draw calls, triangles, heap and disk use.

## Budgets (step 1)

| Model | Frame avg / worst (ms) | Draw calls | Triangles | Heap | Disk | Load time |
|---|---|---|---|---|---|---|
| corpus: synthetic/no-spaces | | | | | | |
| corpus: synthetic/large | | | | | | |
| corpus: real/s-office-archi | | | | | | |

Agreed budget: _not measured yet_.

Also record the storage quota Quest Browser reports (open question in the plan).

## Acceptance, per step

Provisional constants live next to the code that uses them. Tune them only
against results across the corpus, never the bundled samples alone.

### Rendering
- [ ] Large corpus models hold frame rate. Tune `CELL_SIZE_XZ` and `CELL_SIZE_Y` (`viewer/src/render-cells.ts`).
- [ ] Doors don't visibly pop when walking towards them.

### Walkability
- [ ] Note how long navmesh generation takes on `synthetic/large` and how heavy Recast feels on the headset.
- [ ] Unreachable spots show a red teleport arc; reachable spots are accepted.
- [ ] Walking through a railing or low furniture dims the view and shows the hint.
- [ ] Stairs are walkable. If not, tune `AGENT_CLIMB` (`viewer/src/nav/navmesh.ts`).

### Navigation points
- [ ] Points feel evenly spread and sensibly named across the corpus, including `synthetic/no-spaces`.
- [ ] Arriving at a point faces into the space.

### Versions
Needs a local project with at least two revisions on the headset.
- [ ] A/B switching keeps position and feels immediate.
- [ ] `MAX_CACHED_MODELS` and `MAX_CACHED_BYTES` (`viewer/src/versions.ts`) don't exhaust memory.

### Mini model
- [ ] Intended pins can be hit reliably with both hands and controllers. Tune `PIN_MIN_SPACING` and the press depths (`viewer/src/xr/mini-gestures.ts`).
- [ ] The model reads clearly and isn't cut by nearby walls.
- [ ] Controller and hand models appear (they download from the WebXR profiles CDN).

### Station
- [ ] Left stick forward aims a straight ray that places the station on valid floor and refuses anything else; a new one replaces the old.
- [ ] Right stick forward teleports and the left never does; turning the right stick while aiming sets the landing direction, and only the right stick snap turns.
- [ ] A snap turn held and swung forward does not start a teleport, and triggers only press panels.
- [ ] Holding X fills the ring and returns once to the exact spot you started at, even if the navmesh finished after you entered; releasing early cancels, and it stays put while still held. Tune `RETURN_HOLD_MS` (`viewer/src/xr/session.ts`) and the ring size (`viewer/src/xr/hold-ring.ts`).
- [ ] Model height and card distance feel right, and the cards read clearly. Tune `MODEL_HEIGHT`, `STAND_DISTANCE` and `CARD_HEIGHT` (`viewer/src/xr/station.ts`).
- [ ] A station placed close to a wall is still usable: the model can clip into it.
- [ ] Walls hide the station and stop presses reaching it.
- [ ] Close works, Buildings switches building, and a revision swap keeps the station in place.

### Finish
- [ ] Bounded-floor works where available, with no offset compared with local-floor.
- [ ] A session starts at an entrance on models that have one.
- [ ] Snap turn turns around the head without a position jump.
