import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVideos, longestRun, motionNumbers, parseExpect, parseStats, sampleStep } from '../../src/compare.js';
import { round } from '../../src/util.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('motionNumbers: jerk, peak, motion and still counts on a synthetic YDIF list', () => {
  const d = [0, 0.02, 1, 1, 3, 1, 0.04, 0.5];
  const m = motionNumbers(d, 2, 2);
  let sum = 0;
  for (let i = 1; i < d.length - 1; i++) sum += Math.abs(d[i + 1] - 2 * d[i] + d[i - 1]);
  assert.equal(m.jerk, sum / 6);
  assert.equal(m.peak, 3);
  assert.equal(m.peak_at, 2);
  assert.equal(m.still, 3); // 0, 0.02 and 0.04
  assert.equal(m.longest, 1); // two still frames in a row at 2 fps
  assert.equal(m.before, (0 + 0.02 + 1 + 1) / 4);
  assert.equal(m.after, (3 + 1 + 0.04 + 0.5) / 4);
  assert.equal(longestRun([1, 0, 0, 0, 1, 0]), 3);
});

test('sampleStep: 2 at 60, 4 at 120, 1 at 30 or a rate that is not a multiple of 30', () => {
  assert.equal(sampleStep(30), 1);
  assert.equal(sampleStep(60), 2);
  assert.equal(sampleStep(120), 4);
  assert.equal(sampleStep(29.97), 1);
  assert.equal(sampleStep(59.94), 1);
  assert.equal(sampleStep(24), 1);
  assert.equal(sampleStep(50), 1);
});

test('compareVideos: a 30 fps clip and its 120 fps twin give equal jerk and peak', { skip: !hasFfmpeg }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'skac-phase0-'));
  try {
    // Luma moves as a smooth function of time, so every frame rate samples the same motion.
    const clip = (fps) => {
      const out = join(dir, `m${fps}.mp4`);
      const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=gray:s=64x64:r=${fps}:d=2`,
        '-vf', "geq=lum='100+30*sin(4*T)':cb=128:cr=128", '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '0', '-y', out]);
      assert.equal(r.status, 0, String(r.stderr));
      return out;
    };
    const [a, b] = compareVideos([clip(30), clip(120)], { event: 1 }).videos;
    assert.equal(a.measured_at_fps, 30);
    assert.equal(b.measured_at_fps, 30);
    assert.ok(Math.abs(a.jerk - b.jerk) <= 0.01, `jerk ${a.jerk} vs ${b.jerk}`);
    assert.ok(Math.abs(a.peak.ydif - b.peak.ydif) <= 0.01, `peak ${a.peak.ydif} vs ${b.peak.ydif}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round ties to even like Python', () => {
  assert.equal(round(1.125, 2), 1.12);
  assert.equal(round(0.0625, 3), 0.062);
  assert.equal(round(2.5), 2);
  assert.equal(round(3.5), 4);
  assert.equal(round(1.2345, 3), 1.234);
});

test('parseStats and parseExpect', () => {
  const t = 'lavfi.signalstats.YAVG=12.5\nlavfi.signalstats.YDIF=0.25\nlavfi.signalstats.YAVG=13\nlavfi.signalstats.YDIF=1';
  assert.deepEqual(parseStats(t), { yavg: [12.5, 13], ydif: [0.25, 1] });
  assert.deepEqual(parseExpect('780x1734@30/8.0'), { w: 780, h: 1734, f: 30, s: 8 });
  assert.throws(() => parseExpect('big'), /--expect/);
});
