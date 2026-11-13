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

const dtOf = (s) => 1000 / s.fps;
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
    for (const [name, speed, parent] of speeds) {
      for (const [a, b] of runs(speed.map((v) => v > SPEED_CAP))) {
        const k = argMax(speed, a, b);
        out.push(mk(this, {
          message: `part \`${name}\` moves at ${r3(speed[k])} pt/ms${frameOf(parent)} at ${secs(s.t_ms[k])} s (cap ${SPEED_CAP})`,
          fix: `lengthen the move by x${r3(speed[k] / SPEED_CAP)} or shorten the distance; a burst needs a wind-up first` +
            (parent ? '' : '; a part carried by another (a wing on a hopping body) belongs in meta.parents'),
          at_s: secs(s.t_ms[k]), part: name, value: r3(speed[k]), limit: SPEED_CAP,
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

const deadHold = {
  id: 'skac/dead-hold',
  category: 'timing',
  layer: 'rig',
  default: 'warn',
  docs: 'motion/body',
  needs: [],
  check(s) {
    const dt = dtOf(s);
    const n = s.t_ms.length;
    const chans = Object.values(s.channels);
    const parts = Object.values(s.parts || {});
    if (!chans.length && !parts.length) return [];
    const still = Array.from({ length: n }, () => true);
    for (const v of chans) {
      const eps = STILL_CHANNEL_RATE * rangeOf(v) * dt;
      for (let i = 1; i < n; i++) if (Math.abs(v[i] - v[i - 1]) > eps) still[i] = false;
    }
    const partEps = STILL_PART_RATE * dt;
    for (const p of parts) {
      for (const f of Object.keys(p)) for (let i = 1; i < n; i++) if (Math.abs(p[f][i] - p[f][i - 1]) > partEps) still[i] = false;
    }
    const out = [];
    for (const [a, b] of runs(still.map((f, i) => f && i > 0))) {
      const ms = (b - a + 1) * dt;
      if (ms <= DEAD_HOLD_MS) continue;
      out.push(mk(this, {
        message: `everything is still for ${r3(ms)} ms from ${secs((a - 1) * dt)} s (limit ${DEAD_HOLD_MS})`,
        fix: 'give every held pose a moving layer: a slow breath, a sway, a trailing part',
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

const ALL = [speedCap, minChange, overshoot, inFrame, idleCadence, deadHold, loopSeam, determinism, beatMoves, ...CONTACT_RULES];

/** What a rule judges; every finding carries one. */
export const CATEGORIES = ['speed', 'timing', 'face', 'contact', 'framing', 'determinism', 'request'];

/** @type {Record<string, {id: string, layer: 'rig', category: string, default: 'warn'|'error', docs: string, needs: string[], check: Function}>} */
export const RULES = Object.fromEntries(ALL.map((r) => [r.id, r]));

const hasInput = (key, samples, meta) => (key === 'parts' ? Object.keys(samples.parts || {}).length > 0 : meta[key] !== undefined);

// The engine's own verdicts (not in RULES, so no severity setting can switch them off): a run that cannot be
// judged is an error, never a silent pass.
const SAMPLES = { id: 'skac/samples', category: 'determinism', docs: 'motion/checks' };
const NO_RULES = { id: 'skac/no-rules', category: 'request', docs: 'motion/checks' };
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
  const bad = badSamples(samples);
  if (bad.length) return { findings: bad, skipped: [], counts };
  const findings = [];
  const skipped = [];
  for (const rule of Object.values(RULES)) {
    const sev = severities[rule.id] || rule.default;
    if (sev === 'off') continue;
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
