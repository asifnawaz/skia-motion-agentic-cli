import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CliError, fail, round } from './util.js';
import { viewsFile } from './render.js';
import { find, registrations } from './project.js';
import { partSpeeds } from './rules.js';
import { beatLines, judgeBeats, judgePoints, pointGroups, readSpec, specPath } from './spec.js';

import { restSpec as realRestSpec } from './rest.js';

// The blind-mode commands: --stats, --probe=x,y, --probe-box=x,y,w,h, --story, --check and lint. This file only composes the modules that do the work:
//   deps.lint    { lintFiles(cfg, files, { fix, severities }) -> { findings, fixed } }
//   deps.rig     { loadRig(cfg, name) -> { rig, meta, file }, sampleRig(rig, meta, events) -> samples }
//   deps.rules   { runRules(samples, meta, severities) -> { findings, skipped }, describe(samples, meta) -> string[] }
//   deps.compare { compareVideos(paths, { event, expect }) }
//   deps.pixels  { stillPixels(cfg, name, { frame, events }) -> { width, height, at(xPt, yPt) -> 'AARRGGBB' | null } }
//   deps.rest    { restSpec(cfg, name, spec, deps) -> { findings, skipped } }  (optional; defaults to ./rest.js)
// cli.js passes the real modules; the unit tests pass stubs.

const R = (x) => round(x, 4);

/** `rules` from skia-motion.json: { "skac/speed-cap": "error" | "warn" | "off" }. */
export const ruleSeverities = (cfg) => cfg.rules || {};

/** Events for a run: the ones --commands gave, else the rig's own `meta.events`. */
const eventsFor = (meta, events) => (events && events.length ? events : meta.events || []);

const sample = (cfg, name, events, deps) => {
  const reg = find(cfg, name);
  const loaded = deps.rig.loadRig(cfg, name);
  const used = eventsFor(loaded.meta, events);
  return { reg, ...loaded, events: used, samples: deps.rig.sampleRig(loaded.rig, loaded.meta, used) };
};

/** Fastest step of a series: the sample it arrives at and its speed per ms. */
const fastest = (series, t_ms) => {
  let best = { speed: 0, at_ms: t_ms[0] ?? 0 };
  for (let i = 1; i < series.length; i++) {
    const dt = t_ms[i] - t_ms[i - 1];
    if (dt <= 0) continue;
    const speed = Math.abs(series[i] - series[i - 1]) / dt;
    if (speed > best.speed) best = { speed, at_ms: t_ms[i] };
  }
  return best;
};

const range = (series) => ({ min: R(Math.min(...series)), max: R(Math.max(...series)) });

const partSeries = (part, key, n) => {
  const v = part[key];
  if (Array.isArray(v)) return v;
  return Array.from({ length: n }, () => (typeof v === 'number' ? v : 0));
};

const parsePoints = (points) => {
  const pts = String(points || '').split(/[;\s]+/).filter(Boolean).map((p) => {
    const m = /^(-?\d*\.?\d+),(-?\d*\.?\d+)$/.exec(p);
    if (!m) fail(`bad probe point ${JSON.stringify(p)}`, 'use --probe=x,y in points, several as --probe="10,20;30,40"');
    return [Number(m[1]), Number(m[2])];
  });
  if (!pts.length) fail('--probe needs a point', 'use --probe=x,y --at=<seconds>; the rig summary is --stats');
  return pts;
};

/** One still at `at` s, and its px per pt (the still's width over the composition's width in pt). */
const stillAt = (cfg, name, at, events, deps) => {
  const reg = find(cfg, name);
  const still = deps.pixels.stillPixels(cfg, name, { frame: Math.round(at * (reg.fps || 30)), events });
  return { still, frame: Math.round(at * (reg.fps || 30)), pxPerPt: reg.width ? still.width / reg.width : 1 };
};

/**
 * `<Name> --probe=x,y[;x,y...] --at=t`: the colour at each point as AARRGGBB, as rive's --probe prints it.
 * Points are artboard points. One still render, no image to open.
 */
export const pixelProbe = (cfg, name, { points, at = 0, events } = {}, deps) => {
  const pts = parsePoints(points);
  const { still, frame, pxPerPt } = stillAt(cfg, name, at, events, deps);
  const probes = pts.map(([x, y]) => {
    const color = still.at(x, y);
    if (color === null) fail(`probe ${x},${y} is outside the frame`, `the frame is ${R(still.width / pxPerPt)}x${R(still.height / pxPerPt)} pt`);
    return { x, y, color };
  });
  return { ok: true, name, at, frame, units: 'pt', px_per_pt: R(pxPerPt), probes, next: [`skac ${name} --check`] };
};

const BOX_COLORS = 8;

/**
 * `<Name> --probe-box=x,y,w,h --at=t`: the distinct colours inside a box (points), top 8 by pixel count, each with its
 * share of the box and its bounding box in points. One still render; colours are read per point-grid cell, so a box
 * counts (w x h) cells of one point each at the still's scale.
 */
export const boxProbe = (cfg, name, { box, at = 0, events } = {}, deps) => {
  const m = /^(-?\d*\.?\d+),(-?\d*\.?\d+),(\d*\.?\d+),(\d*\.?\d+)$/.exec(String(box || '').trim());
  if (!m) fail(`bad probe box ${JSON.stringify(box)}`, 'use --probe-box=x,y,w,h in points, for example --probe-box=100,200,50,50 --at=0.5');
  const [x, y, w, h] = m.slice(1).map(Number);
  if (!(w > 0 && h > 0)) fail('--probe-box needs a width and height above 0', 'use --probe-box=x,y,w,h in points');
  const { still, frame, pxPerPt } = stillAt(cfg, name, at, events, deps);
  const step = 1 / pxPerPt; // one pixel in pt
  const seen = new Map();
  let total = 0;
  for (let j = 0; j < Math.round(h * pxPerPt); j++) {
    const py = y + j * step;
    for (let i = 0; i < Math.round(w * pxPerPt); i++) {
      const px = x + i * step;
      const color = still.at(px, py);
      if (color === null) continue;
      total++;
      const c = seen.get(color) || { color, pixels: 0, x0: px, y0: py, x1: px, y1: py };
      c.pixels++;
      c.x0 = Math.min(c.x0, px); c.y0 = Math.min(c.y0, py); c.x1 = Math.max(c.x1, px); c.y1 = Math.max(c.y1, py);
      seen.set(color, c);
    }
  }
  if (!total) fail('the box is outside the frame', `the frame is ${R(still.width / pxPerPt)}x${R(still.height / pxPerPt)} pt`);
  const colors = [...seen.values()].sort((a, b) => b.pixels - a.pixels).slice(0, BOX_COLORS)
    .map((c) => ({ color: c.color, pixels: c.pixels, share: R(c.pixels / total), bbox: [R(c.x0), R(c.y0), R(c.x1 - c.x0 + step), R(c.y1 - c.y0 + step)] }));
  return { ok: true, name, at, frame, units: 'pt', px_per_pt: R(pxPerPt), box: [x, y, w, h], pixels: total, colors, next: [`skac ${name} --probe=x,y --at=${at}`] };
};

/** `<Name> --stats`: per channel and part, the range and the fastest frame, without rendering. */
export const stats = (cfg, name, { events } = {}, deps) => {
  const { meta, samples, events: used } = sample(cfg, name, events, deps);
  const { t_ms } = samples;
  const channels = {};
  for (const [ch, series] of Object.entries(samples.channels || {})) {
    const f = fastest(series, t_ms);
    channels[ch] = { ...range(series), fastest_at_s: R(f.at_ms / 1000), fastest_speed_per_ms: R(f.speed) };
  }
  const windowed = Object.fromEntries(partSpeeds(samples, meta).speeds.map(([p, v]) => [p, v]));
  const parts = {};
  for (const [p, s] of Object.entries(samples.parts || {})) {
    const n = t_ms.length;
    const x = partSeries(s, 'x', n);
    const y = partSeries(s, 'y', n);
    const speeds = windowed[p] || t_ms.map(() => 0);
    let bi = 0;
    speeds.forEach((v, i) => { if (v > speeds[bi]) bi = i; });
    parts[p] = { x: range(x), y: range(y), fastest_at_s: R(t_ms[bi] / 1000), fastest_speed_pt_per_ms: R(speeds[bi]) };
  }
  return {
    ok: true, name, fps: meta.fps ?? samples.fps, frames: meta.frames ?? t_ms.length, samples: t_ms.length, duration_s: R((t_ms[t_ms.length - 1] ?? 0) / 1000),
    events: used, beats: meta.beats || [], channels, parts,
    next: [`skac ${name} --story`, `skac ${name} --check`],
  };
};

/** The task author's spec beside the composition: `{ spec, file }`, `{ spec: null }` or `{ error, file }`. */
const specOf = (cfg, name) => {
  const reg = find(cfg, name);
  return reg._abs ? readSpec(specPath(reg._abs, name)) : { spec: null, file: null };
};

const OUTSIDE = 'outside';
const NO_SPEC = 'no <Name>.spec.json beside the composition: the beats are self-declared (the rig\'s meta.beats), so --check grades the rig against itself; write the spec to say what counts as done';

/** The spec layer: beats from the samples, points through pixelProbe, rest-pose parts through rest.js. */
const specLayer = (cfg, name, samples, events, deps) => {
  const sp = specOf(cfg, name);
  if (sp.error) return { findings: [{ ruleId: 'skac/spec-beat', severity: 'error', message: sp.error, fix: 'fix the spec file', docs: 'blind' }], skipped: [], spec: { file: sp.file } };
  if (!sp.spec) return { findings: [], skipped: [], spec: { file: null, beats: 'self-declared', note: NO_SPEC } };
  const { spec } = sp;
  const findings = [];
  const skipped = [];
  let beats = [];
  if (samples) {
    const b = judgeBeats(spec, samples);
    findings.push(...b.findings);
    beats = b.beats;
  } else if ((spec.beats || []).length) skipped.push({ ruleId: 'skac/spec-beat', reason: 'the rig did not load' });

  const pts = pointGroups(spec);
  findings.push(...pts.findings);
  if (pts.groups.length && !deps.pixels) skipped.push({ ruleId: 'skac/spec-point', reason: 'no pixel reader' });
  else {
    for (const { at, points } of pts.groups) {
      try {
        // A point outside the frame is the spec's failure, not a crash: let it through pixelProbe as OUTSIDE.
        const pixels = { stillPixels: (...a) => { const still = deps.pixels.stillPixels(...a); return { ...still, at: (x, y) => still.at(x, y) ?? OUTSIDE }; } };
        const doc = pixelProbe(cfg, name, { points: points.map((p) => `${p.x},${p.y}`).join(';'), at, events }, { ...deps, pixels });
        findings.push(...judgePoints(points, doc.probes.map((p) => (p.color === OUTSIDE ? null : p.color))));
      } catch (e) {
        if (!(e instanceof CliError)) throw e;
        skipped.push({ ruleId: 'skac/spec-point', reason: `the still at ${at} s did not render: ${e.message}` });
      }
    }
  }

  if (spec.parts) {
    const restSpec = deps.rest ? deps.rest.restSpec : realRestSpec;
    if (!restSpec) skipped.push({ ruleId: 'skac/rest-spec', reason: 'src/rest.js is not there' });
    else if (!deps.pixels) skipped.push({ ruleId: 'skac/rest-spec', reason: 'no pixel reader' });
    else {
      const r = restSpec(cfg, name, spec, deps);
      findings.push(...(r.findings || []));
      skipped.push(...(r.skipped || []));
    }
  }
  return { findings, skipped, spec: { file: sp.file, beats } };
};

/** `<Name> --story`: the motion as text lines. */
export const story = (cfg, name, { events } = {}, deps) => {
  const { meta, samples, events: used } = sample(cfg, name, events, deps);
  const lines = deps.rules.describe(samples, meta);
  const sp = specOf(cfg, name);
  if (!sp.spec) return { ok: true, name, events: used, lines, ...(sp.error ? { spec_error: sp.error } : {}), next: [`skac ${name} --check`] };
  const { beats } = judgeBeats(sp.spec, samples);
  return { ok: true, name, events: used, lines: [...lines, ...beatLines(beats)], beats, next: [`skac ${name} --check`] };
};

/** Looks logged by `--screenshot` for this composition. */
const readViews = (cfg, name) => {
  const file = viewsFile(cfg);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((v) => !v.name || v.name === name);
};

const isError = (f) => f.severity === 'error';

/** Pixel facts as findings, from the composition's last render in <out>/<Name>/<Name>.mp4. */
const pixelLayer = (cfg, name, meta, deps) => {
  const file = join(cfg.out, name, `${name}.mp4`);
  if (!existsSync(file)) return { skipped: { layer: 'pixels', reason: `no render of ${name} in the out folder`, run: `skac ${name} --render` }, findings: [] };
  const event = (meta.events && meta.events[0] && meta.events[0].at) ?? 4.0;
  const cmp = deps.compare.compareVideos([file], { event });
  const v = cmp.videos[0];
  const findings = [];
  if (v.blank_frames) {
    findings.push({
      ruleId: 'skac/blank-frames', severity: 'error', value: v.blank_frames, limit: 0,
      message: `${v.blank_frames} blank frame(s) in the render`,
      fix: 'something draws nothing on those frames: check the canvas size and any conditional that hides everything', docs: 'motion/checks',
    });
  }
  if (!v.spec_ok) {
    findings.push({
      ruleId: 'skac/video-spec', severity: 'error',
      message: `the render is ${v.probe.width}x${v.probe.height} at ${v.probe.fps} fps, ${v.probe.codec}/${v.probe.pix_fmt}, ${v.probe.duration} s`,
      fix: `render again with \`skac ${name} --render\``, docs: 'motion/checks',
    });
  }
  return { findings, pixels: { path: v.path, jerk: v.jerk, peak: v.peak, motion: v.motion, still_frames: v.still_frames, blank_frames: v.blank_frames, spec_ok: v.spec_ok } };
};

/**
 * `<Name> --check`: lint the composition and its rig, run the rig rules on the samples, add the pixel facts.
 * One report, cheapest layer first. `ok` is false only for error-severity findings.
 */
export const check = (cfg, name, { events } = {}, deps) => {
  const reg = find(cfg, name);
  const severities = ruleSeverities(cfg);
  const findings = [];
  const skipped = [];
  let rigFile = null;
  let loaded = null;
  let samples = null;
  let used = [];

  try {
    loaded = deps.rig.loadRig(cfg, name);
    rigFile = loaded.file;
    used = eventsFor(loaded.meta, events);
    samples = deps.rig.sampleRig(loaded.rig, loaded.meta, used);
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    findings.push({
      ruleId: 'skac/rig-load', severity: 'error', message: e.message,
      fix: e.hint || `write src/${name}.rig.ts exporting meta and rig(ms), or run \`skac add\` for the pattern`, docs: 'blind',
    });
    skipped.push({ layer: 'rig', reason: 'the rig did not load' });
  }

  const files = [reg._abs, rigFile].filter(Boolean);
  if (files.length) findings.push(...deps.lint.lintFiles(cfg, files, { fix: false, severities }).findings);

  if (samples) {
    const r = deps.rules.runRules(samples, loaded.meta, severities);
    findings.push(...r.findings);
    skipped.push(...(r.skipped || []));
  }

  const sl = specLayer(cfg, name, samples, used, deps);
  findings.push(...sl.findings);
  skipped.push(...sl.skipped);

  const px = pixelLayer(cfg, name, loaded ? loaded.meta : {}, deps);
  findings.push(...px.findings);
  if (px.skipped) skipped.push(px.skipped);

  const failures = findings.filter(isError);
  const warnings = findings.filter((f) => f.severity === 'warn');
  const views = readViews(cfg, name);
  const doc = {
    ok: failures.length === 0, name, failures, warnings, skipped, spec: sl.spec, views: views.length,
    ...(px.pixels ? { pixels: px.pixels } : {}),
  };
  if (views.length && failures.length) doc.hint = `you looked ${views.length} time(s) before the checks passed: check first; look once at the end with --sheet`;
  doc.next = failures.length ? [`fix the failures, then \`skac ${name} --check\``] : [`skac ${name} --story`, `skac ${name} --render`, `skac ${name} --screenshot --at=<s> --sheet`];
  return doc;
};

/** `lint [files...] [--fix]`: the source layer alone. With no files, every registered composition and its rig. */
export const lint = (cfg, files, { fix } = {}, deps) => {
  let targets = files;
  if (!targets.length) {
    targets = registrations(cfg).flatMap((r) => {
      if (!r._abs) return [];
      const rigPath = [join(dirname(r._abs), `${r.id}.rig.ts`), r._abs.replace(/\.[jt]sx?$/, '.rig.ts')].find(existsSync);
      return rigPath ? [r._abs, rigPath] : [r._abs];
    });
  }
  if (!targets.length) fail('no files to lint', 'pass paths, or register a composition first with `skac add <Name>`');
  const { findings, fixed = [] } = deps.lint.lintFiles(cfg, targets, { fix: Boolean(fix), severities: ruleSeverities(cfg) });
  const failures = findings.filter(isError);
  return { ok: failures.length === 0, files: targets, count: findings.length, errors: failures.length, findings, fixed };
};
