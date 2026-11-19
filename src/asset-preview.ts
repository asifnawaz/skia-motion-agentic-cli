import { assetClips, parseDrawableAsset, resolveAssetFonts } from '../runtime/asset';
import type { AssetResource } from '../runtime/asset-binary';
import { decodeBase64 } from '../runtime/base64';
import { assetSVG } from '../runtime/asset-svg';
import { advance, compile, pose, simulatedClock, start, writeProblem, type Literal, type Write } from '../templates/motion/machine';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const { source, size, reduced: initialReduced, artboard, binary, hostFonts } = JSON.parse(element('scene').textContent!) as {
  source: string;
  size: [number, number];
  reduced: boolean;
  artboard?: string;
  binary?: boolean;
  hostFonts?: Record<string, string>;
};
const asset = parseDrawableAsset(binary ? decodeBase64(source) : source, artboard);
const { fonts } = resolveAssetFonts(asset, hostFonts);
const resourceURLs = new Map<AssetResource, string>();
function resourceURL(resource: AssetResource): string {
  let url = resourceURLs.get(resource);
  if (url === undefined) {
    if (typeof resource === 'string') {
      const [header, encoded] = resource.split(',') as [string, string];
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      url = URL.createObjectURL(new Blob([bytes], { type: header.slice(5, -7) }));
    } else {
      url = URL.createObjectURL(new Blob([new Uint8Array(resource.bytes)], { type: resource.mime }));
    }
    resourceURLs.set(resource, url);
  }
  return url;
}
const images = Object.fromEntries(Object.entries(asset.images ?? {}).map(([name, uri]) => [name, resourceURL(uri)]));
const fontStyles = document.createElement('style');
fontStyles.textContent = Object.entries(fonts).map(([name, uri]) =>
  `@font-face{font-family:${name};src:url(${resourceURL(uri)})}`,
).join('');
document.head.append(fontStyles);
const drawing = { ...asset, images, fonts: undefined, fontLicenses: undefined, audio: undefined };
const clips = assetClips(asset);
const machine = compile(asset.machine, clips);
const clock = simulatedClock(asset.machine);
const stage = element('stage');
const play = element<HTMLButtonElement>('play');
const reset = element<HTMLButtonElement>('reset');
const seek = element<HTMLInputElement>('seek');
const timeDisplay = element<HTMLOutputElement>('time');
const width = element<HTMLInputElement>('width');
const height = element<HTMLInputElement>('height');
const reduced = element<HTMLInputElement>('reduced');
const dark = element<HTMLInputElement>('dark');
const inputPanel = element('inputs');
const stateLabel = element('states');

const initialEnd = Math.max(5000, ...Object.values(clips).map(({ ms }) => ms * 2));
seek.max = String(initialEnd);
width.value = String(size[0]);
height.value = String(size[1]);
reduced.checked = initialReduced || matchMedia('(prefers-reduced-motion: reduce)').matches;
document.title = `${asset.name} · Skac preview`;
element('name').textContent = asset.name;

let snapshot = start(machine);
let writes: Write[] = [];
let nextWrite = 0;
let time = 0;
let frameId: number | undefined;
let previousFrame: number | undefined;
let lastDrawing = '';
let lastState = '';

const valueControls = machine.values.map(({ name, type, bind, options }) => {
  if (type === 'trigger' && bind !== 'out') {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', () => write(name, true));
    inputPanel.append(button);
    return undefined;
  }

  const label = document.createElement('label');
  label.textContent = name;
  const valueInput = document.createElement(type === 'enum' ? 'select' : 'input');
  if (valueInput instanceof HTMLSelectElement) {
    for (const option of options) valueInput.add(new Option(option, option));
  } else {
    valueInput.type = type === 'number' ? 'number' : type === 'string' ? 'text' : 'checkbox';
    if (type === 'number') valueInput.step = 'any';
  }
  valueInput.disabled = bind === 'out';
  valueInput.addEventListener('change', () => {
    const value = valueInput instanceof HTMLSelectElement ? valueInput.value
      : type === 'number' ? valueInput.valueAsNumber : type === 'string' ? valueInput.value : valueInput.checked;
    write(name, value);
  });
  label.append(valueInput);
  inputPanel.append(label);
  return valueInput;
});
element('machine').hidden = !machine.values.length;

function render() {
  const viewport = {
    width: width.validity.valid && width.value ? width.valueAsNumber : size[0],
    height: height.validity.valid && height.value ? height.valueAsNumber : size[1],
  };
  const channels = pose(machine, clips, snapshot, time, clock, reduced.checked, asset.channels).channels;
  const values = Object.fromEntries(machine.values.map(({ name }, index) => [name, snapshot.vals[index]]));
  const drawingKey = JSON.stringify([viewport, channels, values]);
  if (drawingKey !== lastDrawing) {
    // The SVG is emitted by the validated asset renderer. Labels are added separately as text.
    stage.innerHTML = assetSVG(drawing, channels, viewport, values);
    lastDrawing = drawingKey;
  }
  const states = machine.layers.map(({ name, states }, index) => `${name} · ${states[snapshot.layers[index]!.s]?.name ?? 'exit'}`).join('    |    ');
  if (states !== lastState) {
    stateLabel.textContent = states;
    lastState = states;
  }
  for (const [index, control] of valueControls.entries()) {
    if (!control || control === document.activeElement) continue;
    const value = snapshot.vals[index];
    if (control instanceof HTMLInputElement && control.type === 'checkbox') control.checked = value === true;
    else if (control.value !== String(value)) control.value = String(value);
  }
  if (time > Number(seek.max)) seek.max = String(Math.ceil(time / 5000) * 5000);
  seek.value = String(Math.round(time));
  timeDisplay.value = `${(time / 1000).toFixed(2)} s`;
}

function sample(ms: number) {
  if (ms < time) {
    snapshot = start(machine);
    nextWrite = 0;
  }
  const from = nextWrite;
  while (nextWrite < writes.length && writes[nextWrite]!.at <= ms) nextWrite += 1;
  snapshot = advance(machine, snapshot, ms, writes.slice(from, nextWrite), clock);
  time = ms;
  render();
}

function write(name: string, to: Literal) {
  if (writeProblem(machine, name, to)) return;
  writes.length = nextWrite;
  // Each manual action is its own instant, including actions taken while paused.
  const at = time + 0.001;
  writes.push({ at, value: name, to });
  sample(at);
}

function frame(timestamp: number) {
  if (previousFrame !== undefined) sample(time + timestamp - previousFrame);
  previousFrame = timestamp;
  frameId = requestAnimationFrame(frame);
}

function pause() {
  if (frameId !== undefined) cancelAnimationFrame(frameId);
  frameId = previousFrame = undefined;
  play.textContent = 'Play';
}

play.addEventListener('click', () => {
  if (frameId !== undefined) pause();
  else {
    play.textContent = 'Pause';
    frameId = requestAnimationFrame(frame);
  }
});
reset.addEventListener('click', () => {
  snapshot = start(machine);
  writes = [];
  nextWrite = time = 0;
  previousFrame = undefined;
  seek.max = String(initialEnd);
  sample(0);
});
seek.addEventListener('input', () => {
  pause();
  sample(seek.valueAsNumber);
});
width.addEventListener('change', render);
height.addEventListener('change', render);
reduced.addEventListener('change', render);
dark.addEventListener('change', () => { stage.dataset.theme = dark.checked ? 'dark' : 'light'; });
document.addEventListener('visibilitychange', () => { previousFrame = undefined; });
sample(0);
