import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintFiles } from '../../src/lint.js';
import { LINT_RULES } from '../../src/lint-rules.js';
import { CliError } from '../../src/util.js';
import { tmp, write } from './helpers.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'lint');
const cfg = { projectDir: FIX };
const lint = (name, opts) => lintFiles(cfg, [join(FIX, name)], opts);
const ids = (r) => r.findings.map((f) => f.ruleId);

test('every rule has one failing and one passing fixture', () => {
  for (const id of Object.keys(LINT_RULES)) {
    if (id === 'skac/disable-needs-reason') continue; // tested below with the disable comments
    const name = id.replace('skac/', '');
    const bad = lint(`${name}.fail.tsx`, { severities: { [id]: 'warn' } }); // turns on rules that default to off
    assert.ok(ids(bad).includes(id), `${name}.fail.tsx should break ${id}`);
    const good = lint(`${name}.pass.tsx`);
    assert.deepEqual(ids(good), [], `${name}.pass.tsx should be clean, got ${JSON.stringify(good.findings)}`);
  }
  assert.deepEqual(lint('clean.pass.tsx').findings, []);
});

test('a finding has the shared shape: rule, severity, message, fix, docs, file, line and column', () => {
  const [f] = lint('no-wall-clock.fail.tsx').findings;
  assert.deepEqual(f, {
    ruleId: 'skac/no-wall-clock',
    severity: 'error',
    message: 'Date.now() reads the wall clock; the render and the app must agree on t',
    fix: LINT_RULES['skac/no-wall-clock'].fix,
    docs: 'motion/principles',
    file: 'no-wall-clock.fail.tsx',
    line: 1,
    column: 24,
    value: 'Date.now',
  });
});

test('no-wall-clock finds all four clocks; defaults are error for rules the order names so', () => {
  assert.equal(lint('no-wall-clock.fail.tsx').findings.length, 4);
  const sev = Object.fromEntries(Object.entries(LINT_RULES).map(([k, v]) => [k, v.default]));
  assert.equal(sev['skac/no-magic-motion'], 'off');
  assert.equal(sev['skac/no-face-swap'], 'warn');
  for (const id of ['no-wall-clock', 'no-random', 'no-hand-easing', 'no-bouncy-spring', 'no-text-in-character']) assert.equal(sev[`skac/${id}`], 'error');
});

test('no-hand-easing finds bezier literals, Easing.*, a bezier array and a cubic-bezier string; motion.ts is exempt', () => {
  const r = lint('no-hand-easing.fail.tsx');
  assert.equal(r.findings.filter((f) => f.ruleId === 'skac/no-hand-easing').length, 5); // bezier(), Easing.out, Easing.cubic, array, string
  const dir = tmp('lint-motion-');
  write(join(dir, 'motion.ts'), 'export const EASE_OUT = bezier(0.23, 1, 0.32, 1);\n');
  assert.deepEqual(lintFiles({ projectDir: dir }, [join(dir, 'motion.ts')]).findings, []);
});

test('no-bouncy-spring reports the bounce value and allows 0.05', () => {
  const [f] = lint('no-bouncy-spring.fail.tsx').findings;
  assert.equal(f.value, 0.3);
});

test('no-text-in-character fires only when a .rig.ts sibling exists', () => {
  assert.ok(ids(lint('no-text-in-character.fail.tsx')).includes('skac/no-text-in-character'));
  const dir = tmp('lint-text-');
  write(join(dir, 'Pip.tsx'), 'export const P = () => <Paragraph />;\n');
  assert.deepEqual(lintFiles({ projectDir: dir }, [join(dir, 'Pip.tsx')]).findings, []);
  write(join(dir, 'Pip.rig.ts'), 'export const rig = () => ({ channels: {} });\n');
  assert.equal(lintFiles({ projectDir: dir }, [join(dir, 'Pip.tsx')]).findings.length, 1);
});

test('no-magic-motion is off by default; turned on, it reports each literal other than 0, 1, 2', () => {
  assert.deepEqual(lint('no-magic-motion.fail.tsx').findings.filter((f) => f.ruleId === 'skac/no-magic-motion'), []);
  const r = lint('no-magic-motion.fail.tsx', { severities: { 'skac/no-magic-motion': 'warn' } });
  assert.deepEqual(r.findings.map((f) => f.value), [4200, 4600, 4600, 4900, 30]);
  assert.ok(r.findings.every((f) => f.severity === 'warn'));
});

test('no-face-swap sees a path-string swap and a JSX swap, both on time conditions', () => {
  const r = lint('no-face-swap.fail.tsx');
  assert.deepEqual(r.findings.map((f) => f.value), ['jsx', 'path']);
});

test('severities: off hides a rule, warn and error change the level', () => {
  assert.deepEqual(lint('no-wall-clock.fail.tsx', { severities: { 'skac/no-wall-clock': 'off' } }).findings, []);
  assert.equal(lint('no-wall-clock.fail.tsx', { severities: { 'skac/no-wall-clock': 'warn' } }).findings[0].severity, 'warn');
  assert.equal(lint('no-magic-motion.fail.tsx', { severities: { 'skac/no-magic-motion': 'error' } }).findings[0].severity, 'error');
  assert.throws(() => lint('no-wall-clock.fail.tsx', { severities: { 'skac/no-wall-clock': 'loud' } }), CliError);
});

test('a disable comment with a reason silences the next line', () => {
  assert.deepEqual(lint('disable-with-reason.tsx').findings, []);
});

test('a disable comment without a reason is an error and disables nothing', () => {
  const r = lint('disable-bare.tsx');
  assert.deepEqual(ids(r), ['skac/disable-needs-reason', 'skac/no-wall-clock']);
  assert.equal(r.findings[0].severity, 'error');
  assert.equal(r.findings[0].line, 1);
});

test('a disable names its rule: another rule on the line is not silenced', () => {
  const dir = tmp('lint-dis-');
  const p = join(dir, 'a.ts');
  write(p, '// skac-disable-next-line skac/no-random -- seeded elsewhere\nexport const a = Date.now();\n');
  assert.deepEqual(ids(lintFiles({ projectDir: dir }, [p])), ['skac/no-wall-clock']);
});

test('--fix rewrites Math.random() to seeded(i) and adds the import', () => {
  const dir = tmp('lint-fix-');
  mkdirSync(join(dir, 'src', 'motion'), { recursive: true });
  const p = join(dir, 'src', 'Fx.tsx');
  copyFileSync(join(FIX, 'no-random.fail.tsx'), p);
  const r = lintFiles({ projectDir: dir }, [p], { fix: true });
  assert.deepEqual(r.fixed, [p]);
  assert.deepEqual(r.findings, []);
  const out = readFileSync(p, 'utf8');
  assert.match(out, /import \{ seeded \} from '\.\/motion\/motion';/);
  assert.match(out, /export const a = \(\) => seeded\(0\);/);
  assert.match(out, /export const b = \(\) => seeded\(1\) \* 2;/);
  assert.doesNotMatch(out, /Math\.random/);
  // a second run has nothing left to fix
  assert.deepEqual(lintFiles({ projectDir: dir }, [p], { fix: true }).fixed, []);
});

test('--fix does not duplicate an existing seeded import and leaves other findings', () => {
  const dir = tmp('lint-fix2-');
  const p = join(dir, 'a.ts');
  write(p, "import { seeded } from './motion/motion';\nexport const a = Math.random() + Date.now();\n");
  const r = lintFiles({ projectDir: dir }, [p], { fix: true });
  assert.equal(readFileSync(p, 'utf8').match(/import/g).length, 1);
  assert.deepEqual(ids(r), ['skac/no-wall-clock']);
});

test('--fix skips a Math.random() that a disable comment silences', () => {
  const dir = tmp('lint-fix3-');
  const p = join(dir, 'a.ts');
  write(p, '// skac-disable-next-line skac/no-random -- a debug seed\nexport const a = Math.random();\n');
  assert.deepEqual(lintFiles({ projectDir: dir }, [p], { fix: true }).fixed, []);
  assert.match(readFileSync(p, 'utf8'), /Math\.random\(\)/);
});

test('a missing file is a clear error', () => {
  assert.throws(() => lintFiles(cfg, [join(FIX, 'nope.tsx')]), /does not exist/);
});
