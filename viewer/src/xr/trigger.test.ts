import { describe, expect, it, vi } from 'vitest';
import type { Pointer } from './pointer';
import { TriggerRouter, type Aim } from './trigger';

const pointerOn = (handedness: XRHandedness) => ({ source: { handedness } }) as unknown as Pointer;

function stubAim() {
  return { aiming: false, begin: vi.fn<Aim['begin']>(), release: vi.fn<Aim['release']>(), abandon: vi.fn<Aim['abandon']>() };
}

function setup() {
  const left = stubAim();
  const right = stubAim();
  const router = new TriggerRouter({ left, right });
  return { left, right, router };
}

describe('TriggerRouter', () => {
  it('sends a right-hand hold only to the right aim', () => {
    const { left, right, router } = setup();
    const pointer = pointerOn('right');
    router.down(pointer, 0);
    router.update(500);
    router.up(pointer);
    expect(right.begin).toHaveBeenCalledOnce();
    expect(right.release).toHaveBeenCalledWith(pointer);
    expect(left.begin).not.toHaveBeenCalled();
  });

  it('sends a left-hand hold only to the left aim', () => {
    const { left, right, router } = setup();
    router.down(pointerOn('left'), 0);
    router.update(500);
    expect(left.begin).toHaveBeenCalledOnce();
    expect(right.begin).not.toHaveBeenCalled();
  });

  it('treats an unknown side as the right hand', () => {
    const { right, router } = setup();
    router.down(pointerOn('none'), 0);
    router.update(500);
    expect(right.begin).toHaveBeenCalledOnce();
  });

  it('does not aim on a short press', () => {
    const { left, right, router } = setup();
    const pointer = pointerOn('left');
    router.down(pointer, 0);
    router.update(100);
    router.up(pointer);
    expect(left.begin).not.toHaveBeenCalled();
    expect(right.begin).not.toHaveBeenCalled();
  });

  it('never aims on a press the UI claimed', () => {
    const { right, router } = setup();
    router.claim = () => true;
    const pointer = pointerOn('right');
    router.down(pointer, 0);
    router.update(500);
    router.up(pointer);
    expect(right.begin).not.toHaveBeenCalled();
  });
});
