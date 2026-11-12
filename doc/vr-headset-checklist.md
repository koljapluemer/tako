# VR headset checklist

Things only a real Quest can confirm. Fill this in as you test; results replace
the provisional constants named below.

## Setup

1. `just vr` serves over HTTPS on the LAN. Open `https://<lan-ip>:5173/?hud=1` in
   Quest Browser and accept the certificate warning.
2. The readout shows frame time, draw calls, triangles, heap and disk use.

## Budgets (step 1)

| Model | Frame avg / worst (ms) | Draw calls | Triangles | Heap | Disk | Load time |
|---|---|---|---|---|---|---|
| AC20 Institute | | | | | | |
| S Office | | | | | | |
| Simple building (IFC 2x3) | | | | | | |
| Duplex (IFC 2x3) | | | | | | |

Agreed budget: _not measured yet_.

Also record the storage quota Quest Browser reports (open question in the plan).

## Acceptance, per step

Provisional constants live next to the code that uses them. The headset can only
open the selectable buildings, so don't tune analysis constants to them alone:
check those against the corpus tests too (`just corpus`, then `npm test` in `viewer/`).

### Rendering
- [ ] The largest building holds frame rate. Tune `CELL_SIZE_XZ` and `CELL_SIZE_Y` (`viewer/src/render-cells.ts`).
- [ ] Doors don't visibly pop when walking towards them.

### Walkability
- [ ] Note how long navmesh generation takes on the largest building and how heavy Recast feels on the headset.
- [ ] Spots without room to stand (walls, low ceilings, steep or non-floor surfaces) show a red teleport arc; floors and other navmesh surfaces are accepted, including before the navmesh has loaded.
- [ ] Walking through a railing or low furniture dims the view and shows the hint.
- [ ] Stairs are walkable. If not, tune `AGENT_CLIMB` (`viewer/src/nav/navmesh.ts`).

### Navigation points
- [ ] Points feel evenly spread and sensibly named across the buildings.
- [ ] Arriving at a point faces into the space.

### Versions
Needs a building with at least two revisions on the headset.
- [ ] A/B switching keeps position and feels immediate.
- [ ] `MAX_CACHED_MODELS` and `MAX_CACHED_BYTES` (`viewer/src/versions.ts`) don't exhaust memory.

### Mini model
- [ ] Intended pins can be hit reliably with both hands and controllers. Tune `PIN_MIN_SPACING` and the press depths (`viewer/src/xr/mini-gestures.ts`).
- [ ] The model reads clearly and isn't cut by nearby walls.
- [ ] Controller and hand models appear (they download from the WebXR profiles CDN).
- [ ] The Opacity slider tracks the ray, keeps dragging past the panel edge, and reaches both ends. Opacity 0 and 1 both look right.
- [ ] Nav points off hides the pins and they can't be pressed or hovered.
- [ ] Frame rate holds with the station open on the largest building: the mini model repeats the building's draw calls.
- [ ] At zoom 1, the panel doesn't touch the model, cards or buttons, across the buildings. Tune `MAX_HEIGHT` (`viewer/src/xr/mini-view.ts`) and `CONTROLS_ANGLE` and `CONTROLS_HEIGHT` (`viewer/src/xr/station.ts`).

### Station
- [ ] Left stick forward aims a straight ray that places the station on valid floor and refuses anything else; a new one replaces the old.
- [ ] Right stick forward teleports and the left never does; turning the right stick while aiming sets the landing direction, and only the right stick snap turns.
- [ ] A snap turn held and swung forward does not start a teleport.
- [ ] The left trigger presses panels and never sprays; the right trigger sprays until released, never presses or highlights a panel.

### Spray paint
- [ ] Paint lands on walls, floors, windows, doors and furniture, with no visible flicker. It reads well at room distance.
- [ ] Frame rate holds while spraying, including near many doors. If not, raise `SPRAY_INTERVAL_MS` (`viewer/src/xr/session.ts`).
- [ ] The right controller's tip shows the next colour; a pause changes it. Tune `GROUP_PAUSE_MS` (`viewer/src/xr/paint-log.ts`) if marking several things around a room splits into too many colours.
- [ ] Tapping A undoes one stroke with no ring flash; holding A fills the ring and deletes all paint once; X still returns to the start.
- [ ] Six colours in use refuses a seventh with a notice.
- [ ] After a voice edit, colours on the changed elements go and the others stay in place, even if the origin shifts. Undo, a revision jump or a new building clears all paint.
- [ ] Holding X fills the ring and returns once to the exact spot you started at, even if the navmesh finished after you entered; releasing early cancels, and it stays put while still held. Tune `RETURN_HOLD_MS` (`viewer/src/xr/session.ts`) and the ring size (`viewer/src/xr/hold-ring.ts`).
- [ ] Model height and card distance feel right, and the cards read clearly. Tune `MODEL_HEIGHT`, `STAND_DISTANCE` and `CARD_HEIGHT` (`viewer/src/xr/station.ts`).
- [ ] A station placed close to a wall is still usable: the model can clip into it.
- [ ] Walls hide the station and stop presses reaching it.
- [ ] Close works, Buildings switches building, and a revision swap keeps the station in place.

### Finish
- [ ] Bounded-floor works where available, with no offset compared with local-floor.
- [ ] A session starts at an entrance on models that have one.
- [ ] Snap turn turns around the head without a position jump.
