import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { buttonAt, compassAngle, distanceLabel } from './controller-panel';

describe('buttonAt', () => {
  it('puts the message on top and the compass under it, both full width', () => {
    expect(buttonAt(0.05, 0.1)).toBe('message');
    expect(buttonAt(0.95, 0.3)).toBe('message');
    expect(buttonAt(0.05, 0.4)).toBe('go');
    expect(buttonAt(0.95, 0.5)).toBe('go');
  });

  it('puts the revision arrows at either end of the row under the compass', () => {
    expect(buttonAt(0.05, 0.6)).toBe('rev-prev');
    expect(buttonAt(0.95, 0.6)).toBe('rev-next');
    expect(buttonAt(0.5, 0.6)).toBeNull();
  });

  it('splits the bottom rows into a label and two choices', () => {
    expect(buttonAt(0.1, 0.75)).toBeNull();
    expect(buttonAt(0.5, 0.75)).toBe('pointer');
    expect(buttonAt(0.9, 0.75)).toBe('spray');
    expect(buttonAt(0.1, 0.9)).toBeNull();
    expect(buttonAt(0.5, 0.9)).toBe('highlight-on');
    expect(buttonAt(0.9, 1)).toBe('highlight-off');
  });

  it('ignores points off the panel', () => {
    expect(buttonAt(-0.1, 0.5)).toBeNull();
    expect(buttonAt(0.5, 1.2)).toBeNull();
  });
});

describe('compassAngle', () => {
  // A panel tilted back, as on the controller: its top points forward (−Z) and up.
  const up = new THREE.Vector3(0, 1, -1).normalize();
  const right = new THREE.Vector3(1, 0, 0);

  it('points up the panel for a target straight ahead, clockwise for one to the right', () => {
    expect(compassAngle(new THREE.Vector3(0, 0, -5), up, right)).toBeCloseTo(0);
    expect(compassAngle(new THREE.Vector3(5, 0, 0), up, right)).toBeCloseTo(Math.PI / 2);
    expect(compassAngle(new THREE.Vector3(-5, 0, 0), up, right)).toBeCloseTo(-Math.PI / 2);
    expect(Math.abs(compassAngle(new THREE.Vector3(0, 0, 5), up, right))).toBeCloseTo(Math.PI);
  });
});

describe('distanceLabel', () => {
  it('rounds to metres and names another level', () => {
    expect(distanceLabel(12.4, 0.3)).toBe('12 m');
    expect(distanceLabel(3.6, 2.9)).toBe('4 m · 3 m up');
    expect(distanceLabel(0.2, -3.2)).toBe('0 m · 3 m down');
  });
});
