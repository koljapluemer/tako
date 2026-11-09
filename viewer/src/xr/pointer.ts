import * as THREE from 'three';

export type Pointer = {
  index: number;
  ray: THREE.Group;
  grip: THREE.Group;
  hand: THREE.Group & { joints: Record<string, THREE.Group | undefined> };
  source: XRInputSource | null;
};

export type Hand = 'left' | 'right';

/** Inputs that don't report a side count as right, so they can still teleport. */
export function handOf(pointer: Pointer): Hand {
  return pointer.source?.handedness === 'left' ? 'left' : 'right';
}

export function pointerRay(pointer: Pointer, out: THREE.Ray): THREE.Ray {
  pointer.ray.getWorldPosition(out.origin);
  out.direction.set(0, 0, -1).transformDirection(pointer.ray.matrixWorld);
  return out;
}

/** Forward-facing heading of the head, in radians around +Y. */
export function headYaw(camera: THREE.Camera): number {
  const d = camera.getWorldDirection(new THREE.Vector3());
  return Math.atan2(-d.x, -d.z);
}

/** The lower face button: X on the left controller, A on the right. */
export function lowerFaceButtonDown(source: XRInputSource | null): boolean {
  const pad = source?.gamepad;
  if (!pad || source!.hand || pad.mapping !== 'xr-standard') return false;
  return pad.buttons[4]?.pressed ?? false;
}

/** Thumbstick axes; xr-standard puts them at 2/3, some older mappings at 0/1. */
export function stick(source: XRInputSource | null): [number, number] | null {
  const pad = source?.gamepad;
  if (!pad || source!.hand || source!.targetRayMode !== 'tracked-pointer') return null;
  const a = pad.axes;
  if (a.length >= 4 && (a[2] !== 0 || a[3] !== 0)) return [a[2], a[3]];
  if (a.length >= 2 && a.length < 4) return [a[0], a[1]];
  return a.length >= 4 ? [a[2], a[3]] : null;
}
