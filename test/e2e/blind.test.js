// End-to-end for the blind-mode commands, against a project with node_modules installed:
//   SKIA_MOTION_E2E_PROJECT=/path/to/a/skac/project node --test test/e2e/blind.test.js
// With no project set, `create` makes one in a temp dir and `npm install` fills it. The project's files are left as found.
// It needs a Character composition with src/Character.rig.ts (the starter has one).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'skac.js');
const scratch = mkdtempSync(join(process.env.SKIA_MOTION_SCRATCH || tmpdir(), 'skac-blind-e2e-'));
const OUT = join(scratch, 'out');
const NAME = 'E2eBlind';
let project = process.env.SKIA_MOTION_E2E_PROJECT;
let rootBackup;

const skac = (args, cwd = project) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  let doc;
  try { doc = JSON.parse(r.stdout); } catch { assert.fail(`stdout is not one JSON document:\n${r.stdout}\n${r.stderr}`); }
  return { doc, code: r.status };
};
const ok = (args, cwd) => {
  const r = skac(args, cwd);
  assert.equal(r.doc.ok, true, JSON.stringify(r.doc).slice(0, 1200));
  assert.equal(r.code, 0);
  return r.doc;
};
const outFlag = ['--out-dir', OUT];

before(() => {
  if (!project) {
    project = join(scratch, 'project');
    ok(['create', project], scratch);
    const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: project, encoding: 'utf8' });
    assert.equal(npm.status, 0, npm.stderr);
  }
  rootBackup = readFileSync(join(project, 'src', 'Root.tsx'), 'utf8');
});

after(() => {
  writeFileSync(join(project, 'src', 'Root.tsx'), rootBackup);
  for (const f of [`${NAME}.tsx`, `${NAME}.rig.ts`]) if (existsSync(join(project, 'src', f))) unlinkSync(join(project, 'src', f));
});

test('help lists the blind-mode verbs', () => {
  const text = JSON.stringify(ok(['--help'], scratch).commands);
  for (const word of ['--stats', '--probe=x,y', '--story', '--check', 'lint', 'update']) assert.ok(text.includes(word), word);
});

test('--stats samples the rig without rendering', () => {
  const d = ok(['Character', '--stats', ...outFlag]);
  assert.equal(d.fps, 60);
  assert.equal(d.frames, 480);
  assert.ok(Object.keys(d.channels).length > 0);
  for (const c of Object.values(d.channels)) {
    assert.ok(c.max >= c.min && c.fastest_at_s >= 0 && c.fastest_speed_per_ms >= 0);
  }
  // The starter's spec asks the hop to reach a lift; --stats must see the same peak --check judges.
  const spec = JSON.parse(readFileSync(join(project, 'src', 'Character.spec.json'), 'utf8'));
  const reach = spec.beats.find((b) => b.reaches && b.reaches.channel === 'lift').reaches.min;
  assert.ok(d.channels.lift.max >= reach, `the tap hop lifts the body to at least ${reach}`);
  assert.ok(!existsSync(join(OUT, 'Character')), 'stats renders nothing');
});

test('--probe=x,y --at=0 reads the background colour in AARRGGBB from one still', () => {
  const d = ok(['Character', '--probe=5,5;195,475', '--at=0', ...outFlag]);
  assert.equal(d.probes.length, 2);
  for (const p of d.probes) assert.match(p.color, /^[0-9A-F]{8}$/);
  assert.equal(d.probes[0].color, 'FF1E2A44', 'the starter background');
  assert.notEqual(d.probes[1].color, d.probes[0].color, 'the body centre is not background');
});

test('--story prints the motion as text lines', () => {
  const d = ok(['Character', '--story', ...outFlag]);
  assert.ok(Array.isArray(d.lines) && d.lines.length > 0);
  assert.ok(d.lines.some((l) => /lift/.test(l)));
});

test('--check on the starter: ok, every finding carries its fix and doc, no render means a skipped pixel layer', () => {
  const r = skac(['Character', '--check', ...outFlag]);
  assert.equal(r.code, r.doc.ok ? 0 : 1);
  assert.equal(r.doc.ok, true, JSON.stringify(r.doc.failures).slice(0, 1200));
  for (const f of [...r.doc.failures, ...r.doc.warnings]) assert.ok(f.ruleId && f.fix && f.docs, JSON.stringify(f));
  assert.ok(r.doc.skipped.some((s) => s.layer === 'pixels' && s.run === 'skac Character --render'));
  assert.equal(r.doc.views, 0);
});

test('--check on the starter runs the rest-pose check on a real still: no skac/rest-spec skipped, no errors', () => {
  const r = skac(['Character', '--check', ...outFlag]);
  writeFileSync(join(scratch, 'character-check.json'), JSON.stringify(r.doc, null, 2));
  assert.ok(r.doc.spec && r.doc.spec.file, 'the starter ships Character.spec.json');
  const restSkipped = r.doc.skipped.filter((s) => s.ruleId === 'skac/rest-spec');
  assert.deepEqual(restSkipped, [], JSON.stringify(restSkipped));
  const errors = r.doc.failures.filter((f) => f.severity === 'error');
  assert.deepEqual(errors, [], JSON.stringify(errors).slice(0, 1200));
});

test('a spec whose body box is shifted 6 pt fails skac/rest-spec with part body', () => {
  // A second composition on the same component, so the shifted spec is a temp file and the real spec is untouched.
  const SHIFT = 'E2eShift';
  const src = join(project, 'src');
  const temp = [join(src, `${SHIFT}.spec.json`), join(src, `${SHIFT}.rig.ts`)];
  const root = join(src, 'Root.tsx');
  const rootText = readFileSync(root, 'utf8');
  try {
    const spec = JSON.parse(readFileSync(join(src, 'Character.spec.json'), 'utf8'));
    spec.parts.body.x += 6;
    writeFileSync(temp[0], JSON.stringify(spec, null, 2));
    writeFileSync(temp[1], readFileSync(join(src, 'Character.rig.ts'), 'utf8'));
    const line = rootText.match(/^.*<Composition id="Character"[^\n]*$/m)[0];
    writeFileSync(root, rootText.replace(line, `${line}\n${line.replace('id="Character"', `id="${SHIFT}"`)}`));
    const r = skac([SHIFT, '--check', ...outFlag]);
    writeFileSync(join(scratch, 'shift-check.json'), JSON.stringify(r.doc, null, 2));
    assert.equal(r.code, 1);
    assert.equal(r.doc.ok, false);
    const hit = r.doc.failures.find((f) => f.ruleId === 'skac/rest-spec' && f.part === 'body');
    assert.ok(hit, JSON.stringify(r.doc.failures).slice(0, 1200));
  } finally {
    writeFileSync(root, rootText);
    for (const f of temp) if (existsSync(f)) unlinkSync(f);
  }
});

test('--check fails with a fix when a composition reads the wall clock; lint --fix rewrites a random call', () => {
  ok(['add', NAME]);
  const file = join(project, 'src', `${NAME}.tsx`);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace('const { fps, width, height } = useVideoConfig();', 'const { fps, width, height } = useVideoConfig();\n  const wobble = Math.random() + Date.now();'));
  const r = skac([NAME, '--check', ...outFlag]);
  assert.equal(r.code, 1);
  assert.equal(r.doc.ok, false);
  const hit = r.doc.failures.find((f) => f.ruleId === 'skac/no-wall-clock');
  assert.ok(hit && hit.fix && hit.line > 0, JSON.stringify(r.doc.failures));
  // --fix rewrites Math.random to seeded(i); Date.now has no safe rewrite, so it stays an error.
  const fixed = skac(['lint', file, '--fix', ...outFlag]);
  assert.equal(fixed.code, 1);
  assert.ok(fixed.doc.fixed.length > 0);
  assert.ok(!readFileSync(file, 'utf8').includes('Math.random'));
});

test('add writes a rig file beside the composition, and the new rig loads and checks clean', () => {
  const rig = join(project, 'src', `${NAME}.rig.ts`);
  assert.ok(existsSync(rig));
  assert.match(readFileSync(rig, 'utf8'), /export function rig\(/);
  const file = join(project, 'src', `${NAME}.tsx`);
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\n  const wobble = [^\n]*/, ''));
  const d = ok([NAME, '--check', ...outFlag]);
  assert.equal(d.failures.length, 0);
});

test('lint with no files covers every composition and its rig', () => {
  const d = ok(['lint', ...outFlag]);
  assert.ok(d.files.some((f) => f.endsWith('Character.rig.ts')) && d.files.some((f) => f.endsWith(`${NAME}.rig.ts`)));
});

test('--screenshot logs a look that --check then counts', () => {
  ok(['Character', '--screenshot', '--at=0.5', ...outFlag]);
  const log = readFileSync(join(OUT, 'views.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.at(-1).times, [0.5]);
  assert.equal(log.at(-1).name, 'Character');
  assert.equal(ok(['Character', '--check', ...outFlag]).views, 1);
});

test('--check adds pixel facts once a render exists', () => {
  const rendered = ok(['Character', '--render', '--scale', '1', '--commands', 'tap@4.0', ...outFlag]);
  writeFileSync(join(scratch, 'character-render.json'), JSON.stringify(rendered.compare ?? rendered, null, 2));
  const d = skac(['Character', '--check', ...outFlag]).doc;
  assert.ok(d.pixels && d.pixels.blank_frames === 0, JSON.stringify(d.pixels));
});

test('update reports every managed file as same, updated, kept-edited or added', () => {
  const d = ok(['update', '--check', ...outFlag]);
  assert.ok(Array.isArray(d.files) && d.files.every((f) => ['same', 'updated', 'kept-edited', 'added'].includes(f.state)));
});
