// Dev page for tuning the headset's sounds (/sounds.html). Not part of the build.
import {
  CUE_NAMES, DEFAULT_TUNING, loadTuning, SAMPLE_URLS, Sound, TUNING_KEY,
  type CueSpec, type Layer, type SprayLoop, type Tuning,
} from './xr/audio';

let tuning: Tuning = loadTuning();
const sound = new Sound(tuning);
sound.auditioning = true;
const files = Object.keys(SAMPLE_URLS).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const WAVES: OscillatorType[] = ['sine', 'triangle', 'square', 'sawtooth'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function save() {
  try {
    localStorage.setItem(TUNING_KEY, JSON.stringify(tuning));
  } catch {
    // Not saved, but the page still plays what is on screen.
  }
  sound.retune(tuning);
}

function el(tag: string, props: Record<string, string | boolean> = {}, ...children: Array<Node | string>): HTMLElement {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const input = (props: Record<string, string>) => el('input', props) as HTMLInputElement;

function number(label: string, value: number, step: number, set: (v: number) => void) {
  const field = input({ type: 'number', value: String(value), step: String(step) });
  field.addEventListener('change', () => {
    const v = Number(field.value);
    if (Number.isFinite(v)) {
      set(v);
      save();
    }
  });
  return el('label', {}, label, field);
}

function select<T extends string>(options: readonly T[], value: T, set: (v: T) => void) {
  const node = el('select') as HTMLSelectElement;
  for (const option of options) node.append(el('option', { value: option, textContent: option, selected: option === value }));
  node.addEventListener('change', () => {
    set(node.value as T);
    save();
  });
  return node;
}

function layerRow(spec: CueSpec, layer: Layer, rerender: () => void) {
  const remove = el('button', { type: 'button', textContent: '✕', title: 'Remove layer' });
  remove.addEventListener('click', () => {
    spec.layers.splice(spec.layers.indexOf(layer), 1);
    save();
    rerender();
  });
  const delay = number('delay s', layer.delay ?? 0, 0.005, (v) => (layer.delay = v));
  if (layer.type === 'sample') {
    return el('div', { className: 'layer' }, 'sample',
      select(files, layer.file, (v) => (layer.file = v)),
      number('rate', layer.rate, 0.05, (v) => (layer.rate = v)),
      number('gain', layer.gain, 0.05, (v) => (layer.gain = v)),
      delay, remove);
  }
  const shared = [
    number('from Hz', layer.from, 10, (v) => (layer.from = v)),
    number('to Hz', layer.to, 10, (v) => (layer.to = v)),
    number('attack s', layer.attack, 0.001, (v) => (layer.attack = v)),
    number('decay s', layer.decay, 0.005, (v) => (layer.decay = v)),
    number('gain', layer.gain, 0.01, (v) => (layer.gain = v)),
  ];
  if (layer.type === 'tone') {
    return el('div', { className: 'layer' }, 'tone', select(WAVES, layer.wave, (v) => (layer.wave = v)), ...shared, delay, remove);
  }
  return el('div', { className: 'layer' }, 'noise', ...shared, number('Q', layer.q, 0.1, (v) => (layer.q = v)), delay, remove);
}

function renderCues() {
  $('cues').replaceChildren(...CUE_NAMES.map(renderCue));
}

function renderCue(name: (typeof CUE_NAMES)[number]): HTMLElement {
  const spec = tuning.cues[name];
  const box = el('div', { className: 'cue' });
  const rerender = () => box.replaceWith(renderCue(name));
  box.append(cueHead(name, spec, rerender), ...spec.layers.map((layer) => layerRow(spec, layer, rerender)));
  return box;
}

function cueHead(name: string, spec: CueSpec, rerender: () => void) {
  const play = el('button', { type: 'button', textContent: '▶ Play', className: 'play' });
  play.addEventListener('click', () => void sound.audition(spec));
  const add = (layer: Layer) => () => {
    spec.layers.push(layer);
    save();
    rerender();
  };
  const addTone = el('button', { type: 'button', textContent: '+ tone' });
  addTone.addEventListener('click', add({ type: 'tone', wave: 'sine', from: 660, to: 660, attack: 0.005, decay: 0.08, gain: 0.1 }));
  const addNoise = el('button', { type: 'button', textContent: '+ noise' });
  addNoise.addEventListener('click', add({ type: 'noise', from: 2000, to: 800, q: 1, attack: 0.005, decay: 0.1, gain: 0.2 }));
  const addSample = el('button', { type: 'button', textContent: '+ sample' });
  addSample.addEventListener('click', add({ type: 'sample', file: files[0], rate: 1, gain: 0.5 }));
  return el('div', { className: 'cue-head' }, el('strong', { textContent: name }), play,
    number('jitter', spec.jitter, 0.01, (v) => (spec.jitter = v)), addTone, addNoise, addSample);
}

function renderLoops() {
  const root = $('loops');
  root.replaceChildren();
  const { spray, hold } = tuning.loops;

  let loop: SprayLoop | null = null;
  const level = input({ type: 'range', min: '0', max: '1', step: '0.01', value: '1' });
  const toggle = el('button', { type: 'button', textContent: '▶ Spray', className: 'play' });
  toggle.addEventListener('click', () => {
    if (loop) {
      loop.stop();
      loop = null;
      toggle.textContent = '▶ Spray';
      return;
    }
    sound.unlock();
    loop = sound.sprayLoop();
    loop?.set(Number(level.value));
    toggle.textContent = '■ Stop';
  });
  level.addEventListener('input', () => loop?.set(Number(level.value)));
  root.append(el('div', { className: 'cue' },
    el('div', { className: 'cue-head' }, el('strong', { textContent: 'spray' }), toggle, el('label', {}, 'trigger ', level)),
    el('div', { className: 'layer' },
      number('low Hz', spray.low, 50, (v) => (spray.low = v)),
      number('high Hz', spray.high, 50, (v) => (spray.high = v)),
      number('Q', spray.q, 0.1, (v) => (spray.q = v)),
      number('gain', spray.gain, 0.01, (v) => (spray.gain = v)))));

  const progress = input({ type: 'range', min: '0', max: '1', step: '0.01', value: '0' });
  progress.addEventListener('input', () => {
    sound.unlock();
    sound.hold(Number(progress.value));
  });
  root.append(el('div', { className: 'cue' },
    el('div', { className: 'cue-head' }, el('strong', { textContent: 'hold' }), el('label', {}, 'progress ', progress)),
    el('div', { className: 'layer' },
      select(WAVES, hold.wave, (v) => (hold.wave = v)),
      number('from Hz', hold.from, 10, (v) => (hold.from = v)),
      number('to Hz', hold.to, 10, (v) => (hold.to = v)),
      number('gain', hold.gain, 0.01, (v) => (hold.gain = v)))));
}

function renderKenney() {
  const root = $('kenney');
  root.replaceChildren(...files.map((file) => {
    const button = el('button', { type: 'button', textContent: `▶ ${file.replace('.ogg', '')}` });
    button.addEventListener('click', () => void sound.audition({ layers: [{ type: 'sample', file, rate: 1, gain: 0.6 }], jitter: 0 }));
    return button;
  }));
}

function render() {
  const master = $<HTMLInputElement>('master');
  master.value = String(tuning.master);
  master.oninput = () => {
    tuning.master = Number(master.value);
    save();
  };
  renderCues();
  renderLoops();
  renderKenney();
}

$('copy').addEventListener('click', async () => {
  const text = JSON.stringify(tuning, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $('note').textContent = 'Copied.';
  } catch {
    console.log(text);
    $('note').textContent = 'Clipboard blocked: tuning printed to the console.';
  }
});

$('reset').addEventListener('click', () => {
  tuning = structuredClone(DEFAULT_TUNING);
  sound.tuning = tuning;
  save();
  render();
});

document.addEventListener('pointerdown', () => sound.unlock(), { once: true, capture: true });
render();
