import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from './util.js';
import { shown } from './docs.js';

const versionOf = (cmd) => {
  const r = run(cmd, ['-version']);
  return r.code === 0 ? (r.stdout.split('\n')[0] || '').trim() : null;
};

const findModule = (start, name) => {
  let dir = start;
  for (;;) {
    const p = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')).version;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
};

const check = (name, ok, detail, fix) => ({ name, ok, detail, ...(ok ? {} : { fix }) });

/** Mirrors rive's doctor: version, environment, project, and GL/Chrome in place of devices. */
export const doctor = (cfg, version) => {
  const major = Number(process.versions.node.split('.')[0]);
  const ff = versionOf('ffmpeg');
  const fp = versionOf('ffprobe');
  const rem = findModule(cfg.projectDir, 'remotion');
  const sk = findModule(cfg.projectDir, '@shopify/react-native-skia');
  let writable = false;
  try {
    mkdirSync(cfg.out, { recursive: true });
    const t = join(cfg.out, '.doctor-write-test');
    writeFileSync(t, 'x');
    rmSync(t);
    writable = true;
  } catch { /* reported below */ }
  const checks = [
    check('node', major >= 18, process.versions.node, 'install Node 18 or newer'),
    check('remotion', !!rem, rem ? `remotion ${rem}` : 'not installed', 'run `npm install` in the project directory'),
    check('skia', !!sk, sk ? `@shopify/react-native-skia ${sk}` : 'not installed', 'run `npm install` in the project directory'),
    check('ffmpeg', !!ff, ff || 'not on PATH', 'install ffmpeg and put it on PATH'),
    check('ffprobe', !!fp, fp || 'not on PATH', 'install ffprobe (it ships with ffmpeg) and put it on PATH'),
    check('entry', existsSync(cfg.entry), shown(cfg.entry), 'set "entry" in skia-motion.json or run `skac create`'),
    check('root', existsSync(cfg.root), shown(cfg.root), 'set "root" in skia-motion.json or run `skac create`'),
    check('out', writable, shown(cfg.out), 'make the out directory writable or set "out"'),
  ];
  // Chrome for headless GL: report only, never download.
  let chrome = { name: 'chrome', ok: false, detail: 'skipped: remotion is not installed', fix: 'run `npm install` first' };
  if (rem) {
    const r = run('npx', ['--no-install', 'remotion', 'browser', 'ensure'], { cwd: cfg.projectDir, env: { ...process.env, REMOTION_DISABLE_TELEMETRY: '1' } });
    const out = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-3).join(' | ');
    chrome = check('chrome', r.code === 0, out || 'ok', 'run `npx remotion browser ensure` in the project directory');
  }
  checks.push(chrome);
  const missing = checks.filter((c) => !c.ok);
  return {
    ok: missing.length === 0,
    version,
    environment: { node: process.versions.node, platform: process.platform, gl: cfg.gl },
    project: { dir: shown(cfg.projectDir), config: cfg.configPath ? shown(cfg.configPath) : null, entry: shown(cfg.entry), root: shown(cfg.root), out: shown(cfg.out) },
    checks,
    ...(missing.length ? { fix: missing.map((c) => c.fix) } : {}),
  };
};
