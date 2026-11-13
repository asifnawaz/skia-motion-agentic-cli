import { easeOut } from './lib/ease';

type Ev = { name: string; at: number };

export const meta = {
  fps: 30,
  frames: 30,
  width: 390,
  height: 867,
  scale: 1,
  events: [{ name: 'tap', at: 0.2 }],
};

export function rig(ms: number, events: Ev[] = []) {
  const tap = events.length ? events[0].at * 1000 : 200;
  const p = easeOut((ms - tap) / 300);
  return {
    channels: { wide: p },
    parts: { body: { x: 100 + 50 * p, y: 300, w: 80, h: 120 } },
  };
}
