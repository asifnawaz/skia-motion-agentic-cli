import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { boxProbe, check, lint, pixelProbe, ruleSeverities, stats, story } from '../../src/blind.js';
import * as rulesModule from '../../src/rules.js';
import { CliError } from '../../src/util.js';
import { tmp, write } from './helpers.js';

// A tiny project: one registered composition with a rig file beside it.
const project = (config = {}) => {
  const dir = tmp();
  write(join(dir, 'skia-motion.json'), JSON.stringify({ entry: 'src/index.ts', root: 'src/Root.tsx', out: 'out', ...config }));
  write(join(dir, 'src', 'Root.tsx'), `import { Composition } from 'remotion';
import { A } from './A';
export const Root = () => <>
  <Composition id="A" component={A} width={390} height={867} fps={30} durationInFrames={4} />
</>;
`);
  write(join(dir, 'src', 'A.tsx'), 'export const A = () => null;\n');
  write(join(dir, 'src', 'A.rig.ts'), '');
  return loadConfig(dir);
};

const T = [0, 100, 200, 300];
const samples = {
  fps: 10, t_ms: T,
  channels: { wide: [0, 0.5, 1, 1], lift: [0, 0, 0, 0] },
  parts: { body: { x: [0, 3, 6, 6], y: [0, 0, 4, 4], w: [10, 10, 10, 10], h: [10, 10, 10, 10] } },
};
const meta = { fps: 10, frames: 4, events: [{ name: 'tap', at: 0.1 }], beats: [{ name: 'shock', from_ms: 0, to_ms: 200, channel: 'wide' }] };

const finding = (ruleId, severity, extra = {}) => ({ ruleId, severity, message: `${ruleId} hit`, fix: 'fix it', docs: 'motion/body', ...extra });

/** Stubs: records what the commands passed to each module. */
const stubs = ({ lintFindings = [], ruleFindings = [], skipped = [], loadError, compare } = {}) => {
  const calls = { load: [], sample: [], lint: [], rules: [] };
  return {
    calls,
    deps: {
      rig: {
        loadRig: (cfg, name) => {
          calls.load.push(name);
          if (loadError) throw loadError;
          return { rig: () => ({ channels: {} }), meta, file: join(cfg.projectDir, 'src', `${name}.rig.ts`) };
        },
        sampleRig: (rig, m, events) => { calls.sample.push(events); return samples; },
      },
      lint: {
        lintFiles: (cfg, files, opts) => { calls.lint.push({ files, opts }); return { findings: lintFindings, fixed: opts.fix ? files.slice(0, 1) : [] }; },
      },
      rules: {
        runRules: (s, m, severities) => { calls.rules.push(severities); return { findings: ruleFindings, skipped }; },
        describe: () => ['0.00–0.20 s `wide` 0→1 (200 ms, ease-out)'],
      },
      compare: compare || { compareVideos: () => assert.fail('no render exists, compare must not run') },
    },
  };
};

test('stats summarises every channel and part: range, fastest frame and speed', () => {
  const cfg = project();
  const doc = stats(cfg, 'A', {}, stubs().deps);
  assert.equal(doc.ok, true);
  assert.deepEqual([doc.fps, doc.frames, doc.duration_s], [10, 4, 0.3]);
  assert.deepEqual(doc.channels.wide, { min: 0, max: 1, fastest_at_s: 0.1, fastest_speed_per_ms: 0.005 });
  assert.equal(doc.channels.lift.fastest_speed_per_ms, 0);
  assert.deepEqual(doc.parts.body.x, { min: 0, max: 6 });
  assert.equal(doc.parts.body.fastest_at_s, 0.2); // hypot(3, 4) = 5 pt in 100 ms
  assert.equal(doc.parts.body.fastest_speed_pt_per_ms, 0.05);
  assert.deepEqual(doc.events, [{ name: 'tap', at: 0.1 }]);
});

test('events: --commands events replace meta.events, and a missing rig is a CliError, not a crash', () => {
  const cfg = project();
  const { deps, calls } = stubs();
  stats(cfg, 'A', { events: [{ name: 'tap', at: 4 }] }, deps);
  stats(cfg, 'A', { events: [] }, deps);
  assert.deepEqual(calls.sample, [[{ name: 'tap', at: 4 }], meta.events]);
  assert.throws(() => stats(cfg, 'Nope', {}, deps), /no composition/);
});

test('story returns the lines from describe', () => {
  const doc = story(project(), 'A', {}, stubs().deps);
  assert.deepEqual(doc.lines, ['0.00–0.20 s `wide` 0→1 (200 ms, ease-out)']);
});

test('check merges lint, rig-rule and pixel layers; ok:false only for an error; warnings never fail', () => {
  const cfg = project({ rules: { 'skac/speed-cap': 'warn' } });
  const lintErr = finding('skac/no-random', 'error', { file: 'src/A.tsx', line: 3 });
  const ruleWarn = finding('skac/speed-cap', 'warn', { at_s: 0.2, part: 'body' });
  const ruleErr = finding('skac/overshoot', 'error', { channel: 'wide', at_s: 0.2, value: 1.2, limit: 1.05 });
  const { deps, calls } = stubs({ lintFindings: [lintErr], ruleFindings: [ruleWarn, ruleErr], skipped: [{ ruleId: 'skac/idle-cadence', missing: ['events'] }] });
  const doc = check(cfg, 'A', {}, deps);
  assert.equal(doc.ok, false);
  assert.deepEqual(doc.failures.map((f) => f.ruleId), ['skac/no-random', 'skac/overshoot']);
  assert.deepEqual(doc.warnings.map((f) => f.ruleId), ['skac/speed-cap']);
  assert.ok(doc.failures.every((f) => f.fix && f.docs));
  // lint got the composition and its rig; the rules got the config's severities.
  assert.deepEqual(calls.lint[0].files.map((f) => f.split('/').pop()), ['A.tsx', 'A.rig.ts']);
  assert.deepEqual(calls.lint[0].opts.severities, { 'skac/speed-cap': 'warn' });
  assert.deepEqual(calls.rules[0], { 'skac/speed-cap': 'warn' });
  // skipped: the rule's own, and the pixel layer with the command to run.
  assert.deepEqual(doc.skipped.map((s) => s.ruleId || s.layer), ['skac/idle-cadence', 'pixels']);
  assert.equal(doc.skipped[1].run, 'skac A --render');
  assert.equal(doc.pixels, undefined);
});

test('check passes with only warnings', () => {
  const doc = check(project(), 'A', {}, stubs({ ruleFindings: [finding('skac/speed-cap', 'warn')] }).deps);
  assert.equal(doc.ok, true);
  assert.deepEqual([doc.failures.length, doc.warnings.length], [0, 1]);
});

test('check adds the pixel layer when a render exists, and a blank frame is an error', () => {
  const cfg = project();
  mkdirSync(join(cfg.out, 'A'), { recursive: true });
  writeFileSync(join(cfg.out, 'A', 'A.mp4'), 'x');
  const row = { path: 'a.mp4', jerk: 0.4, peak: { ydif: 9 }, motion: {}, still_frames: 1, blank_frames: 2, spec_ok: true, probe: {} };
  const seen = [];
  const compare = { compareVideos: (paths, o) => { seen.push([paths, o]); return { videos: [row] }; } };
  const doc = check(cfg, 'A', {}, stubs({ compare }).deps);
  assert.equal(seen[0][1].event, 0.1);
  assert.equal(doc.pixels.jerk, 0.4);
  assert.equal(doc.ok, false);
  assert.equal(doc.failures[0].ruleId, 'skac/blank-frames');
  assert.ok(!doc.skipped.some((s) => s.layer === 'pixels'));
});

test('check reports a rig that will not load as a finding and still lints the composition', () => {
  const { deps, calls } = stubs({ loadError: new CliError('no rig file for A', 'write src/A.rig.ts') });
  const doc = check(project(), 'A', {}, deps);
  assert.equal(doc.ok, false);
  assert.equal(doc.failures[0].ruleId, 'skac/rig-load');
  assert.equal(doc.failures[0].fix, 'write src/A.rig.ts');
  assert.equal(calls.lint[0].files.length, 1);
  assert.equal(calls.rules.length, 0);
  assert.ok(doc.skipped.some((s) => s.layer === 'rig'));
});

test('check counts looks from views.jsonl and hints when one came before the checks passed', () => {
  const cfg = project();
  mkdirSync(cfg.out, { recursive: true });
  writeFileSync(join(cfg.out, 'views.jsonl'), [{ at: 'x', name: 'A', times: [1] }, { at: 'y', name: 'Other', times: [2] }].map((v) => JSON.stringify(v)).join('\n') + '\n');
  const failing = check(cfg, 'A', {}, stubs({ ruleFindings: [finding('skac/overshoot', 'error')] }).deps);
  assert.equal(failing.views, 1);
  assert.match(failing.hint, /check first; look once at the end with --sheet/);
  const passing = check(cfg, 'A', {}, stubs().deps);
  assert.equal(passing.views, 1);
  assert.equal(passing.hint, undefined);
});

test('lint defaults to every composition and its rig, passes --fix, and fails on an error finding', () => {
  const cfg = project();
  const { deps, calls } = stubs({ lintFindings: [finding('skac/no-wall-clock', 'error', { file: 'src/A.tsx', line: 1 })] });
  const doc = lint(cfg, [], { fix: true }, deps);
  assert.equal(doc.ok, false);
  assert.equal(doc.errors, 1);
  assert.equal(calls.lint[0].opts.fix, true);
  assert.deepEqual(calls.lint[0].files.map((f) => f.split('/').pop()), ['A.tsx', 'A.rig.ts']);
  assert.equal(lint(cfg, ['x.ts'], {}, stubs().deps).ok, true);
});

// A 390-wide still (scale 1, one pixel per pt) whatever the rig's meta.scale says.
const stillOf = (at) => ({ width: 390, height: 867, at });

test('probe=x,y reads AARRGGBB at points in pt, at the frame for --at, whatever meta.scale is', () => {
  const cfg = project();
  const seen = [];
  const deps = stubs().deps;
  deps.rig.loadRig = () => ({ rig: () => ({}), meta: { ...meta, scale: 2 }, file: 'x' });
  deps.pixels = {
    stillPixels: (c, name, o) => {
      seen.push(o);
      return stillOf((x, y) => (x < 390 && y < 867 ? (x < 100 ? 'FF57A5E0' : 'FF1E2A44') : null));
    },
  };
  const doc = pixelProbe(cfg, 'A', { points: '10,20;200,30', at: 0.5, events: [] }, deps);
  assert.deepEqual(doc.probes, [{ x: 10, y: 20, color: 'FF57A5E0' }, { x: 200, y: 30, color: 'FF1E2A44' }]);
  assert.deepEqual([doc.frame, doc.px_per_pt, seen[0].frame], [15, 1, 15]); // 0.5 s at 30 fps; 390 px over 390 pt
  assert.equal('ptScale' in seen[0], false);
  assert.throws(() => pixelProbe(cfg, 'A', { points: '500,10' }, deps), /outside the frame/);
  assert.throws(() => pixelProbe(cfg, 'A', { points: '10;20' }, deps), /bad probe point/);
  assert.throws(() => pixelProbe(cfg, 'A', { points: '' }, deps), (e) => /needs a point/.test(e.message) && /--stats/.test(e.hint));
});

test('probe-box lists the box\'s distinct colours by pixel count with share and bbox in pt', () => {
  const cfg = project();
  const deps = stubs().deps;
  deps.pixels = { stillPixels: () => stillOf((x, y) => (x >= 390 ? null : x >= 12 && x < 14 && y >= 21 && y < 23 ? 'FF57A5E0' : 'FF1E2A44')) };
  const doc = boxProbe(cfg, 'A', { box: '10,20,10,4', at: 0 }, deps);
  assert.equal(doc.pixels, 40);
  assert.deepEqual(doc.colors, [
    { color: 'FF1E2A44', pixels: 36, share: 0.9, bbox: [10, 20, 10, 4] },
    { color: 'FF57A5E0', pixels: 4, share: 0.1, bbox: [12, 21, 2, 2] },
  ]);
  assert.throws(() => boxProbe(cfg, 'A', { box: '10,20' }, deps), /bad probe box/);
  assert.throws(() => boxProbe(cfg, 'A', { box: '10,20,0,5' }, deps), /width and height/);
  assert.throws(() => boxProbe(cfg, 'A', { box: '900,20,5,5' }, deps), /outside the frame/);
});

test('stats reports the same windowed fastest speed the speed-cap rule measures', () => {
  const cfg = project();
  const deps = stubs().deps;
  // 120 Hz grid: one 20 pt step in 8.33 ms is 2.4 pt/ms per sample, but 0.6 pt/ms over the 33 ms window.
  const t_ms = Array.from({ length: 12 }, (_, i) => (i * 1000) / 120);
  const x = t_ms.map((_, i) => (i < 6 ? 0 : 20));
  const spike = { fps: 120, t_ms, channels: {}, parts: { body: { x, y: t_ms.map(() => 0), w: t_ms.map(() => 10), h: t_ms.map(() => 10) } } };
  deps.rig.sampleRig = () => spike;
  const fastest = stats(cfg, 'A', {}, deps).parts.body.fastest_speed_pt_per_ms;
  const rule = rulesModule.runRules(spike, meta, {}).findings.find((f) => f.ruleId === 'skac/speed-cap');
  assert.equal(fastest, rule.value);
  assert.equal(fastest, 0.6);
});

test('check without a spec says the beats are self-declared and never reads pixels', () => {
  const doc = check(project(), 'A', {}, stubs().deps); // the stubs have no deps.pixels: touching it would throw
  assert.equal(doc.spec.beats, 'self-declared');
  assert.match(doc.spec.note, /self-declared/);
  assert.equal(doc.ok, true);
});

const specProject = (spec) => {
  const cfg = project();
  write(join(cfg.projectDir, 'src', 'A.spec.json'), JSON.stringify(spec));
  return cfg;
};

test('check judges the spec: beats from the samples, points through the probe, parts through restSpec', () => {
  const cfg = specProject({
    parts: { body: { x: 0, y: 0, w: 10, h: 10 } },
    points: [{ name: 'eye', x: 10, y: 20, color: '#57A5E0' }, { name: 'shell', x: 200, y: 30, color: '#57A5E0', at: 0.5 }],
    beats: [
      { name: 'grow', channel: 'wide', direction: 'up', reaches: { channel: 'wide', min: 0.9 } },
      { name: 'drop', part: 'body', direction: 'up' }, // y rises: the body goes down
    ],
  });
  const { deps } = stubs();
  const frames = [];
  deps.pixels = { stillPixels: (c, n, o) => { frames.push(o.frame); return { width: 390, height: 867, at: (x) => (x < 100 ? 'FF57A5E0' : 'FF1E2A44') }; } };
  const rest = [];
  deps.rest = { restSpec: (c, name, spec, d) => { rest.push([name, Object.keys(spec.parts), Boolean(d.pixels)]); return { findings: [], skipped: [] }; } };
  const doc = check(cfg, 'A', {}, deps);
  assert.equal(doc.ok, false);
  assert.deepEqual(doc.failures.map((f) => [f.ruleId, f.beat ?? f.part]), [['skac/spec-beat', 'drop'], ['skac/spec-point', 'shell']]);
  assert.deepEqual(doc.spec.beats.map((b) => [b.name, b.met, b.reached]), [['grow', true, 1], ['drop', false, 4]]);
  assert.deepEqual(frames, [0, 15]); // one still per `at`: 0 s and 0.5 s at 30 fps
  assert.deepEqual(rest, [['A', ['body'], true]]);
});

test('check runs the real restSpec: a spec box off the drawing fails with its part', () => {
  const cfg = specProject({ parts: { body: { x: 100, y: 100, w: 50, h: 50 }, ghost: { x: 300, y: 300, w: 40, h: 40 } } });
  const { deps } = stubs();
  const inBody = (x, y) => x >= 100 && x <= 150 && y >= 100 && y <= 150;
  deps.pixels = { stillPixels: () => ({ width: 390, height: 867, at: (x, y) => (inBody(x, y) ? 'FF57A5E0' : 'FF1E2A44') }) };
  const doc = check(cfg, 'A', {}, deps);
  assert.deepEqual(doc.failures.map((f) => [f.ruleId, f.part]), [['skac/rest-spec', 'ghost']]);
});

test('story adds each spec beat with the value it reached', () => {
  const cfg = specProject({ beats: [{ name: 'grow', channel: 'wide', reaches: { channel: 'wide', min: 0.9 } }] });
  const doc = story(cfg, 'A', {}, stubs().deps);
  assert.equal(doc.lines.length, 2);
  assert.match(doc.lines[1], /^beat grow \(`wide`, 0–300 ms\): 0 → 1; `wide` reaches 1: met$/);
});

test('ruleSeverities reads cfg.rules, not the file', () => {
  assert.deepEqual(ruleSeverities({ rules: { 'skac/speed-cap': 'off' } }), { 'skac/speed-cap': 'off' });
  assert.deepEqual(ruleSeverities({}), {});
});
