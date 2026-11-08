import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import type { LoadedModel } from '../model';
import type { Sample } from '../samples';
import type { VersionSource } from '../versions';
import { Arc } from './arc';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import { Fade } from './fade';
import { Hud } from './hud';
import { Inspect } from './inspect';
import { navReach, spawnLanding, storeyLandings, type Landing } from './landing';
import { Menu, type MenuChoice } from './menu';
import { MiniModel } from './mini-model';
import { pollOpeners } from './openers';
import { headYaw, pointerRay, stick, Teleport, type Destination, type Pointer } from './teleport';
import { Walking } from './walking';

const POINTER_COUNT = 4; // two hands plus two controllers on multimodal headsets
const NEAR = 0.05;
const FAR = 2000;

function pointerVisual() {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 0.25, 6).rotateX(Math.PI / 2), material);
  beam.position.z = -0.125;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), material);
  const group = new THREE.Group();
  group.add(beam, tip);
  return group;
}

const head = new THREE.Vector3();
const pivot = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const feet = new THREE.Vector3();
const direction = new THREE.Vector3();
const controllerModels = new XRControllerModelFactory();
const handModels = new XRHandModelFactory();
const MAX_RESCUE_DISTANCE = 30;
const SNAP_ANGLE = THREE.MathUtils.degToRad(30);
const SNAP_PRESS = 0.8;
const SNAP_RELEASE = 0.3;

export class XRWalk {
  readonly rig = new THREE.Group();
  private fade: Fade;
  private walking: Walking;
  private teleport: Teleport;
  private menu: Menu;
  private inspect: Inspect;
  private arc: Arc;
  private mini: MiniModel;
  private hud: Hud | null;
  private pointers: Pointer[] = [];
  private model: LoadedModel | null = null;
  private spawn: (Landing & { yaw?: number }) | null = null;
  private needsPlacement = false;
  private spaceReady = false;
  private snapped = new WeakSet<Pointer>();
  /** The camera only carries the headset's pose once a frame has been rendered in the session. */
  private sessionFrames = 0;
  private previous = performance.now();
  private desktop = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), near: 0, far: 0 };
  private modelChangedInSession = false;
  /** The desktop view needs reframing after a model switch that happened in VR. */
  onExit: (reframe: boolean) => void = () => {};

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
    renderer.xr.enabled = true;
    renderer.xr.setFoveation(1);
    this.rig.add(camera);
    scene.add(this.rig);

    this.fade = new Fade(camera);
    this.walking = new Walking(this.rig, camera, this.fade);
    this.teleport = new Teleport(scene, camera, () => this.walking.floorY);
    this.menu = new Menu(scene, camera);
    this.inspect = new Inspect(scene, camera);
    this.arc = new Arc(scene, camera);
    this.mini = new MiniModel(scene);
    this.mini.onCommit = (point) => void this.travel({ point: new THREE.Vector3(...point.position), yaw: point.yaw });
    this.menu.onChoose = (choice, ray) => this.openObject(choice, ray);
    this.menu.show(false);
    this.hud = Hud.enabled() ? new Hud(renderer, camera) : null;

    this.teleport.claim = (pointer) => {
      const ray = pointerRay(pointer, new THREE.Ray());
      if (pointer.source?.hand && this.mini.grabStart(pointer.index, this.grabPosition(pointer))) return true;
      return this.mini.press(ray) || this.arc.press(ray) || this.menu.press(ray) || this.inspect.press(ray);
    };
    this.teleport.tap = (pointer) => void this.inspect.tap(pointerRay(pointer, new THREE.Ray()));
    this.teleport.commit = (destination, pointer) => void this.travel(destination, pointer);

    for (let index = 0; index < POINTER_COUNT; index++) this.addPointer(index);

    renderer.xr.addEventListener('sessionstart', () => this.onSessionStart());
    renderer.xr.addEventListener('sessionend', () => this.onSessionEnd());

    document.body.appendChild(VRButton.createButton(renderer, {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hand-tracking', 'bounded-floor'],
    }));
  }

  private addPointer(index: number) {
    const ray = this.renderer.xr.getController(index) as unknown as THREE.Group;
    const grip = this.renderer.xr.getControllerGrip(index) as unknown as THREE.Group;
    this.rig.add(ray, grip);
    const visual = pointerVisual();
    visual.visible = false;
    ray.add(visual);

    grip.add(controllerModels.createControllerModel(grip));
    const hand = this.renderer.xr.getHand(index) as unknown as THREE.Group & { joints: Record<string, THREE.Group | undefined> };
    hand.add(handModels.createHandModel(hand as never, 'mesh'));
    this.rig.add(hand);

    const pointer: Pointer = { index, ray, grip, hand, source: null, downAt: null, consumed: false };
    this.pointers.push(pointer);
    const events = ray as unknown as THREE.EventDispatcher<Record<string, { data?: XRInputSource }>>;
    events.addEventListener('connected', (e) => {
      pointer.source = e.data ?? null;
      // A transient pointer's ray comes from the eyes, so a beam would sit in the user's face.
      visual.visible = pointer.source?.targetRayMode === 'tracked-pointer';
    });
    events.addEventListener('disconnected', () => {
      this.teleport.disconnected(pointer);
      this.mini.grabEnd(index);
      pointer.source = null;
      visual.visible = false;
    });
    events.addEventListener('selectstart', () => this.teleport.selectStart(pointer));
    events.addEventListener('selectend', () => {
      if (pointer.source?.hand) this.mini.grabEnd(index);
      this.teleport.selectEnd(pointer);
    });
    events.addEventListener('squeezestart', () => this.mini.grabStart(index, this.grabPosition(pointer)));
    events.addEventListener('squeezeend', () => this.mini.grabEnd(index));
  }

  private grabPosition(pointer: Pointer) {
    return (pointer.grip.visible ? pointer.grip : pointer.ray).getWorldPosition(new THREE.Vector3());
  }

  /** Index fingertip for hands, the front of the controller otherwise. */
  private tipPosition(pointer: Pointer) {
    const joint = pointer.source?.hand ? pointer.hand.joints['index-finger-tip'] : null;
    if (joint?.visible) return joint.getWorldPosition(new THREE.Vector3());
    return pointer.source?.targetRayMode === 'tracked-pointer' ? pointer.ray.getWorldPosition(new THREE.Vector3()) : null;
  }

  private openObject(choice: MenuChoice, ray: THREE.Ray) {
    if (choice === 'arc') return this.arc.toggle(ray);
    if (!this.mini.available) return this.menu.showNotice('Mapping walkable areas…', false);
    this.camera.getWorldPosition(head);
    this.mini.toggle(ray, head);
  }

  get presenting() {
    return this.renderer.xr.isPresenting;
  }

  private onSessionStart() {
    const { camera, desktop } = this;
    desktop.position.copy(camera.position);
    desktop.quaternion.copy(camera.quaternion);
    desktop.near = camera.near;
    desktop.far = camera.far;
    camera.near = NEAR;
    camera.far = FAR;
    camera.updateProjectionMatrix();
    this.modelChangedInSession = false;
    this.menu.show(true);
    this.previous = performance.now();
    this.needsPlacement = true;
    this.sessionFrames = 0;
    this.fade.set('start', 1);
    this.spaceReady = false;
    void this.useBoundedFloor();
  }

  /** Worth having where the headset offers it, but `local-floor` works everywhere. */
  private async useBoundedFloor() {
    try {
      const space = await this.renderer.xr.getSession()?.requestReferenceSpace('bounded-floor');
      if (space) this.renderer.xr.setReferenceSpace(space);
    } catch {
      // Stays on local-floor.
    }
    this.renderer.xr.getReferenceSpace()?.addEventListener('reset', this.onRecentre);
    this.spaceReady = true;
  }

  private onSessionEnd() {
    const { camera, desktop } = this;
    this.fade.reset();
    this.teleport.cancel();
    this.teleport.locked = false;
    this.walking.restoreDoors();
    this.menu.show(false);
    this.arc.close();
    this.mini.close();
    this.inspect.close();
    this.rig.position.set(0, 0, 0);
    this.rig.rotation.set(0, 0, 0);
    camera.position.copy(desktop.position);
    camera.quaternion.copy(desktop.quaternion);
    camera.near = desktop.near;
    camera.far = desktop.far;
    camera.updateProjectionMatrix();
    this.onExit(this.modelChangedInSession);
  }

  /** The user recentred the headset: their tracked position jumped, so walls crossed "in transit" don't count. */
  private onRecentre = () => {
    this.walking.resetTracking(this.walking.floorY);
    this.revalidate();
  };

  setSamples(samples: Sample[], open: (sample: Sample) => void) {
    this.arc.setSamples(samples, open);
  }

  setVersions(source: VersionSource) {
    this.arc.source = source;
  }

  /** The DOM status line can't be seen from inside the headset. */
  notify(text: string, busy: boolean) {
    if (this.presenting) this.menu.showNotice(text, busy);
  }

  // --- moving the user ------------------------------------------------------
  /** Puts the head (not the play-area centre) at the point, optionally turning to face `yaw`. */
  private placeHead(point: THREE.Vector3, yaw: number | null) {
    this.rig.updateMatrixWorld(true);
    this.camera.getWorldPosition(head);
    if (yaw != null) {
      const delta = yaw - headYaw(this.camera);
      pivot.subVectors(this.rig.position, head).applyAxisAngle(UP, delta);
      this.rig.position.copy(head).add(pivot);
      this.rig.rotation.y += delta;
      this.rig.updateMatrixWorld(true);
      this.camera.getWorldPosition(head);
    }
    this.rig.position.x += point.x - head.x;
    this.rig.position.z += point.z - head.z;
    this.walking.resetTracking(point.y);
  }

  /** Rotation only, for seated use: there is deliberately no stick movement. */
  private updateSnapTurn() {
    if (this.teleport.aiming || this.teleport.locked) return;
    for (const pointer of this.pointers) {
      const axes = stick(pointer.source);
      const x = axes ? axes[0] : 0;
      if (Math.abs(x) < SNAP_RELEASE) this.snapped.delete(pointer);
      else if (Math.abs(x) > SNAP_PRESS && !this.snapped.has(pointer)) {
        this.snapped.add(pointer);
        this.turn(-Math.sign(x) * SNAP_ANGLE);
      }
    }
  }

  private turn(delta: number) {
    this.camera.getWorldPosition(head);
    pivot.subVectors(this.rig.position, head).applyAxisAngle(UP, delta);
    this.rig.position.x = head.x + pivot.x;
    this.rig.position.z = head.z + pivot.z;
    this.rig.rotation.y += delta;
  }

  private async travel({ point, yaw }: Destination, pointer?: Pointer) {
    if (this.teleport.locked) return;
    this.teleport.locked = true;
    this.inspect.close();
    await this.fade.to('teleport', 1, 90);
    if (this.presenting) this.placeHead(point, yaw);
    pulse(pointer?.source ?? null);
    await this.fade.to('teleport', 0, 120);
    this.teleport.locked = false;
  }

  // --- model swaps ----------------------------------------------------------
  /** Darkens the view around a swap while in VR; a plain call on desktop. */
  async swap(replace: () => void) {
    if (!this.presenting) return replace();
    await this.fade.to('reload', 1, 90);
    replace();
    await this.fade.to('reload', 0, 120);
  }

  /** Call as the new model goes live. `switched`: a different building, not a revision of this one. */
  setModel(model: LoadedModel, switched: boolean) {
    const before = this.model;
    this.model = model;
    this.teleport.cancel();
    this.walking.setModel(model.collision, model.doorCells);
    this.teleport.setModel(model.collision);
    this.teleport.reach = null;
    this.inspect.setModel(model.collision, model.doors);
    const landings = storeyLandings(model.collision, model.storeys, model.terrain);
    this.spawn = spawnLanding(landings);
    this.menu.clearNotice();
    this.mini.setData(null, [], []);
    if (model.nav) this.setNavigation(model); // a cached revision already has one

    if (!this.presenting) return;
    if (switched) {
      this.modelChangedInSession = true;
      this.arc.close();
      this.mini.close();
    } else {
      this.arc.refresh();
    }
    if (this.needsPlacement) return; // update() places the user once the headset pose is live
    if (switched || !before) return this.placeAtSpawn();

    // web-ifc's origin shift can differ between revisions; keep the user on the same bit of building.
    const [a, b] = [before.coordination, model.coordination];
    if (a[12] !== b[12] || a[13] !== b[13] || a[14] !== b[14]) {
      const shift = new THREE.Vector3(b[12] - a[12], b[13] - a[13], b[14] - a[14]);
      this.rig.position.add(shift);
      this.walking.resetTracking(this.rig.position.y);
      this.walking.lastValid?.add(shift);
    }
    this.revalidate();
  }

  /** The navmesh arrives after the model; until then teleport works from IFC classes. */
  setNavigation(model: LoadedModel) {
    if (model !== this.model || !model.nav) return;
    this.walking.setNavigation(model.nav);
    const reach = navReach(model.nav, () => this.feet());
    this.teleport.reach = reach;
    const landings = storeyLandings(model.collision, model.storeys, model.terrain, reach);
    const entrance = model.points.find((point) => point.type === 'entrance');
    this.spawn = entrance
      ? { name: entrance.name, position: new THREE.Vector3(...entrance.position), yaw: entrance.yaw }
      : spawnLanding(landings);
    this.mini.setData(model.nav, model.points, model.levels);
  }

  private feet() {
    this.camera.getWorldPosition(head);
    return new THREE.Vector3(head.x, this.walking.floorY, head.z);
  }

  private placeAtSpawn() {
    this.needsPlacement = false;
    if (this.spawn) return this.placeHead(this.spawn.position, this.spawn.yaw ?? null);
    // A model with no usable floor can still be looked at, from beside it.
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model.group);
    const point = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, box.max.z + 3);
    this.placeHead(point, null);
  }

  /** An edit may have removed what the user was standing on, or put a wall where they are. */
  private revalidate() {
    const { walking, model } = this;
    if (!model) return;
    this.camera.getWorldPosition(head);
    const standing = (x: number, y: number, z: number) => walking.floorAt(x, z, y);
    const y = standing(head.x, walking.floorY, head.z);
    if (y != null && model.collision.distanceTo(head, 0.05) >= 0.05) return walking.resetTracking(y);
    feet.set(head.x, walking.floorY, head.z);
    const nearest = model.nav?.nearest(feet, MAX_RESCUE_DISTANCE);
    if (nearest) return this.placeHead(nearest, null);
    const last = walking.lastValid;
    const fallbackY = last && standing(last.x, last.y, last.z);
    if (last && fallbackY != null) {
      return this.placeHead(new THREE.Vector3(last.x, fallbackY, last.z), null);
    }
    this.placeAtSpawn();
  }

  // --- frame -----------------------------------------------------------------
  update() {
    const now = performance.now();
    // Clamped so a hitch can't turn into a jump in the floor-following damping.
    const dt = Math.min((now - this.previous) / 1000, 0.1);
    this.previous = now;
    this.rig.updateMatrixWorld(true);

    if (this.needsPlacement) {
      if (++this.sessionFrames <= 2 || !this.model || !this.spaceReady) return this.fade.update(now);
      this.placeAtSpawn();
      this.rig.updateMatrixWorld(true);
      void this.fade.to('start', 0, 200);
    }
    this.walking.update(dt);
    this.teleport.update(this.pointers);
    this.updateSnapTurn();
    const rays = this.pointers.filter((p) => p.source && p.ray.visible).map((p) => pointerRay(p, new THREE.Ray()));
    this.menu.update(dt, rays);
    this.arc.update(rays);
    pollOpeners(this.pointers, (choice, pointer) => this.openObject(choice, pointerRay(pointer, new THREE.Ray())));
    this.camera.getWorldPosition(head);
    this.camera.getWorldDirection(direction);
    this.mini.update({
      user: { x: head.x, y: this.walking.floorY, z: head.z, yaw: Math.atan2(-direction.x, -direction.z) },
      grabs: this.pointers.map((p) => ({ id: p.index, position: this.grabPosition(p) })),
      tips: this.pointers.flatMap((p) => {
        const tip = this.tipPosition(p);
        return tip ? [{ id: p.index, position: tip }] : [];
      }),
      rays,
    });
    this.hud?.update(now);
    this.fade.update(now);
  }
}

function pulse(source: XRInputSource | null) {
  const pad = source?.gamepad as (Gamepad & { hapticActuators?: Array<{ pulse?: (v: number, ms: number) => unknown }> }) | undefined;
  try {
    pad?.hapticActuators?.[0]?.pulse?.(0.4, 40);
  } catch {
    // Haptics are a nicety; devices that refuse them lose nothing.
  }
}
