import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { fail, round, run } from './util.js';
import { shown } from './docs.js';

export const STILL = 0.05;
export const BLANK_LUMA = 200.0;

/** @param {string} path */
export const probe = (path) => {
  const r = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,r_frame_rate,codec_name,pix_fmt:format=duration', '-of', 'json', path]);
  if (r.code !== 0) fail(`ffprobe failed on ${path}`, 'run `skac doctor`; the file must be a video');
  const data = JSON.parse(r.stdout);
  const s = data.streams[0];
  const [num, den] = s.r_frame_rate.split('/').map(Number);
  return {
    width: s.width, height: s.height, fps: round(num / den, 3),
    duration: round(Number(data.format.duration), 3), codec: s.codec_name, pix_fmt: s.pix_fmt,
  };
};

/** Pull the per-frame YAVG and YDIF lists out of ffmpeg signalstats metadata text. */
export const parseStats = (text) => ({
  yavg: [...text.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)].map((m) => Number(m[1])),
  ydif: [...text.matchAll(/lavfi\.signalstats\.YDIF=([0-9.]+)/g)].map((m) => Number(m[1])),
});

/**
 * One pass: per-frame mean luma (YAVG) and change from the previous frame (YDIF).
 * step > 1 keeps frames phase, phase+step, ... by index (measure uses phase 0), so a 60 or 120 fps render is measured
 * at 30 fps instants (by timestamp, ffmpeg's fps filter picks uneven frames).
 * @param {string} path
 * @param {number} [step]
 * @param {number} [phase]
 */
export const stats = (path, step = 1, phase = 0) => {
  const pick = step > 1 ? `select='eq(mod(n\\,${step})\\,${phase})',setpts=N/30/TB,` : '';
  const r = run('ffmpeg', ['-v', 'error', '-i', path, '-vf', `${pick}scale=390:-2,signalstats,metadata=print:file=-`, '-f', 'null', '-']);
  if (r.code !== 0 || r.error) fail(`ffmpeg failed on ${path}`, 'run `skac doctor`', r.error ? { cause: String(r.error.message || r.error) } : undefined);
  return parseStats(r.stdout);
};

/**
 * Frames per 30 fps frame: 2 at 60, 4 at 120; 1 when the rate is not a multiple of 30.
 * @param {number} fps
 */
export const sampleStep = (fps) => {
  const k = round(fps / 30);
  return k > 1 && Math.abs(fps - 30 * k) < 0.01 ? k : 1;
};

/**
 * The longest run of consecutive still frames: a 0.3 s hold after a move is acting, a long one reads as a dead drawing.
 * @param {number[]} d
 */
export const longestRun = (d) => {
  let best = 0;
  let cur = 0;
  for (const v of d) {
    cur = v < STILL ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
};

/**
 * The maths for one YDIF list, unrounded: motion before and after the event, jerk, peak, still counts.
 * @param {number[]} d YDIF per frame
 * @param {number} fps the rate d was sampled at
 * @param {number} event seconds
 */
export const motionNumbers = (d, fps, event) => {
  const cut = Math.max(1, Math.min(d.length - 1, round(event * fps)));
  const pre = d.slice(0, cut);
  const post = d.slice(cut);
  let sum = 0;
  for (let i = 1; i < d.length - 1; i++) sum += Math.abs(d[i + 1] - 2 * d[i] + d[i - 1]);
  const peak = d.length ? d.reduce((a, b) => (b > a ? b : a), d[0]) : 0.0;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return {
    before: mean(pre), after: mean(post), jerk: sum / Math.max(1, d.length - 2),
    peak, peak_at: d.length ? d.indexOf(peak) / fps : 0.0,
    still: d.filter((v) => v < STILL).length, longest: longestRun(d) / fps,
  };
};

/** @param {string} text like 780x1734@30/8.0 */
export const parseExpect = (text) => {
  const m = /^(\d+)x(\d+)@([0-9.]+)\/([0-9.]+)$/.exec(text || '');
  if (!m) fail(`--expect must look like 780x1734@30/8.0 or none, got ${JSON.stringify(text)}`, 'WxH@fps/seconds');
  return { w: Number(m[1]), h: Number(m[2]), f: Number(m[3]), s: Number(m[4]) };
};

export const measure = (path, event, expect) => {
  const p = probe(path);
  const step = sampleStep(p.fps || 30);
  const { yavg, ydif: d } = stats(path); // every frame: a blank frame at any index fails
  const fps = (p.fps || 30) / step;
  // A 60 or 120 fps render is measured on the 30 fps instants from frame 0 (frames 0, k, 2k, ...),
  // so the same motion gives the same numbers at any rate.
  const n = motionNumbers(step > 1 ? stats(path, step, 0).ydif : d, fps, event);
  let spec_ok = p.codec === 'h264' && p.pix_fmt === 'yuv420p';
  if (expect) {
    spec_ok = spec_ok && p.width === expect.w && p.height === expect.h &&
      Math.abs(p.fps - expect.f) < 0.01 && Math.abs(p.duration - expect.s) < 0.05;
  }
  return {
    name: basename(path).replace(/\.mp4$/, ''), path: shown(path), probe: p, spec_ok,
    frames: yavg.length,
    measured_at_fps: round(fps, 3),
    blank_frames: yavg.filter((v) => v > BLANK_LUMA).length,
    motion: { before_event: round(n.before, 3), after_event: round(n.after, 3) },
    still_frames: n.still,
    longest_still_s: round(n.longest, 2),
    jerk: round(n.jerk, 3),
    peak: { ydif: round(n.peak, 2), at_s: round(n.peak_at, 2) },
  };
};

/**
 * Compare videos. Returns the full document; `ok` is false when any video fails its spec or has blank frames.
 * @param {string[]} videos
 * @param {{event?: number, expect?: string, baseline?: string}} [opts] expect defaults to "none"
 */
export const compareVideos = (videos, opts = {}) => {
  const event = opts.event ?? 4.0;
  const expectText = opts.expect ?? 'none';
  const expect = expectText === 'none' ? null : parseExpect(expectText);
  if (!videos.length) fail('compare needs at least one video', 'skac compare a.mp4 b.mp4 --event 4.0');
  for (const v of videos) if (!existsSync(v)) fail(`no such file: ${v}`, 'pass paths to rendered .mp4 files');
  const rows = videos.map((v) => measure(v, event, expect));
  if (opts.baseline) {
    const base = rows.find((r) => r.name === opts.baseline);
    if (!base) fail(`--baseline ${JSON.stringify(opts.baseline)} is not one of: ${rows.map((r) => r.name).join(', ')}`, 'use a file name without .mp4');
    for (const r of rows) {
      r.vs_baseline = {
        jerk: base.jerk ? round(r.jerk / base.jerk, 2) : null,
        peak: base.peak.ydif ? round(r.peak.ydif / base.peak.ydif, 2) : null,
      };
    }
  }
  const failures = rows.filter((r) => !r.spec_ok || r.blank_frames)
    .map((r) => ({ name: r.name, spec_ok: r.spec_ok, blank_frames: r.blank_frames }));
  const by = (key) => [...rows].sort(key).map((r) => r.name);
  return {
    ok: failures.length === 0,
    event_s: event,
    expect: expectText,
    videos: rows,
    summary: {
      smoothest_first: by((a, b) => a.jerk - b.jerk),
      gentlest_peak_first: by((a, b) => a.peak.ydif - b.peak.ydif),
      liveliest_after_event_first: by((a, b) => b.motion.after_event - a.motion.after_event),
      failures,
    },
  };
};
