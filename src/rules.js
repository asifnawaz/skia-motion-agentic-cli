// Rig rules: one entry in RULES, one pure check(samples, meta) -> findings. Units: parts in pt, time in ms.
// A finding: { ruleId, severity, message, fix, docs, at_s, channel?, part?, value?, limit? }.
// Samples come on one fixed grid (rig.js GRID_HZ, 120 Hz) whatever the composition's fps, so every limit here is
// in ms or per-ms terms and the verdict is the same at 30, 60 and 120 fps. Per-sample limits are derived from
// these rates and the grid step, never written per frame.

import { CONTACT_RULES } from './contact-rules.js';
import { argMax, centreAt, mk, r3, runs, secs } from './rule-kit.js';

/** One frame of a 30 fps reel: the span the per-frame limits below were first calibrated on. */
export const FRAME_MS = 1000 / 30;
export const SPEED_CAP = 0.54; // pt/ms: the fastest legal hop (4 x 78 pt / 580 ms); applies to root parts, and to a child relative to its parent
export const SPEED_WINDOW_MS = FRAME_MS; // speed-cap reads the mean speed over this window ending at each sample
export const ACTIVITY_WINDOW_MS = 3 * FRAME_MS; // a speed peak is the fastest sample within +-100 ms
export const ACTIVITY_CHANNEL_RATE = 0.0075 / FRAME_MS; // share of a channel's range per ms that counts as a peak
export const ACTIVITY_PART_SPEED = 0.15 / FRAME_MS; // pt/ms (0.0045) that counts as a part's peak
export const STILL_CHANNEL_RATE = 0.001 / FRAME_MS; // share of a channel's range per ms below which it is still
export const STILL_PART_RATE = 0.05 / FRAME_MS; // pt (or degrees) per ms below which a part field is still
export const STORY_CHANNEL_RATE = 0.005 / FRAME_MS; // share of a channel's range per ms that --story calls moving
export const FACE_MIN_MS = 100; // a face channel may not cross 90% of its range faster
export const FACE_SHARE = 0.9;
export const OVERSHOOT_SHARE = 0.05; // of the channel's range
export const EDGE_SHARE = 0.04; // of the frame's width and height
export const IDLE_GAP_MS = 2000;
export const DEAD_HOLD_MS = 500;
export const BEAT_SHARE = 0.05; // a beat's channel must change by this share of its whole range
export const BEAT_PART_PT = 0.5; // or a beat's part must travel this far
export const FADE_MAX_MS = 250; // a fade from clear to solid (or back) may take no longer (motion standard: at most 0.25 s)
export const FADE_EDGE = 0.05; // clear is an opacity at or below this, solid at or above 1 minus this
export const CROSS_MS = 150; // two opacity channels crossing 0.5 in opposite directions this close are one swap (a boundary)
// A boundary is carried when a part on both sides moves or scales across it: word-quran-reels core/render/carry.mjs
// lines 62-68 (onetake's continuity(), ported with the author's permission, O-2013), in the same 0.4 s window.
export const CARRY_WINDOW_MS = 400; // carry.mjs dt = 0.4 s: the two states compared across a boundary
export const CARRY_MOVE_SHARE = 0.02; // a survivor's centre travels this share of the frame's diagonal (carry.mjs line 68)
export const CARRY_SCALE_LOG = 0.1; // or its size changes by this much as |log| of sqrt(area) (carry.mjs line 66-68), about 10%
// meta.kind: 'character' (the default; every rule as before) or 'interface' (owner O-5619 to O-5621, 13 Nov 2026:
// continuity in change, stillness at rest). Rules with `kinds` run only for those kinds.
export const KINDS = ['character', 'interface'];
// An interface hand-over carries far: a 390 pt (a phone's width) carry in MOVE.handover (560 ms) on inOut cubic, the
// Welcome seal's curve, peaks at 3 x 390 / 560 = 2.09 pt/ms. The Welcome carry itself (about 183 pt in 600 ms) peaks at 0.92.
export const INTERFACE_SPEED_CAP = 2.1;
// A stall inside one interface change: beats of one change that leave everything they move still this long read as two changes.
export const INTERFACE_STALL_MS = 250;
// skac/abrupt is the KINK half of word-quran-reels core/render/pathcheck.mjs (owner O-2166, 20 Oct 2026) on the rig's parts: each
// part's centre (in its parent's frame, as speed-cap) sampled at 30 fps. pathcheck's JUMP (a move over a limit in one frame) is
// not ported: with the limit at the scene's speed cap x one frame it is speed-cap measured again, so the two always fired together
// (the good Combo scene at 4.733 s, 13 Nov), and a lower flat limit (pathcheck's 36 px, 16.3 pt here) fails Welcome's own carry.
// skac/speed-cap is the jump check. A KINK is a change of speed over 12 px per frame on a 1080 x 1920 frame, so it scales with the
// frame's long side.
export const PATH_FRAME_MS = 1000 / 30; // pathcheck samples at 30 fps
export const PATH_KINK_SHARE = 12 / 1920; // pathcheck --kink 12 at a 1920 px long side
// pathcheck's header calls a KINK "a change of speed far above that quantity's own usual"; its code tests the 12 px alone, which
// fails an S-curve carry of 150 pt or more on a phone (the Welcome carry: 6.8 pt against 5.4). The kink must also be over half the
// faster of the two speeds around it, which a start or stop from rest (a linear segment) always is and an eased curve never is.
export const KINK_SPEED_SHARE = 0.5;

const dtOf = (s) => 1000 / s.fps;
/** The scene's kind: 'interface' when meta.kind says so, else 'character'. */
export const kindOf = (meta) => (meta && meta.kind === 'interface' ? 'interface' : 'character');
const capOf = (meta) => (kindOf(meta) === 'interface' ? INTERFACE_SPEED_CAP : SPEED_CAP);
const rangeOf = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);


/** A part's position is its box centre: a squash about the feet moves the top edge, not the part. */
const centreOf = (p) => {
  const c = p.x.map((_, i) => centreAt(p, i));
  return { x: c.map((v) => v[0]), y: c.map((v) => v[1]) };
};

/** Displacement in pt from the previous frame; index 0 is 0. */
const stepsOf = (p) => p.x.map((x, i) => (i === 0 ? 0 : Math.hypot(x - p.x[i - 1], p.y[i] - p.y[i - 1])));

const partSteps = (s) => Object.entries(s.parts || {}).map(([name, p]) => [name, stepsOf(centreOf(p))]);

/**
 * Per-sample displacement of each part in its parent's frame (meta.parents: child -> parent), else in the world.
 * A wing carried by the hop moves with the body; its own swing is the wing minus the body (translation only:
 * a parent's rotation is already in the child's box position). A parent that is not a part is returned in `unknown`.
 */
const relativeSteps = (s, meta) => {
  const parents = (meta && meta.parents) || {};
  const unknown = [];
  const out = Object.entries(s.parts || {}).map(([name, p]) => {
    const parentName = parents[name];
    const q = parentName && s.parts[parentName];
    if (parentName && !q) unknown.push([name, parentName]);
    const c = centreOf(p);
    if (!q) return [name, stepsOf(c), null];
    const qc = centreOf(q);
    const rel = { x: c.x.map((x, i) => x - qc.x[i]), y: c.y.map((y, i) => y - qc.y[i]) };
    return [name, stepsOf(rel), parentName];
  });
  return { steps: out, unknown };
};

const frameOf = (parent) => (parent ? ` relative to \`${parent}\`` : '');

/** Change of a beat's channel (or part) across its window, and whether it counts as moving. */
export const beatChange = (s, beat) => {
  const dt = dtOf(s);
  const from = Math.max(0, Math.floor(beat.from_ms / dt));
  const to = Math.min(s.t_ms.length - 1, Math.ceil(beat.to_ms / dt));
  if (s.channels[beat.channel]) {
    const all = s.channels[beat.channel];
    const win = all.slice(from, to + 1);
    const change = rangeOf(win);
    const total = rangeOf(all);
    return { kind: 'channel', from: win[0], to: win[win.length - 1], min: Math.min(...win), max: Math.max(...win), change,
      moved: change > 1e-6 && change >= BEAT_SHARE * total };
  }
  const p = s.parts && s.parts[beat.channel];
  if (p) {
    let travel = 0;
    for (let i = from + 1; i <= to; i++) travel += Math.hypot(p.x[i] - p.x[i - 1], p.y[i] - p.y[i - 1]);
    return { kind: 'part', change: travel, moved: travel >= BEAT_PART_PT };
  }
  return null;
};


/**
 * Each part's speed in pt/ms: the mean over the SPEED_WINDOW_MS (one 30 fps frame) ending at each sample, the span the
 * speed cap was calibrated on (18 pt a frame); a per-sample speed would read a step in the rig 4x larger on the 120 Hz
 * grid. In the parent's frame where meta.parents says so. --stats reads this too, so it never disagrees with speed-cap.
 * @returns {{speeds: [string, number[], string|null][], unknown: [string, string][]}}
 */
export const partSpeeds = (s, meta) => {
  const dt = dtOf(s);
  const { steps, unknown } = relativeSteps(s, meta);
  const w = Math.max(1, Math.round(SPEED_WINDOW_MS / dt));
  const speeds = steps.map(([name, d, parent]) => [name, d.map((_, i) => (i < w ? 0 : meanSpeed(d, i, w, dt))), parent]);
  return { speeds, unknown };
};

const speedCap = {
  id: 'skac/speed-cap',
  category: 'speed',
  layer: 'rig',
  default: 'warn',
  docs: 'motion/anticipation',
  needs: ['parts'],
  check(s, meta) {
    const { speeds, unknown } = partSpeeds(s, meta);
    const out = unknown.map(([name, parent]) => mk(this, {
      message: `meta.parents gives \`${name}\` the parent \`${parent}\`, which the rig does not return as a part`,
      fix: 'name a part the rig returns, or drop the entry so the part is measured in the world',
      at_s: 0, part: name,
    }));
    const cap = capOf(meta);
    for (const [name, speed, parent] of speeds) {
      for (const [a, b] of runs(speed.map((v) => v > cap))) {
        const k = argMax(speed, a, b);
        out.push(mk(this, {
          message: `part \`${name}\` moves at ${r3(speed[k])} pt/ms${frameOf(parent)} at ${secs(s.t_ms[k])} s (cap ${cap} for a ${kindOf(meta)})`,
          fix: `lengthen the move by x${r3(speed[k] / cap)} or shorten the distance; a burst needs a wind-up first` +
            (parent ? '' : '; a part carried by another (a wing on a hopping body) belongs in meta.parents'),
          at_s: secs(s.t_ms[k]), part: name, value: r3(speed[k]), limit: cap,
        }));
      }
    }
    return out;
  },
};

/** Mean speed (pt/ms) over the `w` steps ending at index `end` (inclusive). */
const meanSpeed = (d, end, w, dt) => {
  let sum = 0;
  for (let j = end - w + 1; j <= end; j++) sum += d[j];
  return sum / (w * dt);
};

const minChange = {
  id: 'skac/min-change',
  category: 'face',
  layer: 'rig',
  default: 'error', // calibrated: its mutation in skac-e2e/src/mutations fails it, the base combo passes (13 Nov)
  docs: 'motion/faces',
  needs: ['face'],
  check(s, meta) {
    const dt = dtOf(s);
    const out = [];
    for (const ch of meta.face) {
      const v = s.channels[ch];
      if (!v) continue;
      const range = rangeOf(v);
      if (range < 1e-9) continue;
      // Judge each whole monotonic move (from leaving its start value to reaching its end value), not the
      // span between two 90% points: an eased move spends most of its time near its ends, and that time counts.
      const eps = 1e-9 * range;
      const dir = (k) => { const d = v[k + 1] - v[k]; return Math.abs(d) <= eps ? 0 : Math.sign(d); };
      let i = 0;
      while (i < v.length - 1) {
        const sign = dir(i);
        if (sign === 0) { i++; continue; }
        let j = i + 1;
        while (j < v.length - 1 && dir(j) === sign) j++;
        const net = Math.abs(v[j] - v[i]);
        const ms = (j - i) * dt;
        if (net >= FACE_SHARE * range && ms < FACE_MIN_MS) {
          out.push(mk(this, {
            message: `face channel \`${ch}\` moves ${Math.round((net / range) * 100)}% of its range in ${r3(ms)} ms at ${secs(s.t_ms[i])} s (min ${FACE_MIN_MS} ms)`,
            fix: `spread the move over at least ${FACE_MIN_MS} ms; a face that snaps reads as a swap`,
            at_s: secs(s.t_ms[i]), channel: ch, value: r3(ms), limit: FACE_MIN_MS,
          }));
        }
        i = j;
      }
    }
    return out;
  },
};

const overshoot = {
  id: 'skac/overshoot',
  category: 'timing',
  layer: 'rig',
  default: 'error', // calibrated: its mutation in skac-e2e/src/mutations fails it, the base combo passes (13 Nov)
  docs: 'motion/body',
  needs: ['settle'],
  check(s, meta) {
    const out = [];
    for (const [ch, rest] of Object.entries(meta.settle)) {
      const v = s.channels[ch];
      if (!v) continue;
      const range = rangeOf(v);
      if (range < 1e-9) continue;
      const side = (x) => (Math.abs(x - rest) < 1e-9 ? 0 : Math.sign(x - rest));
      let cur = 0;
      let exc = null; // an excursion that began with a crossing of the settle value
      const done = [];
      v.forEach((x, i) => {
        const sg = side(x);
        if (sg === 0) return;
        if (cur !== 0 && sg !== cur) {
          if (exc) done.push(exc);
          exc = { depth: 0, at: i };
        }
        cur = sg;
        if (exc && Math.abs(x - rest) > exc.depth) exc = { depth: Math.abs(x - rest), at: i };
      });
      if (exc) done.push(exc);
      for (const e of done) {
        const share = e.depth / range;
        if (share <= OVERSHOOT_SHARE) continue;
        out.push(mk(this, {
          message: `channel \`${ch}\` passes its settle value ${rest} by ${r3(e.depth)} (${r3(share * 100)}% of its range) at ${secs(s.t_ms[e.at])} s (limit ${OVERSHOOT_SHARE * 100}%)`,
          fix: `end the move on ${rest} (flow never overshoots a key), or keep one rebound under ${OVERSHOOT_SHARE * 100}% of the range`,
          at_s: secs(s.t_ms[e.at]), channel: ch, value: r3(share), limit: OVERSHOOT_SHARE,
        }));
      }
    }
    return out;
  },
};

const inFrame = {
  id: 'skac/in-frame',
  category: 'framing',
  layer: 'rig',
  default: 'warn',
  docs: 'motion/checks',
  needs: ['parts', 'width', 'height', 'scale'],
  check(s, meta) {
    const W = meta.width / meta.scale;
    const H = meta.height / meta.scale;
    const mx = EDGE_SHARE * W;
    const my = EDGE_SHARE * H;
    const out = [];
    for (const [name, p] of Object.entries(s.parts)) {
      let worst = null;
      s.t_ms.forEach((t, i) => {
        const w = p.w ? p.w[i] : 0;
        const h = p.h ? p.h[i] : 0;
        const depth = Math.max(mx - p.x[i], my - p.y[i], p.x[i] + w - (W - mx), p.y[i] + h - (H - my));
        if (depth > 0 && (!worst || depth > worst.depth)) worst = { depth, i };
      });
      if (!worst) continue;
      out.push(mk(this, {
        message: `part \`${name}\` reaches ${r3(worst.depth)} pt past the ${r3(mx)} x ${r3(my)} pt safe margin of the ${r3(W)} x ${r3(H)} pt frame at ${secs(s.t_ms[worst.i])} s`,
        fix: 'move the part inward, shrink it, or crop it deliberately (then turn this rule off for the project)',
        at_s: secs(s.t_ms[worst.i]), part: name, value: r3(worst.depth), limit: r3(Math.min(mx, my)),
      }));
    }
    return out;
  },
};

/** Sample indices where a channel or part has a speed peak: the fastest within +-ACTIVITY_WINDOW_MS, above a floor. */
const activityFrames = (s, upto) => {
  const dt = dtOf(s);
  const reach = Math.round(ACTIVITY_WINDOW_MS / dt);
  const found = new Set();
  const scan = (steps, floor) => {
    for (let i = 1; i < steps.length && i < upto; i++) {
      if (steps[i] < floor) continue;
      let top = true;
      for (let j = Math.max(1, i - reach); j <= Math.min(steps.length - 1, i + reach); j++) if (steps[j] > steps[i]) top = false;
      if (top) found.add(i);
    }
  };
  for (const v of Object.values(s.channels)) {
    const range = rangeOf(v);
    if (range < 1e-9) continue;
    scan(v.map((x, i) => (i === 0 ? 0 : Math.abs(x - v[i - 1]))), ACTIVITY_CHANNEL_RATE * range * dt);
  }
  for (const [, steps] of partSteps(s)) scan(steps, ACTIVITY_PART_SPEED * dt);
  return [...found].sort((a, b) => a - b);
};

const idleCadence = {
  id: 'skac/idle-cadence',
  category: 'timing',
  layer: 'rig',
  default: 'warn',
  docs: 'motion/idle',
  needs: ['events'],
  kinds: ['character'], // an interface at rest holds still (owner O-5619 to O-5621)
  check(s, meta) {
    if (!meta.events.length) return [];
    const dt = dtOf(s);
    const first = Math.min(...meta.events.map((e) => e.at)) * 1000;
    const peaks = activityFrames(s, Math.floor(first / dt)).map((i) => i * dt);
    const out = [];
    let prev = 0;
    for (const t of [...peaks, first]) {
      if (t - prev > IDLE_GAP_MS) {
        out.push(mk(this, {
          message: `no idle event between ${secs(prev)} s and ${secs(t)} s (${r3(t - prev)} ms, limit ${IDLE_GAP_MS})`,
          fix: 'add an idle event (a glance with a weight shift, a blink, an ear flick) every 1.2-2 s before the first input',
          at_s: secs(prev), value: r3(t - prev), limit: IDLE_GAP_MS,
        }));
      }
      prev = t;
    }
    return out;
  },
};

/** Per sample: true when none of `chans` (series) and `parts` (part objects) moves from the sample before. */
const stillMask = (s, chans, parts) => {
  const dt = dtOf(s);
  const n = s.t_ms.length;
  const still = Array.from({ length: n }, () => true);
  for (const v of chans) {
    const eps = STILL_CHANNEL_RATE * rangeOf(v) * dt;
    for (let i = 1; i < n; i++) if (Math.abs(v[i] - v[i - 1]) > eps) still[i] = false;
  }
  const partEps = STILL_PART_RATE * dt;
  for (const p of parts) {
    for (const f of Object.keys(p)) for (let i = 1; i < n; i++) if (Math.abs(p[f][i] - p[f][i - 1]) > partEps) still[i] = false;
  }
  return still;
};

/**
 * dead-hold for an interface: rest is not flagged, a stall inside one change is. A change is the beats that share a
 * `change` name (a beat with none is a change of its own); its active window runs from its first beat's from_ms to its
 * last beat's to_ms, and only the channels and parts its beats name count. A still run over INTERFACE_STALL_MS warns.
 */
const interfaceStalls = (rule, s, meta) => {
  const dt = dtOf(s);
  const groups = new Map();
  (meta.beats || []).forEach((b, k) => {
    const key = b.change ?? `#${k}`;
    groups.set(key, [...(groups.get(key) || []), b]);
  });
  const out = [];
  for (const [key, beats] of groups) {
    const chans = beats.map((b) => s.channels[b.channel]).filter(Boolean);
    const parts = beats.map((b) => s.parts && s.parts[b.channel]).filter(Boolean);
    if (!chans.length && !parts.length) continue;
    const from = Math.max(1, Math.ceil(Math.min(...beats.map((b) => b.from_ms)) / dt));
    const to = Math.min(s.t_ms.length - 1, Math.floor(Math.max(...beats.map((b) => b.to_ms)) / dt));
    const still = stillMask(s, chans, parts).map((f, i) => f && i >= from && i <= to);
    const name = key.startsWith('#') ? `beat \`${beats[0].name}\`` : `change \`${key}\``;
    for (const [a, b] of runs(still)) {
      const ms = (b - a + 1) * dt;
      if (ms <= INTERFACE_STALL_MS) continue;
      out.push(mk(rule, {
        message: `${name} stalls: what its beats move is still for ${r3(ms)} ms from ${secs((a - 1) * dt)} s (limit ${INTERFACE_STALL_MS})`,
        fix: 'the change stalls; start the next beat before this one settles (beats overlap), or end the beat window where its motion ends',
        at_s: secs((a - 1) * dt), value: r3(ms), limit: INTERFACE_STALL_MS,
      }));
    }
  }
  return out;
};

const deadHold = {
  id: 'skac/dead-hold',
  category: 'timing',
  layer: 'rig',
  default: 'warn',
  docs: 'motion/body',
  needs: [],
  check(s, meta) {
    if (kindOf(meta) === 'interface') return interfaceStalls(this, s, meta);
    const dt = dtOf(s);
    const chans = Object.values(s.channels);
    const parts = Object.values(s.parts || {});
    if (!chans.length && !parts.length) return [];
    const still = stillMask(s, chans, parts);
    const out = [];
    for (const [a, b] of runs(still.map((f, i) => f && i > 0))) {
      const ms = (b - a + 1) * dt;
      if (ms <= DEAD_HOLD_MS) continue;
      out.push(mk(this, {
        message: `everything is still for ${r3(ms)} ms from ${secs((a - 1) * dt)} s (limit ${DEAD_HOLD_MS})`,
        fix: 'give every held pose a moving layer: a slow breath, a sway, a trailing part (the character rule; an interface at rest holds still: declare meta.kind \'interface\')',
        at_s: secs((a - 1) * dt), value: r3(ms), limit: DEAD_HOLD_MS,
      }));
    }
    return out;
  },
};

const loopSeam = {
  id: 'skac/loop-seam',
  category: 'timing',
  layer: 'rig',
  default: 'warn',
  docs: 'motion/principles',
  needs: ['loop'],
  check(s, meta) {
    if (!meta.loop) return [];
    const out = [];
    // The step from the last frame back to the first must not be bigger than any step inside the clip.
    const test = (label, key, arr, unit) => {
      let max = 0;
      for (let i = 1; i < arr.length; i++) max = Math.max(max, Math.abs(arr[i] - arr[i - 1]));
      const seam = Math.abs(arr[0] - arr[arr.length - 1]);
      if (seam <= max + 1e-6) return;
      out.push(mk(this, {
        message: `${label} jumps ${r3(seam)}${unit} at the loop seam; its largest step inside the clip is ${r3(max)}${unit}`,
        fix: 'end the loop on the frame that leads into frame 0 (periods that divide the loop length)',
        at_s: secs(s.t_ms[s.t_ms.length - 1]), [key]: label.split('`')[1], value: r3(seam), limit: r3(max),
      }));
    };
    for (const [n, v] of Object.entries(s.channels)) test(`channel \`${n}\``, 'channel', v, '');
    for (const [n, p] of Object.entries(s.parts || {})) {
      for (const f of Object.keys(p)) test(`part \`${n}\`.${f}`, 'part', p[f], ' pt');
    }
    return out;
  },
};

const determinism = {
  id: 'skac/determinism',
  category: 'determinism',
  layer: 'rig',
  default: 'warn',
  docs: 'motion/remotion-and-app',
  needs: [],
  check(s) {
    if (!s.recheck) return [];
    const out = [];
    const cmp = (label, key, a, b) => {
      const i = a.findIndex((x, k) => !Object.is(x, b[k]));
      if (i < 0) return;
      out.push(mk(this, {
        message: `${label} differs between two samplings of ${secs(s.t_ms[i])} s (${a[i]} vs ${b[i]})`,
        fix: 'make the rig a pure function of ms: no Date.now, Math.random (use seeded(i)) or state kept between calls',
        at_s: secs(s.t_ms[i]), [key]: label.split('`')[1], value: r3(Math.abs(a[i] - b[i])), limit: 0,
      }));
    };
    for (const [n, v] of Object.entries(s.channels)) cmp(`channel \`${n}\``, 'channel', v, s.recheck.channels[n] || []);
    for (const [n, p] of Object.entries(s.parts || {})) {
      for (const f of Object.keys(p)) cmp(`part \`${n}\`.${f}`, 'part', p[f], (s.recheck.parts[n] || {})[f] || []);
    }
    return out;
  },
};

const beatMoves = {
  id: 'skac/beat-moves',
  category: 'request',
  layer: 'rig',
  default: 'error', // calibrated: its mutation in skac-e2e/src/mutations fails it, the base combo passes (13 Nov)
  docs: 'motion/checks',
  needs: ['beats'],
  check(s, meta) {
    const out = [];
    for (const b of meta.beats) {
      const c = beatChange(s, b);
      const where = `${secs(b.from_ms)}-${secs(b.to_ms)} s`;
      if (!c) {
        out.push(mk(this, {
          message: `beat \`${b.name}\` names \`${b.channel}\`, which the rig does not return`,
          fix: 'name a channel or part the rig returns, or fix the spelling',
          at_s: secs(b.from_ms), channel: b.channel,
        }));
      } else if (!c.moved) {
        out.push(mk(this, {
          message: `beat \`${b.name}\`: \`${b.channel}\` does not move in ${where} (changes ${r3(c.change)})`,
          fix: 'move that channel inside the beat window, or correct the beat times in meta.beats',
          at_s: secs(b.from_ms), channel: b.channel, value: r3(c.change),
          limit: c.kind === 'part' ? BEAT_PART_PT : BEAT_SHARE,
        }));
      }
    }
    return out;
  },
};

/** `meta.opacity` as [channel, carry names][] for the channels the rig returns; a carry name is a channel or a part, one name or a list. */
const opacityChannels = (s, meta) => Object.entries(meta.opacity || {})
  .filter(([ch]) => s.channels[ch])
  .map(([ch, carry]) => [ch, (Array.isArray(carry) ? carry : [carry]).filter((c) => typeof c === 'string' && (s.channels[c] || (s.parts && s.parts[c])))]);

// An opacity channel in meta.opacity goes from clear to solid (or back) in one run longer than 250 ms.
const longFade = {
  id: 'skac/long-fade',
  category: 'timing',
  layer: 'rig',
  default: 'warn', // calibrated: its mutation in skac-e2e/src/mutations fails it (13 Nov); the interface sample passes
  docs: 'motion/interface',
  needs: ['opacity'],
  check(s, meta) {
    const dt = dtOf(s);
    const out = [];
    for (const [ch] of opacityChannels(s, meta)) {
      const v = s.channels[ch];
      const eps = 1e-9;
      const dir = (k) => { const d = v[k + 1] - v[k]; return Math.abs(d) <= eps ? 0 : Math.sign(d); };
      let i = 0;
      while (i < v.length - 1) {
        const sign = dir(i);
        if (sign === 0) { i++; continue; }
        let last = i + 1; // the last sample the run reaches; a flat step inside the run does not end it
        for (let k = i + 1; k < v.length - 1; k++) {
          const d = dir(k);
          if (d === -sign) break;
          if (d === sign) last = k + 1;
        }
        const lo = sign > 0 ? v[i] : v[last];
        const hi = sign > 0 ? v[last] : v[i];
        const ms = (last - i) * dt;
        if (lo <= FADE_EDGE && hi >= 1 - FADE_EDGE && ms > FADE_MAX_MS + 2 * dt) {
          out.push(mk(this, {
            message: `opacity channel \`${ch}\` goes ${r3(v[i])} to ${r3(v[last])} in one run of ${r3(ms)} ms at ${secs(s.t_ms[i])} s (limit ${FADE_MAX_MS} ms)`,
            fix: `finish the opacity within ${FADE_MAX_MS} ms and let scale or travel carry the rest of the move (enter/exit in motion/moves.ts); a slow fade is a slideshow dissolve`,
            at_s: secs(s.t_ms[i]), channel: ch, value: r3(ms), limit: FADE_MAX_MS,
          }));
        }
        i = last;
      }
    }
    return out;
  },
};

/** Sample indices where `v` falls through, or rises through, 0.5. */
const crossings = (v, falling) => {
  const out = [];
  for (let k = 0; k < v.length - 1; k++) {
    if (falling ? v[k] >= 0.5 && v[k + 1] < 0.5 : v[k] < 0.5 && v[k + 1] >= 0.5) out.push(k);
  }
  return out;
};

/** A part's centre and its size (sqrt of area) at sample i. */
const partAt = (p, i) => {
  const [x, y] = centreAt(p, i);
  return { x, y, size: Math.sqrt(Math.max((p.w ? p.w[i] : 0) * (p.h ? p.h[i] : 0), 1)) };
};

// carry.mjs's carried test (word-quran-reels, after onetake): at a boundary (one opacity channel falls and another rises
// through 0.5 within CROSS_MS) a rig part must move CARRY_MOVE_SHARE of the frame's diagonal or scale CARRY_SCALE_LOG across
// CARRY_WINDOW_MS; the fading elements never carry, since they are not on both sides.
// A swap of two opacity channels where no part moves 2% of the frame's diagonal or scales 10% across it (carry.mjs).
const crossfade = {
  id: 'skac/crossfade',
  category: 'timing',
  layer: 'rig',
  default: 'warn', // calibrated: its mutation in skac-e2e/src/mutations fails it (13 Nov); the interface sample passes
  docs: 'motion/interface',
  needs: ['opacity'],
  check(s, meta) {
    const dt = dtOf(s);
    const chans = opacityChannels(s, meta);
    const n = s.t_ms.length;
    const diag = Math.hypot((meta.width || 0) / (meta.scale || 1), (meta.height || 0) / (meta.scale || 1));
    const half = Math.round(CARRY_WINDOW_MS / 2 / dt);
    const carriers = (mid) => {
      const a = Math.max(0, mid - half);
      const b = Math.min(n - 1, mid + half);
      return Object.entries(s.parts || {}).filter(([, p]) => {
        const A = partAt(p, a);
        const B = partAt(p, b);
        return (diag > 0 && Math.hypot(B.x - A.x, B.y - A.y) >= CARRY_MOVE_SHARE * diag) || Math.abs(Math.log(B.size / A.size)) >= CARRY_SCALE_LOG;
      }).map(([name]) => name);
    };
    const out = [];
    for (const [outCh] of chans) {
      for (const i of crossings(s.channels[outCh], true)) {
        for (const [inCh] of chans) {
          if (inCh === outCh) continue;
          for (const j of crossings(s.channels[inCh], false)) {
            if (Math.abs(i - j) * dt > CROSS_MS) continue;
            if (carriers(Math.round((i + j) / 2)).length) continue;
            out.push(mk(this, {
              message: `\`${outCh}\` falls and \`${inCh}\` rises through 0.5 within ${r3(Math.abs(i - j) * dt)} ms at ${secs(s.t_ms[Math.min(i, j)])} s, and no part moves ${CARRY_MOVE_SHARE * 100}% of the frame's diagonal or scales ${CARRY_SCALE_LOG * 100}% across it: a bare boundary`,
              fix: 'carry something across the change: the element on both sides travels or grows from where it was to where it goes (carry, morphBox in motion/moves.ts), declared as a part; two whole states never cross-fade',
              at_s: secs(s.t_ms[Math.min(i, j)]), channel: outCh, value: r3(Math.abs(i - j) * dt), limit: CROSS_MS,
            }));
          }
        }
      }
    }
    return out;
  },
};

// pathcheck.mjs's KINK (O-2166) on the rig's parts, interfaces only: a part's centre changes speed by over half its speed at once.
const abrupt = {
  id: 'skac/abrupt',
  category: 'speed',
  layer: 'rig',
  default: 'warn', // calibrated: the linear-start mutation in skac-e2e/src/mutations fails it; both samples pass (13 Nov)
  docs: 'motion/interface',
  needs: ['parts', 'width', 'height'],
  check(s, meta) {
    // A character's hop leaves and meets the ground at speed (judged by the contact rules) and its wings turn at speed; on
    // skac-e2e's good combo every one of its 31 kinks was one of those (13 Nov). So abrupt judges interfaces only.
    if (kindOf(meta) !== 'interface') return [];
    const long = Math.max(meta.width, meta.height) / (meta.scale || 1);
    const kink = PATH_KINK_SHARE * long;
    const step = Math.max(1, Math.round(PATH_FRAME_MS / dtOf(s)));
    const parents = meta.parents || {};
    // A part listed under an opacity channel in meta.opacity is unseen while that opacity is under 0.5: it may start unseen.
    const seenBy = {};
    for (const [ch, carry] of opacityChannels(s, meta)) for (const c of carry) (seenBy[c] ||= []).push(s.channels[ch]);
    const out = [];
    for (const [name, p] of Object.entries(s.parts)) {
      const ops = seenBy[name] || [];
      const unseen = (i) => ops.some((o) => o[i] < 0.5);
      const q = s.parts[parents[name]];
      const c = p.x.map((_, i) => centreAt(p, i));
      const qc = q ? q.x.map((_, i) => centreAt(q, i)) : null;
      const idx = [];
      for (let i = 0; i < c.length; i += step) idx.push(i);
      for (const [axis, k] of [['x', 0], ['y', 1]]) {
        const v = idx.map((i) => c[i][k] - (qc ? qc[i][k] : 0));
        const d1 = v.slice(1).map((x, i) => x - v[i]);
        const at = (i) => secs(s.t_ms[idx[i]]);
        for (let i = 0; i + 1 < d1.length; i++) {
          const d2 = d1[i + 1] - d1[i];
          if (Math.abs(d2) <= kink || Math.abs(d2) <= KINK_SPEED_SHARE * Math.max(Math.abs(d1[i]), Math.abs(d1[i + 1]))) continue;
          if (unseen(idx[i]) || unseen(idx[i + 2])) continue;
          if (d1[i] * d1[i + 1] < 0) continue; // a turn at the end of a swing (a wing flap) reverses; a start or stop leaves or meets rest
          out.push(mk(this, {
            message: `KINK: part \`${name}\`.${axis} changes speed by ${r3(d2)} pt per frame at ${at(i + 1)} s (limit ${r3(kink)}, and over half its speed): it starts or stops at full speed`,
            fix: 'no move starts or stops at full speed: ease both ends (carry and morphBox ease inside; feed them linear progress, never a linear position)',
            at_s: at(i + 1), part: name, value: r3(Math.abs(d2)), limit: r3(kink),
          }));
        }
      }
    }
    return out;
  },
};

// ---- SVG path verbs (skac/morph-path) ----

const VERB = { M: 'move', L: 'line', Q: 'quad', C: 'cubic', A: 'arc', Z: 'close' };
const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const AS = { M: 'M', L: 'L', H: 'L', V: 'L', C: 'C', S: 'C', Q: 'Q', T: 'Q', A: 'A', Z: 'Z' };

/**
 * The verbs Skia.Path.MakeFromSVGString builds from an SVG path string: H and V are lines, S a cubic, T a quad,
 * coordinates after a move are lines, and a drawing command after a close starts a new contour with a move.
 * An arc is one 'A' here; Skia turns it into conics whose count depends on the sweep, so two arcs can still differ.
 */
export const svgVerbs = (d) => {
  if (typeof d !== 'string' || !d.trim()) return { error: 'not an SVG path string' };
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
  const verbs = [];
  let cmd = null;
  let closed = false;
  let k = 0;
  while (k < tokens.length) {
    const t = tokens[k];
    if (/[a-zA-Z]/.test(t)) {
      const c = t.toUpperCase();
      if (!(c in ARGS)) return { error: `unknown command ${t}` };
      cmd = c;
      k++;
      if (c === 'Z') { verbs.push('Z'); closed = true; cmd = null; continue; }
      if (k >= tokens.length || /[a-zA-Z]/.test(tokens[k])) return { error: `${t} has no numbers` };
    } else if (!cmd) return { error: `a number with no command before it (${t})` };
    const n = ARGS[cmd];
    if (tokens.slice(k, k + n).length < n || tokens.slice(k, k + n).some((x) => /[a-zA-Z]/.test(x))) return { error: `${cmd} needs ${n} numbers` };
    if (closed && cmd !== 'M') verbs.push('M');
    closed = false;
    verbs.push(AS[cmd]);
    k += n;
    if (cmd === 'M') cmd = 'L';
  }
  return { verbs };
};

// meta.morphs names each morphPath the draw runs, as its two SVG strings; Skia blends two paths only when their verbs match, else the render throws.
// Two SVG path strings whose Skia verbs differ: morphPath on them throws in the render, so --check fails first.
const morphPathRule = {
  id: 'skac/morph-path',
  category: 'request',
  layer: 'rig',
  default: 'error', // calibrated: the morph mutation in skac-e2e/src/mutations fails it; the samples declare no morphs (13 Nov)
  docs: 'motion/interface',
  needs: ['morphs'],
  check(s, meta) {
    const out = [];
    for (const [name, m] of Object.entries(meta.morphs || {})) {
      const a = svgVerbs(m && m.from);
      const b = svgVerbs(m && m.to);
      if (a.error || b.error) {
        out.push(mk(this, { message: `morph \`${name}\`: ${a.error ? `from: ${a.error}` : `to: ${b.error}`}`, fix: 'give meta.morphs.<name> as { from: <SVG path string>, to: <SVG path string> }, the strings the draw passes to Skia.Path.MakeFromSVGString', at_s: 0, value: name }));
        continue;
      }
      const i = a.verbs.findIndex((v, k) => v !== b.verbs[k]);
      if (i < 0 && a.verbs.length === b.verbs.length) continue;
      const at = i < 0 ? Math.min(a.verbs.length, b.verbs.length) : i;
      out.push(mk(this, {
        message: `morphPath \`${name}\`: the two paths do not share their verbs (from ${a.verbs.length}, to ${b.verbs.length}; verb ${at + 1} is ${VERB[a.verbs[at]] ?? 'missing'} in from, ${VERB[b.verbs[at]] ?? 'missing'} in to); the render throws`,
        fix: 'draw both shapes from the same command list (the same commands in the same order, only the numbers differ), or use morphPoints (motion/points.ts) for shapes that differ',
        at_s: 0, value: name,
      }));
    }
    return out;
  },
};

const ALL = [speedCap, minChange, overshoot, inFrame, idleCadence, deadHold, loopSeam, determinism, beatMoves, longFade, crossfade, abrupt, morphPathRule, ...CONTACT_RULES];

/** What a rule judges; every finding carries one. */
export const CATEGORIES = ['speed', 'timing', 'face', 'contact', 'framing', 'determinism', 'request'];

/** @type {Record<string, {id: string, layer: 'rig', category: string, default: 'warn'|'error', docs: string, needs: string[], check: Function}>} */
export const RULES = Object.fromEntries(ALL.map((r) => [r.id, r]));

const hasInput = (key, samples, meta) => (key === 'parts' ? Object.keys(samples.parts || {}).length > 0 : meta[key] !== undefined);

// The engine's own verdicts (not in RULES, so no severity setting can switch them off): a run that cannot be
// judged is an error, never a silent pass.
const SAMPLES = { id: 'skac/samples', category: 'determinism', docs: 'motion/checks' };
const NO_RULES = { id: 'skac/no-rules', category: 'request', docs: 'motion/checks' };
const KIND = { id: 'skac/kind', category: 'request', docs: 'motion/interface' };
const engineError = (rule, f) => ({ ruleId: rule.id, severity: 'error', category: rule.category, docs: rule.docs, at_s: 0, ...f });

/** One `skac/samples` error per channel or part field holding a NaN or non-finite value, at its first time. */
const badSamples = (s) => {
  const t = s.t_ms || [];
  if (!t.length) return [engineError(SAMPLES, { message: 'the rig was sampled 0 times', fix: 'give meta.frames and meta.fps a length above zero' })];
  const series = [
    ...Object.entries(s.channels || {}).map(([n, v]) => [{ channel: n }, `channel \`${n}\``, v]),
    ...Object.entries(s.parts || {}).flatMap(([n, p]) => Object.entries(p).map(([f, v]) => [{ part: n }, `part \`${n}\`.${f}`, v])),
  ];
  if (!series.length) return [engineError(SAMPLES, { message: 'the rig returns no channels and no parts', fix: 'return { channels, parts } from rig(ms)' })];
  const out = [];
  for (const [where, label, v] of series) {
    const i = v.findIndex((x) => !Number.isFinite(x));
    if (i < 0) continue;
    out.push(engineError(SAMPLES, {
      message: `${label} is ${v[i]} at ${secs(t[i])} s: the rig did not return a finite number there`,
      fix: 'return every channel and part field as a finite number on every frame',
      at_s: secs(t[i]), ...where,
    }));
  }
  return out;
};

/**
 * Run every rule whose inputs exist. `severities` maps a rule id to 'error', 'warn' or 'off'.
 * Samples with a NaN or missing value run no rule and return `skac/samples` errors; a run where no rule ran
 * returns a `skac/no-rules` error. `counts` gives every rule whether it ran and how many findings it made.
 * @returns {{findings: object[], skipped: {ruleId: string, missing: string[]}[], counts: Record<string, {checked: boolean, findings: number}>}}
 */
export const runRules = (samples, meta, severities = {}) => {
  const counts = Object.fromEntries(Object.keys(RULES).map((id) => [id, { checked: false, findings: 0 }]));
  if (meta.kind !== undefined && !KINDS.includes(meta.kind)) {
    return { findings: [engineError(KIND, { message: `meta.kind is ${JSON.stringify(meta.kind)}`, fix: `declare meta.kind as ${KINDS.map((k) => `'${k}'`).join(' or ')} (default 'character')` })], skipped: [], counts };
  }
  const bad = badSamples(samples);
  if (bad.length) return { findings: bad, skipped: [], counts };
  const findings = [];
  const skipped = [];
  for (const rule of Object.values(RULES)) {
    const sev = severities[rule.id] || rule.default;
    if (sev === 'off') continue;
    if (rule.kinds && !rule.kinds.includes(kindOf(meta))) {
      skipped.push({ ruleId: rule.id, kind: `not for ${kindOf(meta)} scenes (meta.kind)` });
      continue;
    }
    const missing = rule.needs.filter((k) => !hasInput(k, samples, meta));
    if (missing.length) {
      skipped.push({ ruleId: rule.id, missing });
      continue;
    }
    const got = rule.check(samples, meta);
    counts[rule.id] = { checked: true, findings: got.length };
    for (const f of got) findings.push({ ...f, category: f.category || rule.category, severity: sev });
  }
  if (!Object.values(counts).some((c) => c.checked)) {
    findings.push(engineError(NO_RULES, {
      message: `no rule ran: ${skipped.length} skipped for missing inputs, the rest set to off`,
      fix: 'turn a rule back on in the config, or declare the meta the skipped rules need (see `skipped`)',
    }));
  }
  findings.sort((a, b) => (a.at_s ?? 0) - (b.at_s ?? 0));
  return { findings, skipped, counts };
};

// ---- story ----------------------------------------------------------------------------------------------

const num = (x) => Number(x.toFixed(2));

/** Name the curve of a stretch from where its fastest step falls. `steps` are the per-frame sizes. */
const curveOf = (steps) => {
  const n = steps.length;
  if (n === 1) return 'cut';
  const peak = Math.max(...steps);
  const mean = steps.reduce((x, y) => x + y, 0) / n;
  if (peak / mean < 1.2) return 'linear';
  const pos = (steps.indexOf(peak) + 0.5) / n;
  if (pos < 0.35) return 'ease-out';
  if (pos > 0.65) return 'ease-in';
  return 'ease-in-out';
};

/**
 * Turn samples into text events an agent reads in place of frames.
 * @returns {string[]} lines, in time order
 */
export const describe = (samples, meta) => {
  const dt = dtOf(samples);
  const lines = []; // { t, text }
  const sec = (ms) => (ms / 1000).toFixed(2);

  for (const [name, v] of Object.entries(samples.channels)) {
    const range = rangeOf(v);
    if (range < 1e-9) continue;
    const thr = STORY_CHANNEL_RATE * range * dt;
    const delta = v.map((x, i) => (i === 0 ? 0 : x - v[i - 1]));
    let i = 1;
    while (i < v.length) {
      if (Math.abs(delta[i]) <= thr) {
        i++;
        continue;
      }
      const dir = Math.sign(delta[i]);
      let j = i;
      while (j + 1 < v.length && Math.abs(delta[j + 1]) > thr && Math.sign(delta[j + 1]) === dir) j++;
      const steps = delta.slice(i, j + 1).map(Math.abs);
      const from = v[i - 1];
      const to = v[j];
      if (Math.abs(to - from) >= 0.02 * range) {
        const ms = (j - i + 1) * dt;
        lines.push({ t: (i - 1) * dt, text: `${sec((i - 1) * dt)}–${sec(j * dt)} s \`${name}\` ${num(from)}→${num(to)} (${Math.round(ms)} ms, ${curveOf(steps)})` });
      }
      i = j + 1;
    }
  }

  for (const [name, steps] of partSteps(samples)) {
    const p = samples.parts[name];
    const speed = steps.map((d) => d / dt);
    for (const [a, b] of runs(speed.map((x, i) => i > 0 && x >= 0.01))) {
      const k = argMax(speed, a, b);
      const s0 = a - 1;
      const ms = (b - s0) * dt;
      lines.push({
        t: s0 * dt,
        text: `${sec(s0 * dt)}–${sec(b * dt)} s part \`${name}\` (${num(p.x[s0])}, ${num(p.y[s0])})→(${num(p.x[b])}, ${num(p.y[b])}) pt, ` +
          `peak ${num(speed[k])} pt/ms at ${sec(k * dt)} s (${Math.round(ms)} ms, ${curveOf(steps.slice(a, b + 1))})`,
      });
    }
  }

  for (const e of meta.events || []) lines.push({ t: e.at * 1000, text: `${e.at.toFixed(2)} s event \`${e.name}\`` });

  for (const b of meta.beats || []) {
    const c = beatChange(samples, b);
    const head = `${sec(b.from_ms)}–${sec(b.to_ms)} s beat \`${b.name}\` (\`${b.channel}\`)`;
    let tail = 'channel not in the rig';
    // The range inside the window, not its endpoints: a hop leaves 0 and comes back to 0.
    if (c && c.kind === 'channel') tail = c.moved ? `moves within ${num(c.min)}–${num(c.max)} (range ${num(c.change)})` : 'does NOT move';
    else if (c) tail = c.moved ? `travels ${num(c.change)} pt` : 'does NOT move';
    lines.push({ t: b.from_ms - 0.001, text: `${head}: ${tail}` });
  }

  return lines.sort((x, y) => x.t - y.t).map((l) => l.text);
};
