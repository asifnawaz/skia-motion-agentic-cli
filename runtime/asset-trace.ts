import { advance, compile, pose, settled, simulatedClock, start, writeProblem, type Literal, type MachineEvent, type StateEntry, type Write } from '../templates/motion/machine';
import { assetClips, assetMarkerEvents, assetTextNodes, parseAsset, type AssetMarkerEvent, type AssetNode, type AssetTextNode, type MotionAsset } from './asset';

import { assetPoints, hasAssetPoints, type ArtboardPoint, type AssetViewport } from './asset-attachments';

export { measureAttachments } from './asset-attachments';
export { assetInkBoxes, declaredText, INK_ALPHA, shownText } from './asset-bounds';
import { shownText } from './asset-bounds';
export { parseAsset };
export { assetClips, assetTextNodes, parseAssetFile, parseAssetSource, resolveAssetFonts, selectArtboard } from './asset';
export { hasFontHeader, MAX_ASSET_BYTES, MAX_ASSET_SOURCE_BYTES, usedAssetImages } from './asset';
export { encodeBinaryAsset, isBinaryAsset, mapFileResources } from './asset-binary';
export { imageFileSize } from './asset-image';
export { assetSVG } from './asset-svg';
export { rollFrame, rollTextStyle } from './asset-roll';
export { capShare, plateBox, rowLayout, textCase, textInk } from './asset-ink';
import { rollTextStyle } from './asset-roll';
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
  // A row's plate is sized from its widest sample, so each bound text in it is measured showing that sample too.
  const widest = function* (nodes: readonly AssetNode[], parent: string): Generator<{ node: AssetTextNode; where: string; text: string; t_ms: number }> {
    for (const [index, node] of nodes.entries()) {
      const where = `${parent}[${index}]`;
      if (node.kind === 'mesh') {
        for (const [name, pin] of Object.entries(node.pins ?? {})) if (pin.children) yield* widest(pin.children, `${where}.pins.${name}.children`);
        continue;
      }
      if (node.kind !== 'group') continue;
      const sample = node.row?.plate?.widest;
      if (sample) {
        for (const [i, child] of node.children.entries()) {
          if (child.kind === 'text' && typeof child.text !== 'string') yield { node: rollTextStyle(child), where: `${where}.children[${i}]`, text: sample, t_ms: chronological[0]!.t_ms };
        }
      }
      yield* widest(node.children, `${where}.children`);
    }
  };
  yield* widest(asset.artboard.nodes, 'artboard.nodes');
  for (const { node, where } of assetTextNodes(asset.artboard.nodes)) {
    if (typeof node.text === 'string') {
      if (node.text) yield { node, where, text: node.text, t_ms: chronological[0]!.t_ms };
      continue;
    }
    const seen = new Set<string>();
    for (const row of chronological) {
      // A rolling number is drawn with tabular figures, so it is measured with them; a row places it between its old and new values.
      const ends = node.roll ? [row.values[node.roll.from], row.values[node.text.value]] : [];
      for (const text of [shownText(node, row.values, asset, row.channels), ...ends]) {
        if (typeof text !== 'string' || !text || seen.has(text)) continue;
        seen.add(text);
        yield { node: rollTextStyle(node), where, text, t_ms: row.t_ms };
      }
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
