// End-to-end: run the real CLI as a child process and assert on its one JSON document.
// SKIA_MOTION_E2E_PROJECT: a project with node_modules installed. When unset, `create` makes one in a temp
// dir and `npm install` fills it (CI). The project is left as found: the Root file is restored and the
// added composition removed. Output goes to a temp dir through --out-dir.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'skac.js');
const scratch = mkdtempSync(join(process.env.SKIA_MOTION_SCRATCH || tmpdir(), 'skac-e2e-'));
const OUT = join(scratch, 'out');
const NAME = 'E2eSmoke';
let project = process.env.SKIA_MOTION_E2E_PROJECT;
let rootBackup;
let rootPath;

/** Run the CLI; stdout must be exactly one JSON document. */
const skac = (args, cwd = project) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  let doc;
  try { doc = JSON.parse(r.stdout); } catch { assert.fail(`stdout is not one JSON document:\n${r.stdout}\n${r.stderr}`); }
  return { doc, code: r.status, stderr: r.stderr };
};
const ok = (args, cwd) => {
  const r = skac(args, cwd);
  assert.equal(r.doc.ok, true, JSON.stringify(r.doc).slice(0, 800));
  assert.equal(r.code, 0);
  return r.doc;
};

before(() => {
  if (!project) {
    project = join(scratch, 'project');
    const made = ok(['create', project], scratch);
    assert.ok(made.files.includes('src/Root.tsx'));
    const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: project, encoding: 'utf8' });
    assert.equal(npm.status, 0, npm.stderr);
  }
  rootPath = join(project, 'src', 'Root.tsx');
  rootBackup = readFileSync(rootPath, 'utf8');
});

after(() => {
  if (rootBackup !== undefined) writeFileSync(rootPath, rootBackup);
  const file = join(project, 'src', `${NAME}.tsx`);
  if (existsSync(file)) unlinkSync(file);
  const rigFile = join(project, 'src', `${NAME}.rig.ts`);
  if (existsSync(rigFile)) unlinkSync(rigFile);
});

const outFlag = ['--out-dir', OUT];

test('create scaffolds a project and refuses a non-empty directory', () => {
  const dir = join(scratch, 'fresh');
  const d = ok(['create', dir], scratch);
  assert.ok(d.files.includes('src/Root.tsx') && d.files.includes('skia-motion.json'));
  assert.deepEqual(d.next.slice(0, 1), ['npm install']);
  const again = skac(['create', dir], scratch);
  assert.equal(again.code, 1);
  assert.equal(again.doc.ok, false);
  assert.ok(again.doc.hint.includes('--force'));
  assert.equal(skac(['create', dir, '--force'], scratch).code, 0);
});

test('samples lists bundled examples and copies one', () => {
  const list = ok(['samples'], scratch);
  assert.ok(list.samples.some((s) => s.name === 'character' && s.files.length > 0));
  const copy = ok(['samples', 'character', join(scratch, 'from-sample')], scratch);
  assert.ok(copy.files.includes('src/Root.tsx'));
  assert.equal(skac(['samples', 'nope'], scratch).code, 1);
});

test('doctor reports every check ok', () => {
  const d = ok(['doctor', ...outFlag]);
  for (const c of d.checks) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
});

test('docs: index, a topic, search, and the read log', () => {
  const idx = ok(['docs', ...outFlag]);
  assert.ok(idx.index.lines > 0 && idx.topics.length > 0);
  const t = ok(['docs', idx.topics[0].name, '--as', 'e2e', ...outFlag]);
  assert.equal(t.lines, idx.topics[0].lines);
  const s = ok(['docs', '--search', 'motion', ...outFlag]);
  assert.ok(s.hits.length > 0);
  const log = readFileSync(join(OUT, 'docs-reads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.at(-1).as, 'e2e');
});

test('schema lists Skia components and describes Group', () => {
  assert.ok(ok(['schema']).components.some((c) => c.name === 'Group'));
  const g = ok(['schema', 'Group']);
  assert.ok(g.props.length > 0);
});

test('add registers a composition; inspect and a bare name describe it', () => {
  const a = ok(['add', NAME]);
  assert.equal(a.registered.frames, 480);
  const i = ok(['inspect', NAME]);
  assert.deepEqual([i.width, i.height, i.fps], [390, 867, 60]);
  assert.equal(i.reads_events, true);
  assert.ok(ok(['inspect']).compositions.some((c) => c.id === NAME));
  assert.ok(ok([NAME]).next.length >= 3);
});

test('--verify renders frame 0', () => {
  const d = ok([NAME, '--verify', ...outFlag]);
  assert.ok(existsSync(join(OUT, NAME, 'verify.png')) && d.bytes > 1000);
});

test('--commands "tap@1.0" --screenshot --sheet', () => {
  const d = ok([NAME, '--commands', 'tap@1.0', '--screenshot', '--at=0.5,2.0', '--sheet', ...outFlag]);
  assert.equal(d.captures.length, 2);
  for (const c of d.captures) assert.ok(existsSync(resolve(project, c.path)) || existsSync(resolve(c.path)) || existsSync(join(OUT, NAME, `${c.t}.png`)));
  assert.ok(existsSync(join(OUT, NAME, 'sheet.png')));
});

test('--screenshot --advance and a commands file', () => {
  const one = ok([NAME, '--screenshot', '--advance=1', ...outFlag]);
  assert.deepEqual(one.captures.map((c) => c.t), [1]);
  const file = join(scratch, 'run.txt');
  writeFileSync(file, 'event tap 1.0\nadvance 0.5\nscreenshot\nadvance 1\nscreenshot\n');
  const d = ok([NAME, '--commands', file, ...outFlag]);
  assert.deepEqual(d.captures.map((c) => c.t), [0.5, 1.5]);
});

test('--render compares clean: spec ok, no blank frames', () => {
  const d = ok([NAME, '--render', '--scale', '1', '--commands', 'tap@1.0', ...outFlag, '--out', join(OUT, 'smoke.mp4')]);
  const v = d.compare.videos[0];
  assert.equal(v.blank_frames, 0);
  assert.equal(v.spec_ok, true);
  assert.deepEqual([v.probe.width, v.probe.height], [390, 866]); // odd sides round down to even for h264
  const again = ok(['compare', join(OUT, 'smoke.mp4'), '--event', '1.0']);
  assert.equal(again.videos[0].jerk, v.jerk);
});

test('a bad name is ok:false with a hint and exit 1', () => {
  const r = skac(['NoSuchComposition']);
  assert.equal(r.code, 1);
  assert.equal(r.doc.ok, false);
  assert.match(r.doc.error, /no composition/);
  assert.ok(r.doc.hint);
  assert.equal(r.stderr, '');
  assert.equal(skac(['--bogus']).code, 1);
});
