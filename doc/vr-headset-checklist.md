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
- [ ] The wrist panel's revision row names the current revision ("Latest" on the newest); ‹ and › step back and forth, and are dimmed at either end. Rapid presses land on the last one pressed.
- [ ] `MAX_CACHED_MODELS` and `MAX_CACHED_BYTES` (`viewer/src/versions.ts`) don't exhaust memory.

### Mini model
- [ ] Intended pins can be hit reliably with both hands and controllers. Tune `PIN_MIN_SPACING` and the press depths (`viewer/src/xr/mini-gestures.ts`).
- [ ] The model reads clearly and isn't cut by nearby walls.
- [ ] Controller and hand models appear (they download from the WebXR profiles CDN).
- [ ] The Opacity slider tracks the ray, keeps dragging past the panel edge, and reaches both ends. Opacity 0 and 1 both look right.
- [ ] Nav points off hides the pins and they can't be pressed or hovered.
- [ ] Frame rate holds with the station open on the largest building: the mini model repeats the building's draw calls.
- [ ] The table fits the model at zoom 1 with a small margin, across the buildings, and grows to it once the navmesh is in. Tune `TABLE_MARGIN`, `TABLE_MIN` and `TABLE_MAX` (`viewer/src/xr/station.ts`).
- [ ] The lip on the table's near edge reads clearly from where you stand and is easy to hit with either ray; Close on it puts the whole station away. Tune `LIP_TILT` (`viewer/src/xr/station.ts`).

### Station
- [ ] Left stick forward aims a straight ray that places the station on valid floor and refuses anything else; a new one replaces the old.
- [ ] Right stick forward teleports and the left never does; turning the right stick while aiming sets the landing direction, and only the right stick snap turns.
- [ ] A snap turn held and swung forward does not start a teleport.
- [ ] Either trigger presses the panel it points at. The right trigger never sprays onto a panel, and never sprays with the pointer.

### Tools and the left controller panel
- [ ] A session starts with the pointer: no can, white tip, and A does nothing.
- [ ] The panel sits above the left controller, reads clearly when you look at your wrist and is easy to hit with the right ray, without blocking the left beam or the view. Tune `OFFSET`, `TILT` and the size (`viewer/src/xr/controller-panel.ts`).
- [ ] With only the right controller tracked, the panel moves to it.
- [ ] Spray shows the can on the right controller, its band in the next colour; Pointer hides it again.
- [ ] Highlight Off restores the normal materials straight away, and a following edit is not highlighted. Leaving VR turns the highlight back on for the desktop.

### Agent messages and the latest change
- [ ] Agent messages appear at the top of the wrist panel, with a blue bar while it works, wrapping onto up to four lines. Pressing a finished message clears it; a working one can't be cleared.
- [ ] A finished reply stays after the model reloads; a "Loading…" message goes once the model is in.
- [ ] Both controllers buzz when the agent finishes or fails.
- [ ] After an edit, the compass needle points to the change as the wrist turns, and the distance counts down as you walk, naming the height difference on another level.
- [ ] Looking at the change unobstructed for a second clears the compass ("No new change") and ends the highlight 3 s later. Looking at it through a wall doesn't count.
- [ ] Pressing the compass row teleports to a walkable spot a few metres away, facing the change with nothing in between, on the user's side where possible.
- [ ] Undo, a revision jump or a new building clears the compass.

### Spray paint
- [ ] Paint lands on walls, floors, windows, doors and furniture, with no visible flicker. It reads well at room distance.
- [ ] Frame rate holds while spraying, including near many doors. If not, raise `SPRAY_INTERVAL_MS` (`viewer/src/xr/session.ts`).
- [ ] The right controller's tip shows the next colour; a pause changes it. Tune `GROUP_PAUSE_MS` (`viewer/src/xr/paint-log.ts`) if marking several things around a room splits into too many colours.
- [ ] Holding the can, tapping A undoes one stroke with no ring flash; holding A fills the ring and deletes all paint once; X still returns to the start.
- [ ] Six colours in use refuses a seventh with a notice.
- [ ] After a voice edit, colours on the changed elements go and the others stay in place, even if the origin shifts. Undo, a revision jump or a new building clears all paint.
- [ ] Holding X fills the ring and returns once to the exact spot you started at, even if the navmesh finished after you entered; releasing early cancels, and it stays put while still held. Tune `RETURN_HOLD_MS` (`viewer/src/xr/session.ts`) and the ring size (`viewer/src/xr/hold-ring.ts`).
- [ ] Table height and card distance feel right; the cards clear the tallest model and read clearly. Tune `TABLE_TOP` (`viewer/src/xr/pedestal.ts`), `STAND_DISTANCE` and `CARD_HEIGHT` (`viewer/src/xr/station.ts`).
- [ ] A station placed close to a wall is still usable: the model can clip into it.
- [ ] Walls hide the station and stop presses reaching it.
- [ ] Close works, the Revisions | Buildings tab swaps the cards, a building card switches building, and a revision swap keeps the station in place.

### Sound and haptics
See [vr-sound.md](vr-sound.md). Tune with `/sounds.html` in Quest Browser, in a second tab next to the VR session.
- [ ] Sounds and vibrations both arrive, and the volume feels right next to the system UI. Tune `master` in `DEFAULT_TUNING` (`viewer/src/xr/audio.ts`).
- [ ] Pointing at a button, card, lip control or pin vibrates once and never makes a sound; sweeping across a row of cards does not rattle.
- [ ] The spray hiss comes from the can as it moves, gets louder with the trigger, and stops cleanly on release, when aiming a teleport, and on leaving VR.
- [ ] The opacity slider ticks without becoming a buzz.
- [ ] The X and A hold tones rise with the ring and stop as it completes or is released.
- [ ] Saying nothing after the mic sound gives "I did not catch that": the mic sound is not transcribed.
- [ ] During a multi-step voice edit, progress stays quiet; done and error are clearly different.

### Finish
- [ ] Bounded-floor works where available, with no offset compared with local-floor.
- [ ] A session starts at an entrance on models that have one.
- [ ] Snap turn turns around the head without a position jump.
