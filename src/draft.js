// The draft gate (owner, O-5625 and O-5626, 13 Nov 2026): the first `--check` of a scene is a draft, and so is a re-run of an unchanged one.
// It answers `draft: true` with the two weakest beats until the rig or the drawing changes; `--export` waits for a passing check of a revised scene.
// The state is one small file per project: .skac/drafts.json, { "<Name>": { hash, draft, ok } }, the hash being sha256 of the rig and the draw file.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { INTERFACE_SPEED_CAP, kindOf, partSpeeds, SPEED_CAP } from './rules.js';
import { fail, round } from './util.js';

export const DRAFT_MESSAGE = 'This first draft is crap. Why did you build it this way? Do not answer: improve it.';
export const DRAFT_FILE = '.skac/drafts.json';

/** What makes a beat weak, most damaging first: a bare or cross-faded boundary, a stall, an abrupt start, a fade-only plan, the rest. */
const PRIORITY = ['skac/crossfade', 'skac/dead-hold', 'skac/abrupt', 'skac/long-fade', 'skac/beat-moves', 'skac/speed-cap'];
const WEAKEST = 2;

const statePath = (cfg) => join(cfg.projectDir, DRAFT_FILE);
const readState = (cfg) => {
  try {
    const s = JSON.parse(readFileSync(statePath(cfg), 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
};
const writeState = (cfg, state) => {
  mkdirSync(dirname(statePath(cfg)), { recursive: true });
  writeFileSync(statePath(cfg), JSON.stringify(state, null, 2) + '\n');
};

/** sha256 of the scene's rig and, when it has one, its draw file; null when the rig did not load. */
const sourceHash = (cfg, name, deps) => {
  let file;
  try {
    file = deps.rig.loadRig(cfg, name).file;
  } catch {
    return null;
  }
  if (!file) return null;
  const h = createHash('sha256').update(readFileSync(file));
  const draw = file.replace(/\.rig\.ts$/, '.draw.ts');
  if (draw !== file && existsSync(draw)) h.update('\0').update(readFileSync(draw));
  return h.digest('hex');
};

const beatOf = (f) => ({
  rule: f.ruleId, at_s: f.at_s, ...(f.part ? { part: f.part } : {}), ...(f.channel ? { channel: f.channel } : {}),
  ...(f.value !== undefined ? { value: f.value } : {}), ...(f.limit !== undefined ? { limit: f.limit } : {}),
  message: f.message, fix: f.fix, docs: f.docs,
});

/** The sharpest moves, as finding-shaped beats: a part's speed against the speed cap, and a channel's share of its range crossed in one 30 fps frame (the whole range is a cut). */
const nearLimit = (cfg, name, deps) => {
  try {
    const { rig, meta } = deps.rig.loadRig(cfg, name);
    const s = deps.rig.sampleRig(rig, meta, meta.events || []);
    const cap = kindOf(meta) === 'interface' ? INTERFACE_SPEED_CAP : SPEED_CAP;
    const at = (i) => round(s.t_ms[i] / 1000, 3);
    const fix = 'start and stop it on an ease and give it a little more time, so it has room to settle';
    const parts = partSpeeds(s, meta).speeds.map(([part, series]) => {
      const peak = Math.max(0, ...series);
      return { share: peak / cap, beat: { rule: 'skac/speed-cap', near_limit: true, at_s: at(series.indexOf(peak)), part, value: round(peak, 4), limit: cap,
        message: `${part} reaches ${round((peak / cap) * 100, 0)}% of the speed limit`, fix, docs: 'motion/anticipation' } };
    });
    const w = Math.max(1, Math.round(s.fps / 30));
    const channels = Object.entries(s.channels).map(([channel, v]) => {
      const range = Math.max(...v) - Math.min(...v);
      let best = 0;
      let idx = 0;
      for (let i = w; i < v.length; i++) if (Math.abs(v[i] - v[i - w]) > best) { best = Math.abs(v[i] - v[i - w]); idx = i; }
      const share = range > 0 ? best / range : 0;
      return { share, beat: { rule: 'skac/abrupt', near_limit: true, at_s: at(idx), channel, value: round(share, 3), limit: 1,
        message: `${channel} covers ${round(share * 100, 0)}% of its range in one 30 fps frame`, fix, docs: 'motion/anticipation' } };
    });
    return [...parts, ...channels].filter((p) => p.share > 0).sort((a, b) => b.share - a.share).map((p) => p.beat);
  } catch {
    return [];
  }
};

/** The two weakest beats: measured findings by what they damage, then the sharpest moves. */
export const weakestBeats = (cfg, name, findings, deps) => {
  const rank = (f) => { const i = PRIORITY.indexOf(f.ruleId); return i < 0 ? PRIORITY.length : i; };
  const sorted = [...findings].sort((a, b) => rank(a) - rank(b) || (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1) || a.at_s - b.at_s);
  const out = [];
  for (const f of sorted) {
    if (out.length === WEAKEST) break;
    if (!out.some((o) => o.rule === f.ruleId && o.at_s === f.at_s)) out.push(beatOf(f));
  }
  if (out.length < WEAKEST) out.push(...nearLimit(cfg, name, deps).slice(0, WEAKEST - out.length));
  return out;
};

/**
 * `--check` with the draft gate: run the check, then answer as a draft when this is the scene's first check or the same rig and draw as the last
 * check that answered draft; any other check answers as the check does. `checkFn` is blind.js `check`.
 */
export const gatedCheck = (cfg, name, opts, deps, checkFn) => {
  const doc = checkFn(cfg, name, opts, deps);
  const hash = sourceHash(cfg, name, deps);
  if (!hash) return doc;
  const state = readState(cfg);
  const prev = state[name];
  const draft = !prev || (prev.draft && prev.hash === hash);
  state[name] = { hash, draft, ok: draft ? false : doc.ok };
  writeState(cfg, state);
  if (!draft) return doc;
  return {
    ok: false, draft: true, name, message: DRAFT_MESSAGE,
    weakest: weakestBeats(cfg, name, [...doc.failures, ...doc.warnings], deps),
    failures: doc.failures, warnings: doc.warnings.length,
    next: [`change the rig or draw to fix the beats above, then \`skac ${name} --check\` again`],
  };
};

/** `--export` waits for a passing check of the current rig and draw that came after a change. */
export const assertSettled = (cfg, name, deps) => {
  const s = readState(cfg)[name];
  const hash = sourceHash(cfg, name, deps);
  if (!s || s.draft) {
    fail(`${name} has had only its first draft check, so it is not exported`,
      `run \`skac ${name} --check\`, improve the two weakest beats it names, then check again (skac docs commands)`);
  }
  if (s.hash !== hash) fail(`${name} changed since its last --check, so it is not exported`, `run \`skac ${name} --check\` on this version, then export`);
  if (!s.ok) fail(`the last --check of ${name} did not pass, so it is not exported`, `fix its failures, run \`skac ${name} --check\`, then export`);
};
