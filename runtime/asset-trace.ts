import { advance, compile, pose, settled, simulatedClock, start, writeProblem, type Literal, type MachineEvent, type StateEntry, type Write } from '../templates/motion/machine';
import { assetClips, assetMarkerEvents, assetTextNodes, parseAsset, type AssetMarkerEvent, type MotionAsset } from './asset';

import { assetPoints, hasAssetPoints, type ArtboardPoint, type AssetViewport } from './asset-attachments';

export { measureAttachments } from './asset-attachments';
export { parseAsset };
export { assetTextNodes, parseAssetFile, parseAssetSource, resolveAssetFonts, selectArtboard } from './asset';
export { hasFontHeader, MAX_ASSET_BYTES, MAX_ASSET_SOURCE_BYTES, usedAssetImages } from './asset';
export { encodeBinaryAsset, isBinaryAsset, mapFileResources } from './asset-binary';
export { imageFileSize } from './asset-image';
export { assetSVG } from './asset-svg';
export { validateMachine } from './machine-schema.js';

type TraceRow = {
  t_ms: number;
  states: Record<string, string>;
  values: Record<string, Literal>;
  channels: Record<string, number>;
  awake: string[];
  markers: AssetMarkerEvent[];
  points?: Record<string, ArtboardPoint>;
};

/** Paragraph width and font size are artboard units. One measurement covers repeated poses of the same label. */
export function* assetTextSamples(asset: MotionAsset, rows: readonly TraceRow[]) {
  const chronological = [...rows].sort((a, b) => a.t_ms - b.t_ms);
  for (const { node, where } of assetTextNodes(asset.artboard.nodes)) {
    if (typeof node.text === 'string') {
      if (node.text) yield { node, where, text: node.text, t_ms: chronological[0]!.t_ms };
      continue;
    }
    const seen = new Set<string>();
    for (const row of chronological) {
      const text = row.values[node.text.value];
      if (typeof text !== 'string' || !text || seen.has(text)) continue;
      seen.add(text);
      yield { node, where, text, t_ms: row.t_ms };
    }
  }
}

/** Identify authored mixes affected by the fallback to the underlying pose. */
export function sparseBlendWarnings(asset: MotionAsset) {
  const signature = (name: string) => Object.keys(asset.clips[name]?.tracks ?? {}).sort().join(',');
  const warnings: { code: string; where: string; error: string; hint: string }[] = [];
  const warn = (where: string) => warnings.push({
    code: 'sparse-blend', where,
    error: 'Mixes between different channel sets now interpolate against the underlying pose.',
    hint: 'Replay this blend or transition before updating the app. See skac asset guide migrate.',
  });
  for (const layer of asset.machine.layers) {
    const states = Object.entries(layer.states).map(([name, state]) => {
      const tracks = new Set(state?.blend?.keys.map(([, clip]) => signature(clip as string))
        ?? [signature(state?.clip ?? '')]);
      if (tracks.size > 1) warn(`machine.layers.${layer.name}.states.${name}.blend`);
      return { name, tracks };
    });
    for (const [index, transition] of (layer.transitions ?? []).entries()) {
      if (!transition.duration_ms || transition.to === 'exit') continue;
      const destination = states.find(({ name }) => name === transition.to);
      const sources = states.filter(({ name }) => transition.from === '*' ? name !== transition.to : name === transition.from);
      if (destination && sources.some(({ tracks }) =>
        tracks.size > 1 || destination.tracks.size > 1 || [...tracks].some((key) => !destination.tracks.has(key)),
      )) warn(`machine.layers.${layer.name}.transitions[${index}]`);
    }
  }
  return warnings;
}

export function traceAsset(asset: MotionAsset, times: number[], events: MachineEvent[], reduced: boolean, viewport?: AssetViewport) {
  const clips = assetClips(asset);
  const machine = compile(asset.machine, clips);
  const clock = simulatedClock(asset.machine);
  const writes: Write[] = events.map(({ at, name, to = true }) => {
    if (name === undefined) throw new Error('asset commands take host value writes and triggers');
    const problem = writeProblem(machine, name, to);
    if (problem) throw new Error(`${name}@${at}: ${problem}`);
    return { at: at * 1000, value: name, to };
  }).sort((a, b) => a.at - b.at);
  let state = start(machine);
  const samples = new Map<number, TraceRow>();
  const tracePoints = hasAssetPoints(asset.artboard.nodes);
  let index = 0;
  for (const ms of [...new Set(times)].sort((a, b) => a - b)) {
    const entries: StateEntry[] = [];
    const begin = index;
    while (index < writes.length && writes[index]!.at <= ms) index += 1;
    state = advance(machine, state, ms, writes.slice(begin, index), clock, entries);
    const states = Object.fromEntries(machine.layers.map((layer, i) => {
      const current = state.layers[i]!.s;
      return [layer.name, current >= 0 ? layer.states[current]!.name : 'exit'];
    }));
    const values = Object.fromEntries(machine.values.map((value, i): [string, Literal] => [value.name, state.vals[i]!]));
    const channels = pose(machine, clips, state, ms, clock, reduced, asset.channels).channels;
    const points = tracePoints ? assetPoints(asset, channels, viewport) : undefined;
    samples.set(ms, {
      t_ms: ms, states, values, channels,
      awake: settled(machine, state, clock, reduced).awake,
      markers: assetMarkerEvents(asset, entries),
      ...(points && { points }),
    });
  }
  return times.map((ms) => samples.get(ms)!);
}
