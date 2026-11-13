import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// The task author's spec, `<Name>.spec.json` beside the composition. It says what counts as done, so the rig cannot grade itself:
//   parts   boxes of the rest pose, read by rest.js
//   points  [{ name, x, y, color, at? }]   colour at a point in pt, at `at` seconds (0 by default), as #RRGGBB or AARRGGBB
//   open    numbers the author left open (free text, not checked)
//   beats   [{ name, channel | part, from_ms?, to_ms?, direction?, after?, overlaps?, reaches?: { channel, min?, max? } }]
// A beat's window: from_ms/to_ms if given, else after the span of the beat it follows, else the span of the beat it overlaps,
// else the whole clip. A beat's span is the stretch where its dominant move runs (speed at least a tenth of its peak), so a
// part that breathes all the time still has a span. Directions compare the farthest value from the window's start; parts have
// a top-left origin, so `up` means y falls. Everything works from `samples.t_ms`; nothing here reads the rig rules.

const R = (x) => Math.round(x * 1e4) / 1e4;
const BEAT = 'skac/spec-beat';
const POINT = 'skac/spec-point';
/** How far a colour may be from the spec's, per channel (0 to 255). */
export const COLOR_TOLERANCE = 24;
/** A speed under this share of the peak is not part of the span. */
const SPAN_SHARE = 0.1;
const DIRECTIONS = { up: ['y', -1], down: ['y', 1], left: ['x', -1], right: ['x', 1] };

/** Where a composition's spec lives: beside its .tsx, as `<Name>.spec.json`. */
export const specPath = (compositionFile, name) => join(dirname(compositionFile), `${name}.spec.json`);

/** `{ spec, file }`, `{ spec: null, file }` with no file, or `{ error, file }` when the file is not a spec. */
export const readSpec = (file) => {
  if (!file || !existsSync(file)) return { spec: null, file: file || null };
  let spec;
  try {
    spec = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { error: `${file} is not valid JSON: ${e.message}`, file };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { error: `${file} is not a JSON object`, file };
  for (const key of ['points', 'beats']) {
    if (spec[key] !== undefined && !Array.isArray(spec[key])) return { error: `"${key}" in ${file} is not an array`, file };
  }
  return { spec, file };
};

const beatFinding = (beat, message, fix, extra = {}) => ({ ruleId: BEAT, severity: 'error', beat, message, fix, docs: 'blind', ...extra });

/** The series a beat watches: a channel, or one field of a part (the direction's axis, else the field that moves most). */
const seriesOf = (beat, samples) => {
  if (beat.channel !== undefined) {
    const s = (samples.channels || {})[beat.channel];
    if (!s) return { error: `channel "${beat.channel}" is not in the rig`, known: Object.keys(samples.channels || {}) };
    return { series: s, label: `\`${beat.channel}\`` };
  }
  if (beat.part !== undefined) {
    const p = (samples.parts || {})[beat.part];
    if (!p) return { error: `part "${beat.part}" is not in the rig`, known: Object.keys(samples.parts || {}) };
    const fields = Object.entries(p).filter(([, v]) => Array.isArray(v));
    let field;
    if (beat.direction !== undefined) field = DIRECTIONS[beat.direction]?.[0];
    else field = fields.reduce((best, [f, v]) => ((Math.max(...v) - Math.min(...v)) > best[1] ? [f, Math.max(...v) - Math.min(...v)] : best), [null, -1])[0];
    if (!field || !Array.isArray(p[field])) return { error: `part "${beat.part}" has no ${field || 'moving field'}`, known: fields.map(([f]) => f) };
    return { series: p[field], label: `${beat.part}.${field}` };
  }
  return { error: 'names neither a channel nor a part', known: [] };
};

/** Sample indices inside [from, to] ms. */
const indices = (t_ms, [from, to]) => t_ms.flatMap((t, i) => (t >= from && t <= to ? [i] : []));

/** The stretch of a window where the series moves at least SPAN_SHARE of its peak speed; null when it never moves. */
const spanIn = (series, t_ms, idx) => {
  const speed = idx.map((i, k) => (k === 0 ? 0 : Math.abs(series[i] - series[idx[k - 1]]) / ((t_ms[i] - t_ms[idx[k - 1]]) || 1)));
  const peak = Math.max(0, ...speed);
  if (peak <= 1e-9) return null;
  const active = speed.flatMap((v, k) => (v >= SPAN_SHARE * peak ? [k] : []));
  return [t_ms[idx[active[0] - 1] ?? idx[0]], t_ms[idx[active[active.length - 1]]]];
};

/** The value farthest from the window's first sample, and whether it moved more than a hundredth of the series' whole range. */
const farthest = (series, idx) => {
  const v0 = series[idx[0]];
  let far = v0;
  for (const i of idx) if (Math.abs(series[i] - v0) > Math.abs(far - v0)) far = series[i];
  const whole = Math.max(...series) - Math.min(...series);
  return { from: v0, reached: far, moved: Math.abs(far - v0) > Math.max(1e-6, 0.01 * whole) };
};

/**
 * Judge the spec's beats against the rig samples.
 * Returns `findings` (each unmet item, `skac/spec-beat`) and `beats`: per beat its window, span, reached value and `met`.
 */
export const judgeBeats = (spec, samples) => {
  const beats = (spec && spec.beats) || [];
  const t_ms = samples.t_ms || [];
  const clip = [t_ms[0] ?? 0, t_ms[t_ms.length - 1] ?? 0];
  const byName = new Map();
  const findings = [];
  for (const b of beats) {
    if (!b || typeof b.name !== 'string' || !b.name) {
      findings.push(beatFinding(null, `a beat has no name: ${JSON.stringify(b)}`, 'give every beat a unique "name"'));
    } else if (byName.has(b.name)) {
      findings.push(beatFinding(b.name, `two beats are named "${b.name}"`, 'give every beat a unique "name"'));
    } else byName.set(b.name, b);
  }

  const memo = new Map();
  const resolving = new Set();
  /** `{ window, span, series, label }` for a beat, or `{ error, fix }`. */
  const resolve = (name) => {
    if (memo.has(name)) return memo.get(name);
    const b = byName.get(name);
    if (resolving.has(name)) return { error: `"${name}" follows or overlaps itself through other beats`, fix: 'break the after/overlaps loop' };
    resolving.add(name);
    let out;
    const s = b.direction !== undefined && !(b.direction in DIRECTIONS) ? null : seriesOf(b, samples);
    if (!s) {
      out = { error: `beat "${name}" has unknown direction "${b.direction}"`, fix: `use one of: ${Object.keys(DIRECTIONS).join(', ')}` };
    } else if (s.error) {
      out = { error: `beat "${name}" ${s.error}`, fix: s.known.length ? `use one of: ${s.known.join(', ')}` : 'set "channel" or "part" to a name the rig returns' };
    } else if (b.direction !== undefined && b.channel !== undefined && DIRECTIONS[b.direction][0] === 'x') {
      out = { error: `beat "${name}": direction "${b.direction}" needs a part; a channel goes up or down`, fix: 'use up or down, or watch a part' };
    } else if ([b.after, b.overlaps].some((o) => o !== undefined && !byName.has(o))) {
      const o = [b.after, b.overlaps].find((x) => x !== undefined && !byName.has(x));
      out = { error: `beat "${name}" names "${o}" in after/overlaps, which is not a beat`, fix: `use one of: ${[...byName.keys()].join(', ')}` };
    } else {
      let window = clip;
      let ref = null;
      if (b.from_ms !== undefined || b.to_ms !== undefined) window = [b.from_ms ?? clip[0], b.to_ms ?? clip[1]];
      else if (b.after !== undefined || b.overlaps !== undefined) {
        const other = b.after ?? b.overlaps;
        if (!byName.has(other)) {
          out = { error: `beat "${name}" ${b.after !== undefined ? 'follows' : 'overlaps'} "${other}", which is not a beat`, fix: `use one of: ${[...byName.keys()].join(', ')}` };
        } else {
          ref = resolve(other);
          if (ref.error) out = { error: `beat "${name}" depends on "${other}": ${ref.error}`, fix: ref.fix };
          else if (!ref.span) out = { error: `beat "${name}" ${b.after !== undefined ? 'follows' : 'overlaps'} "${other}", which never moves`, fix: `make "${other}" move, or give "${name}" from_ms/to_ms` };
          else window = b.after !== undefined ? [ref.span[1], clip[1]] : ref.span;
        }
      }
      if (!out) {
        const idx = indices(t_ms, window);
        if (!idx.length) out = { error: `beat "${name}" has no samples in ${window[0]}–${window[1]} ms`, fix: `keep the window inside the clip, ${clip[0]}–${clip[1]} ms` };
        else out = { window, idx, span: spanIn(s.series, t_ms, idx), series: s.series, label: s.label };
      }
    }
    resolving.delete(name);
    memo.set(name, out);
    return out;
  };

  const report = [];
  for (const [name, b] of byName) {
    const r = resolve(name);
    if (r.error) {
      findings.push(beatFinding(name, r.error, r.fix));
      report.push({ name, met: false, error: r.error });
      continue;
    }
    const f = farthest(r.series, r.idx);
    const entry = { name, watches: r.label, window_ms: r.window.map(R), span_ms: r.span && r.span.map(R), from: R(f.from), reached: R(f.reached), met: true };
    const unmet = (message, fix, extra) => { entry.met = false; findings.push(beatFinding(name, message, fix, extra)); };
    const win = `${R(r.window[0])}–${R(r.window[1])} ms`;

    if (b.direction !== undefined) {
      const sign = DIRECTIONS[b.direction][1] * (b.channel !== undefined ? -1 : 1);
      // For a part, up is y falling (sign -1 on y); for a channel, up is the value rising.
      const ok = f.moved && Math.sign(f.reached - f.from) === sign;
      entry.direction = b.direction;
      if (!ok) unmet(
        f.moved ? `beat "${name}": ${r.label} goes ${f.reached > f.from ? 'up in value' : 'down in value'} (${R(f.from)} to ${R(f.reached)}) in ${win}, the spec says ${b.direction}` : `beat "${name}": ${r.label} does not move in ${win}, the spec says ${b.direction}`,
        b.part !== undefined ? `move ${r.label} ${b.direction} in that window (parts have a top-left origin: up means y falls)` : `make ${r.label} ${b.direction === 'up' ? 'rise' : 'fall'} in that window`,
        { value: R(f.reached), from: R(f.from) },
      );
    }
    if (b.after !== undefined && b.from_ms === undefined && b.to_ms === undefined && !f.moved) {
      unmet(`beat "${name}": ${r.label} does not move after "${b.after}" ends (${win})`, `start ${r.label}'s move after "${b.after}" ends, at ${R(r.window[0])} ms`);
    }
    if (b.overlaps !== undefined && b.after === undefined && b.from_ms === undefined && b.to_ms === undefined && !f.moved) {
      unmet(`beat "${name}": ${r.label} does not move while "${b.overlaps}" runs (${win})`, `move ${r.label} during "${b.overlaps}"`);
    }
    if (b.reaches) {
      const ch = b.reaches.channel;
      const series = (samples.channels || {})[ch];
      if (!series) {
        unmet(`beat "${name}" reaches channel "${ch}", which is not in the rig`, `use one of: ${Object.keys(samples.channels || {}).join(', ')}`);
      } else {
        const g = farthest(series, r.idx);
        const { min, max } = b.reaches;
        entry.reaches = { channel: ch, reached: R(g.reached), ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
        if ((min !== undefined && g.reached < min) || (max !== undefined && g.reached > max)) {
          unmet(
            `beat "${name}": \`${ch}\` reaches ${R(g.reached)} in ${win}, the spec wants ${[min !== undefined ? `at least ${min}` : '', max !== undefined ? `at most ${max}` : ''].filter(Boolean).join(' and ')}`,
            `change the move of \`${ch}\` so it gets there inside ${win}`,
            { value: R(g.reached), limit: min !== undefined && g.reached < min ? min : max },
          );
        }
      }
    }
    report.push(entry);
  }
  return { findings, beats: report };
};

/** `#RRGGBB`, `RRGGBB` or `AARRGGBB` -> [a, r, g, b], or null. */
export const parseColor = (c) => {
  const hex = String(c ?? '').replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return [255, ...hex.match(/../g).map((h) => parseInt(h, 16))];
  if (/^[0-9a-f]{8}$/i.test(hex)) return hex.match(/../g).map((h) => parseInt(h, 16));
  return null;
};

/** Largest difference over a, r, g and b. */
export const colorDistance = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** Points of the spec grouped by `at` seconds, ready for one pixelProbe call each. Bad entries come back as findings. */
export const pointGroups = (spec) => {
  const findings = [];
  const groups = new Map();
  for (const p of (spec && spec.points) || []) {
    const name = p && p.name;
    if (!name || typeof p.x !== 'number' || typeof p.y !== 'number' || !parseColor(p.color)) {
      findings.push({ ruleId: POINT, severity: 'error', part: name ?? null, message: `point ${JSON.stringify(p)} needs name, x, y in pt and color as #RRGGBB or AARRGGBB`, fix: 'fix the point in the spec', docs: 'blind' });
      continue;
    }
    const at = p.at ?? 0;
    if (!groups.has(at)) groups.set(at, []);
    groups.get(at).push(p);
  }
  return { findings, groups: [...groups].map(([at, points]) => ({ at, points })) };
};

/** One finding per point whose probed colour is more than COLOR_TOLERANCE away on any channel. */
export const judgePoints = (points, colors) => points.flatMap((p, i) => {
  const want = parseColor(p.color);
  const got = parseColor(colors[i]);
  const d = got ? colorDistance(want, got) : Infinity;
  if (d <= COLOR_TOLERANCE) return [];
  return [{
    ruleId: POINT, severity: 'error', part: p.name, value: colors[i] ?? null, limit: p.color,
    message: `point "${p.name}" at ${p.x},${p.y} pt, ${p.at ?? 0} s is ${colors[i] ?? 'outside the frame'}, the spec says ${p.color} (${Number.isFinite(d) ? `${d} apart` : 'no pixel'}, ${COLOR_TOLERANCE} allowed)`,
    fix: `draw "${p.name}" in ${p.color} at that point, or move the point; read it with --probe=${p.x},${p.y} --at=${p.at ?? 0}`,
    docs: 'blind',
  }];
});

/** Story lines: each beat's reached value. */
export const beatLines = (beats) => beats.map((b) => (b.error
  ? `beat ${b.name}: ${b.error}`
  : `beat ${b.name} (${b.watches}, ${b.window_ms[0]}–${b.window_ms[1]} ms): ${b.from} → ${b.reached}${b.direction ? `, ${b.direction}` : ''}${b.reaches ? `; \`${b.reaches.channel}\` reaches ${b.reaches.reached}` : ''}: ${b.met ? 'met' : 'unmet'}`));
