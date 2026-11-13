import * as THREE from 'three';

// Feedback sounds for the headset: short synthesised cues plus a few CC0 Kenney clicks.
// All tuning lives in CUES and LOOPS; the dev sound board (/sounds.html) edits them live.

/** Every Kenney file shipped with the viewer, by file name. */
export const SAMPLE_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob('../assets/sounds/*.ogg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>)
    .map(([path, url]) => [path.split('/').pop()!, url]),
);

export type ToneLayer = { type: 'tone'; wave: OscillatorType; from: number; to: number; attack: number; decay: number; gain: number; delay?: number };
export type NoiseLayer = { type: 'noise'; from: number; to: number; q: number; attack: number; decay: number; gain: number; delay?: number };
export type SampleLayer = { type: 'sample'; file: string; rate: number; gain: number; delay?: number };
export type Layer = ToneLayer | NoiseLayer | SampleLayer;
/** `jitter`: random pitch spread, as a fraction, so repeats don't sound mechanical. */
export type CueSpec = { layers: Layer[]; jitter: number };

export const CUE_NAMES = [
  'press', 'toggleOn', 'toggleOff', 'disabled', 'tick', 'holdDone', 'landing', 'reject', 'place',
  'undo', 'clear', 'micOpen', 'micClose', 'progress', 'done', 'error', 'swap',
] as const;
export type Cue = (typeof CUE_NAMES)[number];

const tone = (from: number, to: number, attack: number, decay: number, gain: number, delay = 0, wave: OscillatorType = 'sine'): ToneLayer =>
  ({ type: 'tone', wave, from, to, attack, decay, gain, delay });
const noise = (from: number, to: number, q: number, attack: number, decay: number, gain: number, delay = 0): NoiseLayer =>
  ({ type: 'noise', from, to, q, attack, decay, gain, delay });
const sample = (file: string, gain: number, rate = 1): SampleLayer => ({ type: 'sample', file, rate, gain });

export const DEFAULT_CUES: Record<Cue, CueSpec> = {
  press: { layers: [sample('click3.ogg', 0.5)], jitter: 0.04 },
  toggleOn: { layers: [sample('switch2.ogg', 0.5, 1.05)], jitter: 0.02 },
  toggleOff: { layers: [sample('switch3.ogg', 0.5, 0.95)], jitter: 0.02 },
  disabled: { layers: [tone(180, 160, 0.003, 0.05, 0.15, 0, 'triangle')], jitter: 0.03 },
  tick: { layers: [tone(2400, 2400, 0.001, 0.012, 0.06, 0, 'triangle')], jitter: 0.04 },
  holdDone: { layers: [sample('click5.ogg', 0.5), tone(880, 880, 0.004, 0.12, 0.08, 0.02)], jitter: 0 },
  landing: { layers: [noise(300, 120, 0.8, 0.03, 0.14, 0.25), tone(110, 70, 0.004, 0.12, 0.25)], jitter: 0.04 },
  reject: { layers: [tone(220, 180, 0.004, 0.07, 0.18, 0, 'triangle'), tone(180, 150, 0.004, 0.09, 0.18, 0.08, 'triangle')], jitter: 0 },
  place: { layers: [tone(140, 90, 0.003, 0.1, 0.3), noise(800, 300, 1, 0.003, 0.06, 0.12)], jitter: 0.03 },
  undo: { layers: [noise(4000, 1200, 1.2, 0.005, 0.1, 0.3)], jitter: 0.05 },
  clear: { layers: [noise(5000, 600, 1, 0.02, 0.35, 0.35)], jitter: 0 },
  micOpen: { layers: [tone(660, 660, 0.004, 0.035, 0.12), tone(990, 990, 0.004, 0.04, 0.12, 0.035)], jitter: 0 },
  micClose: { layers: [tone(990, 990, 0.004, 0.035, 0.12), tone(660, 660, 0.004, 0.04, 0.12, 0.035)], jitter: 0 },
  progress: { layers: [tone(1320, 1320, 0.003, 0.05, 0.03)], jitter: 0.03 },
  done: { layers: [tone(784, 784, 0.005, 0.25, 0.12), tone(1175, 1175, 0.005, 0.35, 0.1, 0.09)], jitter: 0 },
  error: { layers: [tone(440, 440, 0.005, 0.12, 0.13, 0, 'triangle'), tone(330, 330, 0.005, 0.2, 0.13, 0.11, 'triangle')], jitter: 0 },
  swap: { layers: [noise(400, 2400, 0.7, 0.08, 0.2, 0.12)], jitter: 0.03 },
};

export type LoopSpecs = {
  spray: { low: number; high: number; q: number; gain: number };
  hold: { wave: OscillatorType; from: number; to: number; gain: number };
};
export const DEFAULT_LOOPS: LoopSpecs = {
  spray: { low: 1800, high: 5200, q: 0.9, gain: 0.25 },
  hold: { wave: 'triangle', from: 300, to: 600, gain: 0.05 },
};

export type Tuning = { master: number; cues: Record<Cue, CueSpec>; loops: LoopSpecs };
export const DEFAULT_TUNING: Tuning = { master: 0.8, cues: DEFAULT_CUES, loops: DEFAULT_LOOPS };

/** Where the dev sound board keeps its edits; the headset reads them in dev so tuning is live. */
export const TUNING_KEY = 'tako.sound-tuning';

export function loadTuning(): Tuning {
  const base = structuredClone(DEFAULT_TUNING);
  if (!import.meta.env.DEV) return base;
  try {
    const saved = JSON.parse(localStorage.getItem(TUNING_KEY) ?? 'null') as Partial<Tuning> | null;
    if (!saved) return base;
    return { master: saved.master ?? base.master, cues: { ...base.cues, ...saved.cues }, loops: { ...base.loops, ...saved.loops } };
  } catch {
    return base;
  }
}

const MIN_GAIN = 0.0001;
const SMOOTH = 0.03;
/** Ducked level for spray, hold and progress while the microphone is open. */
const DUCKED = 0.2;

export type PlayOptions = { at?: THREE.Vector3; gain?: number };

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Spray, hold and progress: what gets quieter while the user talks. */
  private quiet: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Map<string, Promise<void>>();
  private holdLoop: { osc: OscillatorNode; gain: GainNode } | null = null;
  /** Off outside VR: the desktop page stays silent. */
  enabled = false;

  constructor(public tuning: Tuning = loadTuning()) {}

  /** Call from a user gesture (and again on session start); browsers keep audio locked until then. */
  unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      limiter.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = this.tuning.master;
      this.master.connect(limiter);
      this.quiet = ctx.createGain();
      this.quiet.connect(this.master);
      this.noise = noiseBuffer(ctx);
      this.preload();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  /** Re-reads master volume and loads any newly chosen samples, after tuning changed. */
  retune(tuning: Tuning) {
    this.tuning = tuning;
    if (this.master) this.master.gain.value = tuning.master;
    this.preload();
  }

  private preload() {
    for (const spec of Object.values(this.tuning.cues)) void this.load(spec);
  }

  /** Fetches and decodes the spec's samples; resolves once they can play. */
  private load(spec: CueSpec): Promise<unknown> {
    const { ctx } = this;
    if (!ctx) return Promise.resolve();
    return Promise.all(spec.layers.map((layer) => {
      if (layer.type !== 'sample' || this.buffers.has(layer.file)) return undefined;
      const url = SAMPLE_URLS[layer.file];
      if (!url) return undefined;
      let pending = this.loading.get(layer.file);
      if (!pending) {
        pending = fetch(url)
          .then((response) => response.arrayBuffer())
          .then((data) => ctx.decodeAudioData(data))
          .then((buffer) => void this.buffers.set(layer.file, buffer))
          .catch((error) => console.warn('sound not loaded', layer.file, error))
          .finally(() => this.loading.delete(layer.file));
        this.loading.set(layer.file, pending);
      }
      return pending;
    }));
  }

  private get live() {
    return this.enabled && this.ctx?.state === 'running';
  }

  /** Follows the head; positioned cues are heard relative to it. */
  listen(camera: THREE.Camera) {
    if (!this.live) return;
    const { listener, currentTime: t } = this.ctx!;
    camera.getWorldPosition(position);
    camera.getWorldDirection(forward);
    up.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(rotation));
    if (listener.positionX) {
      listener.positionX.setTargetAtTime(position.x, t, 0.01);
      listener.positionY.setTargetAtTime(position.y, t, 0.01);
      listener.positionZ.setTargetAtTime(position.z, t, 0.01);
      listener.forwardX.setTargetAtTime(forward.x, t, 0.01);
      listener.forwardY.setTargetAtTime(forward.y, t, 0.01);
      listener.forwardZ.setTargetAtTime(forward.z, t, 0.01);
      listener.upX.setTargetAtTime(up.x, t, 0.01);
      listener.upY.setTargetAtTime(up.y, t, 0.01);
      listener.upZ.setTargetAtTime(up.z, t, 0.01);
    } else {
      listener.setPosition(position.x, position.y, position.z);
      listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** Plays a cue once; `at` places it in the world, otherwise it is head-locked. Ignored while disabled. */
  play(cue: Cue, options: PlayOptions = {}) {
    if (!this.live) return;
    this.render(this.tuning.cues[cue], options, cue === 'progress' ? this.quiet! : this.master!);
  }

  /** Plays a spec regardless of `enabled`, waiting for its samples: for the sound board. */
  async audition(spec: CueSpec, options: PlayOptions = {}) {
    this.unlock();
    await this.load(spec);
    if (this.ctx) this.render(spec, options, this.master!);
  }

  private render(spec: CueSpec, { at, gain = 1 }: PlayOptions, bus: AudioNode) {
    const ctx = this.ctx!;
    const out = at ? this.panner(at, bus) : bus;
    const rate = 1 + (Math.random() * 2 - 1) * spec.jitter;
    const now = ctx.currentTime + 0.005;
    for (const layer of spec.layers) {
      const start = now + (layer.delay ?? 0);
      if (layer.type === 'sample') {
        const buffer = this.buffers.get(layer.file);
        if (!buffer) continue; // still loading; a dropped click is better than a late one
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = layer.rate * rate;
        const level = ctx.createGain();
        level.gain.value = layer.gain * gain;
        source.connect(level).connect(out);
        source.start(start);
        continue;
      }
      const end = start + layer.attack + layer.decay;
      const envelope = ctx.createGain();
      envelope.gain.setValueAtTime(MIN_GAIN, start);
      envelope.gain.exponentialRampToValueAtTime(Math.max(layer.gain * gain, MIN_GAIN), start + layer.attack);
      envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
      envelope.connect(out);
      if (layer.type === 'tone') {
        const osc = ctx.createOscillator();
        osc.type = layer.wave;
        osc.frequency.setValueAtTime(layer.from * rate, start);
        osc.frequency.exponentialRampToValueAtTime(layer.to * rate, end);
        osc.connect(envelope);
        osc.start(start);
        osc.stop(end + 0.02);
      } else {
        const source = ctx.createBufferSource();
        source.buffer = this.noise;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = layer.q;
        filter.frequency.setValueAtTime(layer.from * rate, start);
        filter.frequency.exponentialRampToValueAtTime(layer.to * rate, end);
        source.connect(filter).connect(envelope);
        source.start(start, Math.random() * 0.5);
        source.stop(end + 0.02);
      }
    }
  }

  private panner(at: THREE.Vector3, out: AudioNode) {
    const panner = new PannerNode(this.ctx!, {
      panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1, rolloffFactor: 1,
      positionX: at.x, positionY: at.y, positionZ: at.z,
    });
    panner.connect(out);
    return panner;
  }

  /** A hiss that follows the can; `set(0, …)` mutes it without stopping it. */
  sprayLoop(): SprayLoop | null {
    if (!this.live && !this.auditioning) return null;
    const ctx = this.ctx!;
    const spec = this.tuning.loops.spray;
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = spec.q;
    filter.frequency.value = spec.low;
    const level = ctx.createGain();
    level.gain.value = MIN_GAIN;
    const panner = new PannerNode(ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 1 });
    source.connect(filter).connect(level).connect(panner).connect(this.quiet!);
    source.start(0, Math.random() * 0.5);
    return {
      set: (amount, at) => {
        const t = ctx.currentTime;
        const s = this.tuning.loops.spray;
        filter.frequency.setTargetAtTime(s.low + (s.high - s.low) * amount, t, SMOOTH);
        level.gain.setTargetAtTime(Math.max(s.gain * amount, MIN_GAIN), t, SMOOTH);
        if (at) {
          panner.positionX.setTargetAtTime(at.x, t, 0.01);
          panner.positionY.setTargetAtTime(at.y, t, 0.01);
          panner.positionZ.setTargetAtTime(at.z, t, 0.01);
        }
      },
      stop: () => {
        const t = ctx.currentTime;
        level.gain.setTargetAtTime(MIN_GAIN, t, SMOOTH);
        source.stop(t + 0.2);
      },
    };
  }

  /** Set true by the sound board so loops play outside VR. */
  auditioning = false;

  /** A quiet tone that rises with hold progress; 0 silences it. */
  hold(progress: number) {
    if (!this.ctx || (!this.live && !this.auditioning)) return this.stopHold();
    if (progress <= 0) return this.stopHold();
    const ctx = this.ctx;
    const spec = this.tuning.loops.hold;
    if (!this.holdLoop) {
      const osc = ctx.createOscillator();
      osc.type = spec.wave;
      const gain = ctx.createGain();
      gain.gain.value = MIN_GAIN;
      osc.connect(gain).connect(this.quiet!);
      osc.start();
      this.holdLoop = { osc, gain };
    }
    const t = ctx.currentTime;
    this.holdLoop.osc.frequency.setTargetAtTime(spec.from + (spec.to - spec.from) * progress, t, SMOOTH);
    this.holdLoop.gain.gain.setTargetAtTime(spec.gain * (0.3 + 0.7 * progress), t, SMOOTH);
  }

  private stopHold() {
    if (!this.holdLoop || !this.ctx) return;
    const { osc, gain } = this.holdLoop;
    this.holdLoop = null;
    gain.gain.setTargetAtTime(MIN_GAIN, this.ctx.currentTime, SMOOTH);
    osc.stop(this.ctx.currentTime + 0.2);
  }

  /** Lowers spray, hold and progress sounds while the microphone is open. */
  duck(on: boolean) {
    if (this.quiet && this.ctx) this.quiet.gain.setTargetAtTime(on ? DUCKED : 1, this.ctx.currentTime, SMOOTH);
  }
}

export type SprayLoop = { set(amount: number, at?: THREE.Vector3): void; stop(): void };

function noiseBuffer(ctx: AudioContext) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

const position = new THREE.Vector3();
const forward = new THREE.Vector3();
const up = new THREE.Vector3();
const rotation = new THREE.Quaternion();
