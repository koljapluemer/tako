import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARC_ANGLE_STEP, ARC_RADIUS, ARC_SLOTS, CARD_H } from './arc';
import { PANEL_H, PANEL_W } from './mini-controls';
import { LONGEST_SIDE } from './mini-view';
import { stationLayout } from './station';

const anchor = new THREE.Vector3(4, 3, -2);
const flat = (v: THREE.Vector3) => new THREE.Vector2(v.x, v.z);

describe('stationLayout', () => {
  for (const yaw of [0, 1, -2.5, Math.PI]) {
    it(`puts the model between the stand spot and the cards at yaw ${yaw}`, () => {
      const { stand, model } = stationLayout(anchor, yaw);
      const toModel = flat(model).distanceTo(flat(stand));
      expect(toModel).toBeGreaterThan(0);
      expect(toModel).toBeLessThan(ARC_RADIUS);
      expect(model.y).toBeGreaterThan(anchor.y);
    });

    it(`keeps the buttons clear of every card slot at yaw ${yaw}`, () => {
      const { stand, close, switcher } = stationLayout(anchor, yaw);
      const lastSlot = yaw + ((ARC_SLOTS - 1) / 2) * ARC_ANGLE_STEP;
      const edgeCard = new THREE.Vector2(stand.x + Math.sin(lastSlot) * ARC_RADIUS, stand.z + Math.cos(lastSlot) * ARC_RADIUS);
      expect(flat(switcher.position).distanceTo(edgeCard)).toBeGreaterThan(0.27);
      expect(flat(close.position).distanceTo(flat(switcher.position))).toBeGreaterThan(1);
    });

    it(`keeps the controls clear of the cards, buttons and model at yaw ${yaw}`, () => {
      const { stand, model, close, controls } = stationLayout(anchor, yaw);
      const halfAngle = Math.asin(PANEL_W / 2 / ARC_RADIUS);
      const offset = Math.atan2(controls.position.x - stand.x, controls.position.z - stand.z) - yaw;
      const angle = Math.atan2(Math.sin(offset), Math.cos(offset));
      const top = controls.position.y + PANEL_H / 2;

      // Cards are the tallest item in the top row, and buttons share its centre line.
      expect(top).toBeLessThan(close.position.y - CARD_H / 2);

      const modelRadius = (LONGEST_SIDE * Math.SQRT2) / 2;
      const silhouette = Math.asin(modelRadius / flat(model).distanceTo(flat(stand)));
      expect(Math.abs(angle) - halfAngle).toBeGreaterThan(silhouette);
    });
  }
});
