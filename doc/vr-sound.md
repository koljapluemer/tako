# VR sound and haptics

Light feedback for the headset. tako is a tool, not a game, so sounds stay short, quiet and few.
Everything here applies only inside a VR session; the desktop page stays silent.

## Rules

- **Hover is felt, never heard.** Pointing at something pressable gives one light vibration in that hand.
- **Every sound goes with something visible.** Nothing is told by sound alone.
- **In-world sounds are placed in 3D:** spray, station controls, the placed station. Wrist panel, microphone, agent and error sounds are head-locked.
- **One master volume**, tuned on the sound board. The Quest's own volume buttons do the rest.
- Spray, the hold tone and agent progress get quieter while the microphone is open.

## Cues

| Cue | When | Haptic |
|---|---|---|
| — (hover) | a pointer moves onto a button, card, lip control or pin; fingertip touches a pin | light, in that hand |
| `press` | wrist button, lip Close, opacity grab, tab, card | yes |
| `toggleOn` / `toggleOff` | pointer ↔ spray tool, highlight, pins | yes |
| `disabled` | a button that can't act right now (no revision that way, no change to go to, busy message, current card) | no |
| `tick` | opacity crosses a tenth | very light |
| hold tone | holding X (return) or A (clear paint); rises with the ring | grows with progress |
| `holdDone` | the X hold completes | |
| `landing` | after any teleport, pin jump, go-to-change or return | yes |
| `reject` | releasing a teleport or station aim on a spot you can't land on | yes |
| `place` | the station is put down | yes |
| spray loop | while spraying; follows the can and the trigger | |
| `undo` / `clear` | tap A / hold A with the can | yes |
| `micOpen` / `micClose` | B/Y pressed and released | on press |
| `progress` | the agent reports a step; at most every 4 s, and only when the wrist panel is out of view | |
| `done` | the agent finishes | both hands |
| `error` | the agent fails, speech fails, a load fails, paint is full, nowhere to stand near the change | both hands |
| `swap` | the building or revision is replaced | |

## Code

- `viewer/src/xr/audio.ts`: the `Sound` engine and `DEFAULT_TUNING`, which holds every cue's parameters. Cues are layers of synthesised tones, filtered noise or samples.
- `viewer/src/xr/feedback.ts`: hover tracking, slider steps, throttling, notice kinds and `haptic()`.
- `viewer/src/xr/session.ts`: where cues are triggered. Panels and the station report through `onFeedback`.
- Wrist messages carry a `NoticeKind`: `working` (silent, busy), `progress`, `done`, `error`, `info` (silent).

## Tuning

1. Run the dev server (`just vr` for the headset) and open `/sounds.html`. On the Quest, open it in a second tab.
2. Edit a cue and press Play. Edits are saved in that browser and apply to a running VR session in the same browser at once.
3. When it sounds right, press **Copy tuning** and paste the JSON over `DEFAULT_TUNING` in `audio.ts`.

The board lists every bundled Kenney file. Once the choice is final, delete the unused `.ogg` files from `viewer/src/assets/sounds/`: every file there ships with the build.

## Credits

Click and switch samples: [UI Audio](https://kenney.nl/assets/ui-audio) by Kenney, CC0 (`viewer/src/assets/sounds/KENNEY-LICENSE.txt`).
