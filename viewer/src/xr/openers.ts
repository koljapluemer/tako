import type { MenuChoice } from './menu';
import type { Pointer } from './teleport';

/** xr-standard puts the two face buttons at 4 and 5. */
const BUTTONS: Array<[number, MenuChoice]> = [[4, 'arc'], [5, 'mini']];

const held = new WeakMap<Pointer, Set<number>>();

/** Fires once per press. Hands have no such buttons and use the body-locked button instead. */
export function pollOpeners(pointers: Pointer[], open: (choice: MenuChoice, pointer: Pointer) => void) {
  for (const pointer of pointers) {
    const pad = pointer.source?.gamepad;
    if (!pad || pointer.source!.hand) {
      held.delete(pointer);
      continue;
    }
    let down = held.get(pointer);
    if (!down) held.set(pointer, (down = new Set()));
    for (const [button, choice] of BUTTONS) {
      const pressed = pad.buttons[button]?.pressed ?? false;
      if (pressed && !down.has(button)) open(choice, pointer);
      if (pressed) down.add(button);
      else down.delete(button);
    }
  }
}
