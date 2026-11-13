import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fail, now, run, tail } from './util.js';
import { compareVideos } from './compare.js';
import { find } from './project.js';
import { shown } from './docs.js';

const remotion = (cfg, args) => run('npx', ['remotion', ...args], { cwd: cfg.projectDir, env: { ...process.env, REMOTION_DISABLE_TELEMETRY: '1' } });

const mustRun = (r, what) => {
  if (r.code !== 0) fail(`${what} failed`, 'read output_tail; run `skac doctor` if it mentions Chrome, GL or a missing module', { output_tail: tail(r) });
};

const propsArgs = (events) => (events && events.length ? [`--props=${JSON.stringify({ events })}`] : []);

const outDir = (cfg, name) => {
  const d = join(cfg.out, name);
  mkdirSync(d, { recursive: true });
  return d;
};

/** `<Name> --verify`: frame 0 as a still. */
export const verify = (cfg, name, { events } = {}) => {
  find(cfg, name);
  const file = join(outDir(cfg, name), 'verify.png');
  const r = remotion(cfg, ['still', cfg.entry, name, file, '--frame=0', `--gl=${cfg.gl}`, ...propsArgs(events)]);
  mustRun(r, `rendering frame 0 of ${name}`);
  return { ok: true, name, still: shown(file), bytes: statSync(file).size, next: [`skac ${name} --screenshot --at=0.5 --sheet`] };
};

/** RGBA bytes of a PNG, decoded by ffmpeg (no image library). */
const decode = (png) => {
  const size = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', png]);
  const [width, height] = size.stdout.trim().split(',').map(Number);
  if (!(width > 0 && height > 0)) fail(`could not read the size of ${shown(png)}`, 'run `skac doctor`', { output_tail: tail(size) });
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { maxBuffer: 1 << 28 });
  if (r.status !== 0 || r.stdout.length < width * height * 4) fail(`could not decode ${shown(png)}`, 'run `skac doctor`');
  return { width, height, data: r.stdout };
};

const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/** Colour at a pixel as rive prints it: AARRGGBB. */
export const colorAt = (img, px, py) => {
  const i = (py * img.width + px) * 4;
  const [r, g, b, a] = img.data.subarray(i, i + 4);
  return `${hex2(a)}${hex2(r)}${hex2(g)}${hex2(b)}`;
};

/**
 * One still of `name` at `frame`, scale 1, decoded. `ptScale` (meta.scale, px per pt) turns points into pixels.
 * Returns `at(xPt, yPt)` -> AARRGGBB, or null when the point is outside the frame.
 */
export const stillPixels = (cfg, name, { frame = 0, events, ptScale = 1 } = {}) => {
  find(cfg, name);
  const file = join(outDir(cfg, name), `probe-${frame}.png`);
  mustRun(remotion(cfg, ['still', cfg.entry, name, file, `--frame=${frame}`, `--gl=${cfg.gl}`, '--scale=1', ...propsArgs(events)]), `rendering frame ${frame} of ${name}`);
  const img = decode(file);
  const at = (x, y) => {
    const px = Math.floor(x * ptScale);
    const py = Math.floor(y * ptScale);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
    return colorAt(img, px, py);
  };
  return { file, width: img.width, height: img.height, at };
};

/** Every `--screenshot` is a look; `--check` counts them and warns when one came before the checks passed. */
export const viewsFile = (cfg) => join(cfg.out, 'views.jsonl');
const logView = (cfg, name, times) => {
  mkdirSync(cfg.out, { recursive: true });
  appendFileSync(viewsFile(cfg), JSON.stringify({ at: now(), name, times }) + '\n');
};

const label = (t) => `${t}s`;

/** `<Name> --screenshot`: one preview render at scale 1, then a PNG per time, optionally a labelled sheet. */
export const screenshot = (cfg, name, { times, sheet, events }) => {
  find(cfg, name);
  if (!times.length) fail('no times to capture', 'pass --at=0.5,4.0, --advance=1, or a commands file with `screenshot` lines');
  const dir = outDir(cfg, name);
  const preview = join(dir, 'preview.mp4');
  mustRun(remotion(cfg, ['render', cfg.entry, name, preview, `--gl=${cfg.gl}`, '--scale=1', ...propsArgs(events)]), `rendering ${name}`);
  const captures = [];
  const abs = [];
  for (const t of times) {
    const png = join(dir, `${t}.png`);
    const r = run('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', preview, '-frames:v', '1', png]);
    if (r.code !== 0 || !existsSync(png)) fail(`no frame at ${t}s`, 'the time is past the end of the composition; check `inspect` for frames and fps', { output_tail: tail(r) });
    captures.push({ t, path: shown(png) });
    abs.push(png);
  }
  logView(cfg, name, times);
  const doc = { ok: true, name, preview: shown(preview), captures };
  if (sheet) {
    const out = join(dir, 'sheet.png');
    const inputs = abs.flatMap((p) => ['-i', p]);
    const filters = captures.map((c, i) => `[${i}:v]drawtext=text='${label(c.t)}':x=12:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6[v${i}]`);
    const stack = `${captures.map((_, i) => `[v${i}]`).join('')}hstack=inputs=${captures.length}`;
    let r = run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${filters.join(';')};${stack}`, out]);
    if (r.code !== 0) {
      // ffmpeg builds without drawtext still get a plain sheet.
      r = run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${captures.map((_, i) => `[${i}:v]`).join('')}hstack=inputs=${captures.length}`, out]);
      doc.sheet_labels = false;
    }
    if (r.code !== 0) fail('could not build the sheet', 'run `skac doctor`', { output_tail: tail(r) });
    doc.sheet = shown(out);
  }
  return doc;
};

/** `<Name> --render`: the full mp4 at `scale`, then compare. */
export const render = (cfg, name, { out, scale = 2, events, event }) => {
  const reg = find(cfg, name);
  const file = out ? resolve(out) : join(outDir(cfg, name), `${name}.mp4`);
  mkdirSync(dirname(file), { recursive: true });
  mustRun(remotion(cfg, ['render', cfg.entry, name, file, `--gl=${cfg.gl}`, `--scale=${scale}`, ...propsArgs(events)]), `rendering ${name}`);
  const known = reg.width && reg.height && reg.fps && reg.frames;
  const even = (n) => n - (n % 2); // h264 yuv420p output has even sides
  const expect = known ? `${even(Math.round(reg.width * scale))}x${even(Math.round(reg.height * scale))}@${reg.fps}/${Math.round((reg.frames / reg.fps) * 1000) / 1000}` : 'none';
  const cmp = compareVideos([file], { event: event ?? events?.[0]?.at ?? 4.0, expect });
  return { ok: cmp.ok, name, path: shown(file), scale, compare: cmp };
};
