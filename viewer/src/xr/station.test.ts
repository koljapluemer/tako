import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARC_ANGLE_STEP, ARC_RADIUS, CARD_H, CARD_W } from './arc';
import { PANEL_H, PANEL_W } from './mini-controls';
import { MAX_HEIGHT } from './mini-view';
import { TABLE_TOP } from './pedestal';
import { stationLayout, TABLE_MAX, TABLE_MIN, tableRadius } from './station';

const anchor = new THREE.Vector3(4, 3, -2);
const flat = (v: THREE.Vector3) => new THREE.Vector2(v.x, v.z);
const EYE = 1.6;

describe('tableRadius', () => {
  it('leaves room around the model, within bounds', () => {
    expect(tableRadius(null)).toBe(TABLE_MIN);
    expect(tableRadius(0.3)).toBeGreaterThan(0.3);
    expect(tableRadius(5)).toBe(TABLE_MAX);
  });
});

describe('stationLayout', () => {
  it('keeps neighbouring cards apart', () => {
    expect(2 * ARC_RADIUS * Math.sin(ARC_ANGLE_STEP / 2)).toBeGreaterThan(CARD_W);
  });

  for (const yaw of [0, 1, -2.5, Math.PI]) {
    for (const radius of [TABLE_MIN, TABLE_MAX]) {
      const at = `at yaw ${yaw}, table ${radius}`;
      const layout = stationLayout(anchor, yaw, radius);
      const { stand, model, table, lip, arcCentre } = layout;
      const face = new THREE.Object3D();
      face.position.copy(lip.position);
      face.rotation.set(-lip.tilt, lip.rotationY, 0, 'YXZ');
      face.updateMatrixWorld(true);
      const up = new THREE.Vector3(0, 1, 0).transformDirection(face.matrixWorld);
      const right = new THREE.Vector3(1, 0, 0).transformDirection(face.matrixWorld);
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(face.matrixWorld);

      it(`stands the model on the table, between the user and the cards ${at}`, () => {
        expect(flat(model).distanceTo(flat(table))).toBeCloseTo(0, 9);
        expect(model.y).toBeGreaterThan(anchor.y + TABLE_TOP);
        const toModel = flat(model).distanceTo(flat(stand));
        expect(toModel).toBeGreaterThan(radius);
        expect(toModel).toBeLessThan(ARC_RADIUS);
      });

      it(`puts the cards above the tallest model ${at}`, () => {
        expect(arcCentre.y - CARD_H / 2).toBeGreaterThan(anchor.y + TABLE_TOP + MAX_HEIGHT);
        expect(arcCentre.y - CARD_H / 2).toBeLessThan(anchor.y + EYE);
      });

      it(`puts the lip on the near edge of the table, outside it and below its top ${at}`, () => {
        const centre = flat(lip.position);
        const toStand = flat(stand).sub(flat(table)).normalize();
        expect(flat(lip.position).sub(flat(table)).normalize().dot(toStand)).toBeCloseTo(1, 6);
        expect(centre.distanceTo(flat(stand))).toBeLessThan(flat(table).distanceTo(flat(stand)));
        // Every corner of the face is outside the table's footprint and no higher than its top.
        for (const [u, v] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
          const corner = lip.position.clone().addScaledVector(right, (u * PANEL_W) / 2).addScaledVector(up, (v * PANEL_H) / 2);
          expect(flat(corner).distanceTo(flat(table))).toBeGreaterThan(radius);
          expect(corner.y).toBeLessThanOrEqual(anchor.y + TABLE_TOP);
        }
      });

      it(`turns the lip's face up towards the user's eyes ${at}`, () => {
        const eye = new THREE.Vector3(stand.x, anchor.y + EYE, stand.z);
        const toEye = eye.sub(lip.position).normalize();
        expect(normal.y).toBeGreaterThan(0);
        expect(normal.dot(toEye)).toBeGreaterThan(0.9);
        // Text reads upright: the face's top edge is the far one.
        expect(flat(up).dot(flat(table).sub(flat(stand)))).toBeGreaterThan(0);
      });
    }
  }
});
