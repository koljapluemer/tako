import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import type { LoadedModel } from '../model';
import type { Sample } from '../samples';
import { formatAge, type Version, type VersionSource } from '../versions';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';
import { changeView } from './change-view';
import { ControllerPanel, type PanelButton, type Tool } from './controller-panel';
import { Fade } from './fade';
import { ballisticPath, FloorAim, straightPath, type Destination } from './floor-aim';
import { Hold, TapHold } from './hold';
import { HoldRing } from './hold-ring';
import { Hud } from './hud';
import { navReach, spawnLanding, storeyLandings } from './landing';
import { PALETTE, type Stroke, type Vec3 } from './paint-log';
import { handOf, headYaw, lowerFaceButtonDown, pointerRay, stick, upperFaceButtonDown, type Pointer } from './pointer';
import { Spawn, type Spot } from './spawn';
import { Spray } from './spray';
import { SprayCan } from './spray-can';
import { Station } from './station';
import { Walking } from './walking';

const POINTER_COUNT = 4; // two hands plus two controllers on multimodal headsets
const NEAR = 0.05;
const FAR = 2000;

function pointerVisual() {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.0015, 0.25, 6).rotateX(Math.PI / 2), material);
  beam.position.z = -0.125;
  // Its own material: the tip shows the colour the next stroke will get.
  const tipMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.008, 10, 8), tipMaterial);
  const group = new THREE.Group();
  group.add(beam, tip);
  return { group, tipMaterial };
}

const head = new THREE.Vector3();
const pivot = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
const MAX_FLOOR_SEARCH = 50;
const feet = new THREE.Vector3();
const direction = new THREE.Vector3();
const controllerModels = new XRControllerModelFactory();
const handModels = new XRHandModelFactory();
const MAX_RESCUE_DISTANCE = 30;
const SNAP_ANGLE = THREE.MathUtils.degToRad(30);
const SNAP_PRESS = 0.8;
const SNAP_RELEASE = 0.3;
const AIM_PRESS = 0.7;
const AIM_RELEASE = 0.25;
const RETURN_HOLD_MS = 800;
const SPRAY_INTERVAL_MS = 50;
const SPRAY_JITTER = Math.tan(THREE.MathUtils.degToRad(1.5));
/** Taps shouldn't flash the ring. */
const PAINT_RING_DELAY = 150 / RETURN_HOLD_MS;
const NO_COLOUR_TIP = 0x808080;
/** Lets a ray graze the changed element's own surface before its bounds start. */
const SIGHT_SLACK = 0.1;

export class XRWalk {
  readonly rig = new THREE.Group();
  private fade: Fade;
  private walking: Walking;
  private teleport: FloorAim;
  private placement: FloorAim;
  /** Set while the user is being moved. */
  private locked = false;
  private talking = false;
  /** Called with true when hold-to-talk starts, and false when it ends. */
  onTalk: ((talking: boolean) => void) | null = null;
  private stickAims = new Map<Pointer, FloorAim>();
  /** Sticks that have recentred since their last push. */
  private sticksAtRest = new WeakSet<Pointer>();
  private station: Station;
  private hud: Hud | null;
  private pointers: Pointer[] = [];
  private model: LoadedModel | null = null;
  private spawn = new Spawn();
  private needsPlacement = false;
  private spaceReady = false;
  private snapped = new WeakSet<Pointer>();
  private returnHold = new Hold(RETURN_HOLD_MS);
  private returnRing: HoldRing;
  readonly spray: Spray;
  private spraying = new Map<Pointer, { stroke: Stroke; next: number }>();
  private paintButton = new TapHold(RETURN_HOLD_MS);
  private tips: THREE.MeshBasicMaterial[] = [];
  private cans: SprayCan[] = [];
  /** What the right trigger does when it isn't pressing a panel. */
  private tool: Tool = 'pointer';
  private controllerPanel = new ControllerPanel();
  /** Kept between sessions; only applies while in VR. */
  private highlight = true;
  /** Called when the change highlight is switched on or off. */
  onHighlight: (on: boolean) => void = () => {};
  /** The latest edit's bounds, until the next edit or model switch. */
  private change: { box: THREE.Box3; centre: THREE.Vector3 } | null = null;
  private messageBusy = false;
  private versions: VersionSource | null = null;
  /** Drops a revision list that arrives after a newer one was asked for. */
  private revisionRequest = 0;
  /** What a ray hits in the current model. */
  pickAt: ((ray: THREE.Ray) => { point: THREE.Vector3; normal: THREE.Vector3; expressID: number } | null) | null = null;
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

    this.fade = new Fade(camera, !Hud.enabled());
    this.returnRing = new HoldRing(camera);
    this.spray = new Spray(scene);
    this.walking = new Walking(this.rig, camera, this.fade);
    const floorY = () => this.walking.floorY;
    this.teleport = new FloorAim(scene, camera, floorY, { path: ballisticPath, facing: true, stand: true });
    this.placement = new FloorAim(scene, camera, floorY, { path: straightPath, facing: false, stand: false });
    this.controllerPanel.onButton = (button) => this.onPanelButton(button);
    this.station = new Station(scene);
    this.station.onPin = (point) => void this.travel({ point: new THREE.Vector3(...point.position), yaw: point.yaw });
    this.hud = Hud.enabled() ? new Hud(renderer, camera) : null;

    this.teleport.commit = (destination, pointer) => void this.travel(destination, pointer);
    this.placement.commit = ({ point }) => this.station.place(point, this.camera.getWorldPosition(new THREE.Vector3()));

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
    const { group: visual, tipMaterial } = pointerVisual();
    this.tips.push(tipMaterial);
    visual.visible = false;
    ray.add(visual);
    const can = new SprayCan();
    this.cans.push(can);
    ray.add(can.group);

    grip.add(controllerModels.createControllerModel(grip));
    const hand = this.renderer.xr.getHand(index) as unknown as THREE.Group & { joints: Record<string, THREE.Group | undefined> };
    hand.add(handModels.createHandModel(hand as never, 'mesh'));
    this.rig.add(hand);

    const pointer: Pointer = { index, ray, grip, hand, source: null };
    this.pointers.push(pointer);
    const events = ray as unknown as THREE.EventDispatcher<Record<string, { data?: XRInputSource }>>;
    events.addEventListener('connected', (e) => {
      pointer.source = e.data ?? null;
      // A transient pointer's ray comes from the eyes, so a beam would sit in the user's face.
      visual.visible = pointer.source?.targetRayMode === 'tracked-pointer';
    });
    events.addEventListener('disconnected', () => {
      this.station.grabEnd(index);
      this.station.pressEnd(index);
      this.stopSpray(pointer);
      pointer.source = null;
      visual.visible = false;
    });
    events.addEventListener('selectstart', () => this.press(pointer));
    events.addEventListener('selectend', () => {
      this.station.pressEnd(index);
      this.stopSpray(pointer);
      if (pointer.source?.hand) this.station.grabEnd(index);
    });
    events.addEventListener('squeezestart', () => this.station.grabStart(index, this.grabPosition(pointer)));
    events.addEventListener('squeezeend', () => this.station.grabEnd(index));
  }

  /** The right controller sprays while it holds the can; every trigger presses panels first. */
  private sprays(pointer: Pointer) {
    return this.tool === 'spray' && isController(pointer) && handOf(pointer) === 'right';
  }

  private press(pointer: Pointer) {
    const ray = pointerRay(pointer, new THREE.Ray());
    if (pointer.source?.hand && this.station.grabStart(pointer.index, this.grabPosition(pointer))) return;
    if (this.controllerPanel.press(ray) || this.station.press(ray, pointer.index)) return;
    if (this.sprays(pointer)) this.startSpray(pointer);
  }

  private onPanelButton(button: PanelButton) {
    if (button === 'pointer' || button === 'spray') {
      this.tool = button;
      this.controllerPanel.setTool(button);
    } else if (button === 'highlight-on' || button === 'highlight-off') {
      this.highlight = button === 'highlight-on';
      this.controllerPanel.setHighlight(this.highlight);
      this.onHighlight(this.highlight);
    } else if (button === 'rev-prev' || button === 'rev-next') {
      void this.stepRevision(button === 'rev-prev' ? -1 : 1);
    } else {
      this.goToChange();
    }
  }

  // --- revisions on the wrist -------------------------------------------------
  private async listVersions(): Promise<Version[]> {
    return await this.versions?.list().catch(() => [] as Version[]) ?? [];
  }

  /** Shows the current revision on the wrist, and whether there is one either side of it. */
  private async refreshRevision() {
    const request = ++this.revisionRequest;
    const versions = await this.listVersions();
    if (request !== this.revisionRequest) return;
    const index = versions.findIndex((v) => v.current);
    if (index < 0) return this.controllerPanel.setRevision(null);
    const version = versions[index];
    const next = index < versions.length - 1;
    const age = formatAge(version.createdAt);
    this.controllerPanel.setRevision({
      title: version.title,
      detail: next ? `${index + 1} of ${versions.length}${age ? ` · ${age}` : ''}` : 'Latest',
      prev: index > 0,
      next,
    });
  }

  /** Revisions keep the user where they stand, so stepping compares in place. */
  private async stepRevision(delta: number) {
    const versions = await this.listVersions();
    const index = versions.findIndex((v) => v.current);
    const target = index < 0 ? undefined : versions[index + delta];
    if (!target) return;
    pulse(this.pointers.find((p) => handOf(p) === 'left')?.source ?? null);
    this.versions?.select(target);
  }

  private startSpray(pointer: Pointer) {
    if (this.locked) return;
    const now = performance.now();
    const stroke = this.spray.log.beginStroke(now);
    if (stroke) this.spraying.set(pointer, { stroke, next: now });
    else this.notify('No colours left: undo or clear some paint', false);
  }

  private stopSpray(pointer: Pointer) {
    const spraying = this.spraying.get(pointer);
    if (!spraying) return;
    this.spraying.delete(pointer);
    this.spray.log.endStroke(spraying.stroke, performance.now());
  }

  private updateSpray(now: number) {
    if (this.locked || this.teleport.aiming || this.placement.aiming) return;
    for (const [pointer, spraying] of this.spraying) {
      if (now < spraying.next) continue;
      spraying.next = now + SPRAY_INTERVAL_MS;
      const ray = pointerRay(pointer, new THREE.Ray());
      ray.direction.x += (Math.random() - 0.5) * 2 * SPRAY_JITTER;
      ray.direction.y += (Math.random() - 0.5) * 2 * SPRAY_JITTER;
      ray.direction.z += (Math.random() - 0.5) * 2 * SPRAY_JITTER;
      ray.direction.normalize();
      const hit = this.pickAt?.(ray);
      if (!hit) continue;
      const normal = hit.normal.dot(ray.direction) > 0 ? hit.normal.clone().negate() : hit.normal;
      if (!this.spray.add(spraying.stroke, hit.point.toArray() as Vec3, normal.toArray() as Vec3, hit.expressID)) {
        this.stopSpray(pointer);
        this.notify('Paint is full: undo or clear some', false);
      }
    }
  }

  /** Tints the spraying tip with the next colour. Tapping A undoes a stroke; holding it clears all paint. */
  private updatePaint(now: number): number {
    const { log } = this.spray;
    const next = log.nextColor(now);
    const tint = next == null ? NO_COLOUR_TIP : PALETTE[next].hex;
    for (const p of this.pointers) {
      this.tips[p.index].color.setHex(this.sprays(p) ? tint : 0xffffff);
      this.cans[p.index].update(this.sprays(p) && p.ray.visible, tint);
    }

    // A only means something while the can is held.
    const pointer = this.pointers.find((p) => this.sprays(p) && lowerFaceButtonDown(p.source));
    const blocked = this.locked || this.teleport.aiming || this.placement.aiming || this.spraying.size > 0 || log.dotCount === 0;
    const { progress, tap } = this.paintButton.update(pointer != null, now, blocked);
    if (progress === 1) {
      this.spray.clear();
      pulse(pointer?.source ?? null);
    }
    if (tap) this.spray.undo(now);
    return progress < PAINT_RING_DELAY ? 0 : progress;
  }

  /** Where the user is, for the agent; null outside VR. */
  interactionPose() {
    if (!this.presenting || !this.model) return null;
    this.camera.getWorldPosition(head);
    this.camera.getWorldDirection(direction);
    return {
      head: head.toArray() as Vec3,
      forward: direction.toArray() as Vec3,
      floor: this.model.collision.raycastFloor(new THREE.Ray(head.clone(), DOWN), MAX_FLOOR_SEARCH)?.expressID ?? null,
    };
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
    this.previous = performance.now();
    this.needsPlacement = true;
    this.spawn.release();
    this.sessionFrames = 0;
    this.fade.set('start', 1);
    this.spaceReady = false;
    this.tool = 'pointer';
    this.controllerPanel.setTool(this.tool);
    this.onHighlight(this.highlight);
    void this.refreshRevision();
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
    if (this.talking) this.onTalk?.(false);
    this.talking = false;
    this.spraying.clear();
    this.spray.clear();
    this.fade.reset();
    this.teleport.cancel();
    this.placement.cancel();
    this.stickAims.clear();
    this.locked = false;
    this.returnHold.reset();
    this.returnRing.set(0); // the camera goes back to the desktop view with its children
    this.walking.restoreDoors();
    this.controllerPanel.setMessage(null);
    this.messageBusy = false;
    this.station.close();
    this.controllerPanel.attach(null);
    this.clearChange();
    // The setting is the headset's; the desktop always highlights.
    this.onHighlight(true);
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
    this.station.setSamples(samples, open);
  }

  setVersions(source: VersionSource) {
    this.versions = source;
    this.station.source = source;
  }

  /** The DOM status line can't be seen from inside the headset, so messages go on the wrist. Work finishing is felt in both hands. */
  notify(text: string, busy: boolean) {
    if (!this.presenting) return;
    if (this.messageBusy && !busy) for (const p of this.pointers) pulse(p.source, 0.6, 80);
    this.messageBusy = busy;
    this.controllerPanel.setMessage(text, busy);
  }

  // --- the latest change ---------------------------------------------------------
  /** Points the user to what the latest edit changed, until they have seen it. */
  setChange(box: THREE.Box3) {
    if (!this.presenting) return;
    this.change = { box: box.clone(), centre: box.getCenter(new THREE.Vector3()) };
  }

  clearChange() {
    this.change = null;
  }

  /** True when nothing in the building stands between `from` and the change. */
  private seesChange(from: THREE.Vector3, to: THREE.Vector3, box: THREE.Box3) {
    const ray = new THREE.Ray(from.clone(), to.clone().sub(from).normalize());
    const entry = ray.intersectBox(box, new THREE.Vector3());
    const reach = entry ? entry.distanceTo(from) : from.distanceTo(to);
    const hit = this.model?.collision.raycast(ray, reach);
    return !hit || hit.distance >= reach - SIGHT_SLACK;
  }

  private goToChange() {
    const { change, model } = this;
    if (!change || !model) return;
    const { box, centre } = change;
    const above = new THREE.Vector3(centre.x, box.min.y + 0.5, centre.z);
    const floorY = model.collision.raycastFloor(new THREE.Ray(above, DOWN), MAX_FLOOR_SEARCH)?.point.y ?? box.min.y;
    this.camera.getWorldPosition(head);
    const view = changeView(centre, floorY, head, {
      nearest: (point, max) => model.nav?.nearest(point, max) ?? null,
      clear: (from, to) => this.seesChange(from, to, box),
    });
    if (view) void this.travel(view);
    else this.notify('No place to stand near the change', false);
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

  /** Stick forward starts that hand's aim and letting it spring back commits; it may swing freely in between. */
  private updateStickAims() {
    for (const pointer of this.pointers) {
      const axes = stick(pointer.source);
      const tilt = axes ? Math.hypot(axes[0], axes[1]) : 0;
      const aim = this.stickAims.get(pointer);
      if (aim && tilt >= AIM_RELEASE) continue;
      if (aim) {
        this.stickAims.delete(pointer);
        if (axes) aim.release(pointer);
        else aim.abandon(pointer);
      }
      if (tilt < AIM_RELEASE) this.sticksAtRest.add(pointer);
      else if (axes && tilt > AIM_PRESS && !this.locked && this.sticksAtRest.delete(pointer) && -axes[1] > Math.abs(axes[0])) {
        const next = handOf(pointer) === 'right' ? this.teleport : this.placement;
        next.begin(pointer);
        this.stickAims.set(pointer, next);
      }
    }
  }

  /** Rotation only, for seated use: there is deliberately no stick movement. */
  private updateSnapTurn() {
    if (this.teleport.aiming || this.locked) return;
    for (const pointer of this.pointers) {
      if (handOf(pointer) !== 'right') continue;
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

  /** Holding X on the left controller goes back to the start; aiming or travelling takes priority. */
  private updateReturnHold(now: number): number {
    const pointer = this.pointers.find((p) => handOf(p) === 'left' && lowerFaceButtonDown(p.source));
    const blocked = this.locked || this.teleport.aiming || this.placement.aiming;
    const progress = this.returnHold.update(pointer != null, now, blocked);
    if (progress === 1) void this.jump(() => this.returnToSpawn(), pointer);
    return progress;
  }

  /** An edit since the start may have put a wall on the spot or removed its floor. */
  private returnToSpawn() {
    this.placeAtSpawn();
    this.revalidate();
  }

  private travel({ point, yaw }: Destination, pointer?: Pointer) {
    return this.jump(() => this.placeHead(point, yaw), pointer);
  }

  private async jump(move: () => void, pointer?: Pointer) {
    if (this.locked) return;
    this.locked = true;
    await this.fade.to('teleport', 1, 90);
    if (this.presenting) {
      move();
    }
    pulse(pointer?.source ?? null);
    await this.fade.to('teleport', 0, 120);
    this.locked = false;
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
    for (const aim of [this.teleport, this.placement]) {
      aim.cancel();
      aim.setModel(model.collision);
      aim.reach = null;
    }
    this.walking.setModel(model.collision, model.doorCells);
    this.station.setCollision(model.collision);
    const landings = storeyLandings(model.collision, model.storeys, model.terrain);
    if (switched) {
      this.spawn.release();
      this.clearChange();
    }
    this.spawn.offer(spawnLanding(landings));
    // A "Loading…" message is done once the model is in; a finished reply stays readable.
    if (this.controllerPanel.messageBusy) this.controllerPanel.setMessage(null);
    this.station.setNavigation(null);
    if (model.nav) this.setNavigation(model); // a cached revision already has one

    if (!this.presenting) return;
    void this.refreshRevision();
    if (switched) {
      this.modelChangedInSession = true;
      this.station.close();
    } else {
      this.station.refresh();
    }
    if (this.needsPlacement) return; // update() places the user once the headset pose is live
    if (switched || !before) return this.placeAtSpawn();

    // web-ifc's origin shift can differ between revisions; keep the user on the same bit of building.
    const [a, b] = [before.coordination, model.coordination];
    if (a[12] !== b[12] || a[13] !== b[13] || a[14] !== b[14]) {
      const shift = new THREE.Vector3(b[12] - a[12], b[13] - a[13], b[14] - a[14]);
      this.rig.position.add(shift);
      this.spawn.translate(shift);
      this.station.translate(shift);
      this.spray.translate(shift);
      this.change?.box.translate(shift);
      this.change?.centre.add(shift);
      this.walking.resetTracking(this.rig.position.y);
      this.walking.lastValid?.add(shift);
    }
    this.revalidate();
  }

  /** The navmesh arrives after the model; it adds walkable surfaces the IFC classes miss. */
  setNavigation(model: LoadedModel) {
    if (model !== this.model || !model.nav) return;
    this.walking.setNavigation(model.nav);
    const reach = navReach(model.nav);
    this.teleport.reach = reach;
    this.placement.reach = reach;
    const landings = storeyLandings(model.collision, model.storeys, model.terrain, reach);
    const entrance = model.points.find((point) => point.type === 'entrance');
    this.spawn.offer(entrance
      ? { name: entrance.name, position: new THREE.Vector3(...entrance.position), yaw: entrance.yaw }
      : spawnLanding(landings));
    this.station.setNavigation(model);
  }

  private updateTalk() {
    const pressing = this.pointers.find((p) => upperFaceButtonDown(p.source));
    if (!!pressing === this.talking) return;
    this.talking = !!pressing;
    if (pressing) pulse(pressing.source);
    this.onTalk?.(this.talking);
  }

  private placeAtSpawn() {
    this.needsPlacement = false;
    // Here rather than in the frame loop: a model arriving during session start places the user too.
    void this.fade.to('start', 0, 200);
    const spot = this.spawn.spot ?? this.besideModel();
    if (!spot) return;
    this.spawn.pin(spot);
    this.placeHead(spot.position, spot.yaw ?? null);
  }

  /** A model with no usable floor can still be looked at, from beside it. */
  private besideModel(): Spot | null {
    if (!this.model) return null;
    const box = new THREE.Box3().setFromObject(this.model.group);
    return { name: 'Beside the model', position: new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, box.max.z + 3) };
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
    if (!this.hud) return this.frame(now);
    try {
      this.frame(now);
    } catch (err) {
      console.error(err);
      this.hud.error(err);
    }
    this.hud.update(now, this.debugState());
  }

  private debugState() {
    const { model, spawn, walking } = this;
    const text = (v: THREE.Vector3) => `${v.x.toFixed(1)} ${v.y.toFixed(1)} ${v.z.toFixed(1)}`;
    this.camera.getWorldPosition(head);
    return [
      `placing ${this.needsPlacement} f${this.sessionFrames}`,
      `model ${model != null} nav ${model?.nav != null}`,
      `space ${this.spaceReady}`,
      `fade ${this.fade.describe()}`,
      `head ${text(head)}`,
      `floor ${walking.floorY.toFixed(1)} wall ${model ? model.collision.distanceTo(head, 0.5).toFixed(2) : '-'}`,
      `spawn ${spawn.phase} ${spawn.spot ? text(spawn.spot.position) : 'none'}`,
    ];
  }

  private frame(now: number) {
    // Clamped so a hitch can't turn into a jump in the floor-following damping.
    const dt = Math.min((now - this.previous) / 1000, 0.1);
    this.previous = now;
    this.rig.updateMatrixWorld(true);

    if (this.needsPlacement) {
      if (++this.sessionFrames <= 2 || !this.model || !this.spaceReady) return this.fade.update(now);
      this.placeAtSpawn();
      this.rig.updateMatrixWorld(true);
    }
    this.walking.update(dt);
    this.updateStickAims();
    this.teleport.update();
    this.placement.update();
    this.returnRing.set(Math.max(this.updateReturnHold(now), this.updatePaint(now)));
    this.updateSpray(now);
    this.updateTalk();
    this.updateSnapTurn();
    const rays = this.pointers.filter((p) => p.source && p.ray.visible && !this.spraying.has(p)).map((p) => ({ id: p.index, ray: pointerRay(p, new THREE.Ray()) }));
    // On the left controller; on the right one only if it is the only controller tracked.
    const held = (hand: 'left' | 'right') => this.pointers.find((p) => isController(p) && handOf(p) === hand && p.grip.visible);
    this.controllerPanel.attach((held('left') ?? held('right'))?.grip ?? null);
    this.controllerPanel.update(rays.map(({ ray }) => ray), this.change?.centre ?? null);
    this.camera.getWorldPosition(head);
    this.camera.getWorldDirection(direction);
    this.station.update({
      user: { x: head.x, y: this.walking.floorY, z: head.z, yaw: Math.atan2(-direction.x, -direction.z) },
      grabs: this.pointers.map((p) => ({ id: p.index, position: this.grabPosition(p) })),
      tips: this.pointers.flatMap((p) => {
        const tip = this.tipPosition(p);
        return tip ? [{ id: p.index, position: tip }] : [];
      }),
      rays,
    });
    this.fade.update(now);
  }
}

/** A physical controller rather than a tracked hand or a transient (gaze or screen) pointer. */
function isController(pointer: Pointer) {
  return !pointer.source?.hand && pointer.source?.targetRayMode === 'tracked-pointer';
}

function pulse(source: XRInputSource | null, intensity = 0.4, ms = 40) {
  const pad = source?.gamepad as (Gamepad & { hapticActuators?: Array<{ pulse?: (v: number, ms: number) => unknown }> }) | undefined;
  try {
    pad?.hapticActuators?.[0]?.pulse?.(intensity, ms);
  } catch {
    // Haptics are a nicety; devices that refuse them lose nothing.
  }
}
