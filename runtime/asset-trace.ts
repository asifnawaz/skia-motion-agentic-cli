import { advance, compile, pose, settled, start, writeProblem, type Literal, type MachineEvent, type StateEntry, type Write } from '../templates/motion/machine';
import { assetClips, assetMarkerEvents, parseAsset, type AssetMarkerEvent, type MotionAsset } from './asset';

import { assetPoints, hasAssetPoints, type ArtboardPoint, type AssetViewport } from './asset-attachments';

export { measureAttachments } from './asset-attachments';
export { parseAsset };
export { MAX_ASSET_BYTES, usedAssetImages } from './asset';
export { imageFileSize } from './asset-image';
export { assetSVG } from './asset-svg';

const clock = (_name: string, ms: number) => ms;

type TraceRow = {
  t_ms: number;
  states: Record<string, string>;
  values: Record<string, Literal>;
  channels: Record<string, number>;
  awake: string[];
  markers: AssetMarkerEvent[];
  points?: Record<string, ArtboardPoint>;
};

export function traceAsset(asset: MotionAsset, times: number[], events: MachineEvent[], reduced: boolean, viewport?: AssetViewport) {
  const clips = assetClips(asset);
  const machine = compile(asset.machine, clips);
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
    const channels = { ...asset.channels, ...pose(machine, clips, state, ms, clock, reduced).channels };
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
