import { describe, expect, it } from 'vitest';
import { PinPress, turntableDelta, twoHandPlacement, visiblePins, PIN_ARM_DEPTH, PIN_SLIDE_OFF, type Vec3 } from './mini-gestures';

describe('turntableDelta', () => {
  it('measures rotation and takes the short way across the seam', () => {
    expect(turntableDelta([0, 0, 0], [0, 0, 1], [1, 0, 0])).toBeCloseTo(Math.PI / 2);
    expect(turntableDelta([0, 0, 0], [-0.1, 0, -1], [0.1, 0, -1])).toBeCloseTo(-2 * Math.atan(0.1));
  });
});

describe('twoHandPlacement', () => {
  const start = { position: [1, 1, 0] as Vec3, yaw: 0, zoom: 1 };
  const a: Vec3 = [-1, 1, 0];
  const b: Vec3 = [1, 1, 0];

  it('is a no-op when the hands do not move', () => {
    const out = twoHandPlacement(start, a, b, a, b);
    expect(out.yaw).toBeCloseTo(0);
    expect(out.zoom).toBeCloseTo(1);
    expect(out.position[0]).toBeCloseTo(1);
  });

  it('moves with the hands', () => {
    const shift = (p: Vec3): Vec3 => [p[0], p[1] + 0.5, p[2] + 2];
    expect(twoHandPlacement(start, a, b, shift(a), shift(b)).position).toEqual([1, 1.5, 2]);
  });

  it('zooms around the midpoint', () => {
    const out = twoHandPlacement(start, a, b, [-2, 1, 0], [2, 1, 0]);
    expect(out.zoom).toBeCloseTo(2);
    expect(out.position[0]).toBeCloseTo(2);
  });

  it('turns around the midpoint', () => {
    const out = twoHandPlacement(start, a, b, [0, 1, 1], [0, 1, -1]);
    expect(Math.abs(out.yaw)).toBeCloseTo(Math.PI / 2);
    expect(Math.hypot(out.position[0], out.position[2])).toBeCloseTo(1);
  });

  it('clamps zoom', () => {
    expect(twoHandPlacement(start, a, b, [-100, 1, 0], [100, 1, 0]).zoom).toBeLessThanOrEqual(6);
  });
});

describe('PinPress', () => {
  it('commits on press and lift', () => {
    const pin = new PinPress();
    expect(pin.update(-0.001, 0)).toBe('hover');
    expect(pin.update(-PIN_ARM_DEPTH, 0)).toBe('armed');
    expect(pin.update(0.001, 0)).toBe('commit');
  });

  it('does not commit from a touch alone', () => {
    const pin = new PinPress();
    pin.update(-0.001, 0);
    expect(pin.update(PIN_ARM_DEPTH * 2, 0)).toBe('leave');
  });

  it('cancels on sliding away and stays cancelled until clear', () => {
    const pin = new PinPress();
    pin.update(-0.001, 0);
    pin.update(-PIN_ARM_DEPTH, 0);
    expect(pin.update(-PIN_ARM_DEPTH, PIN_SLIDE_OFF * 2)).toBe('cancel');
    expect(pin.update(-PIN_ARM_DEPTH, 0)).toBeNull();
    expect(pin.update(0.001, 0)).toBeNull();
  });
});

describe('visiblePins', () => {
  const pins = [
    { x: 0, z: 0, level: 0, importance: 1 },
    { x: 1, z: 0, level: 0, importance: 0.5 },
    { x: 1, z: 0, level: 1, importance: 0.1 },
  ];

  it('hides lower-importance pins until zoomed in, per level', () => {
    expect(visiblePins(pins, 0.02, 1)).toHaveLength(2);
    expect(visiblePins(pins, 0.02, 3)).toHaveLength(3);
  });
});
