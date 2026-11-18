import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { execute } from '../../src/cli.js';
import { tmp, write } from './helpers.js';

function fixture(name) {
  const cwd = tmp('motion-asset-');
  const run = (...args) => execute(['asset', ...args], cwd);
  const { file } = run('sample', name, 'scene.motion.json');
  return { cwd, file, run };
}

test('agent guide covers the format and the drawing workflows', () => {
  const cwd = tmp();
  const run = (...args) => execute(['asset', ...args], cwd);
  const overview = run('guide');
  for (const topic of overview.topics) assert.equal(run('guide', topic).topic, topic);
  assert.equal(run('guide', 'format').schema, 'skac.asset/1');
});

test('the samples load as one repeatable packaged file', () => {
  for (const name of ['game-hud', 'sprout', 'versus-hud']) {
    const { run, file } = fixture(name);
    const one = run('pack', file, '--out=a.skmotion');
    const two = run('pack', file, '--out=b.skmotion');
    assert.deepEqual(readFileSync(one.file), readFileSync(two.file));
    assert.equal(one.bytes, readFileSync(one.file).length);
    assert.deepEqual(run('check', one.file).values, run('check', file).values);
    assert.deepEqual(run('trace', one.file).trace, run('trace', file).trace);
    assert.throws(() => run('pack', file, '--out=a.skmotion'), /cannot write/);
    assert.throws(() => run('pack', file, `--out=${file}`, '--force'), /same file/);
  }
});

test('Versus HUD binds the timer and meters and animates feathering on impact', () => {
  const { file, cwd, run } = fixture('versus-hud');
  const inputs = '--commands=leftHealth=0.48@0.1 leftHit@0.1 timerTens=1@0.1 timerOnes=2@0.1 rightSuper=1@0.2';
  const trace = run('trace', file, '--trace=0,230,600', inputs).trace;
  assert.equal(trace[1].channels.leftHealth, 0.48);
  assert.equal(trace[1].channels.rightSuper, 1);
  assert.equal(trace[1].channels.timerTensa, 0);
  assert.equal(trace[1].channels.timerTensb, 1);
  assert.equal(trace[1].channels.timerOnesg, 1);
  assert.equal(trace[1].channels.leftSoftness, 13);
  assert.equal(trace[1].markers[0].name, 'leftImpact');
  assert.deepEqual(trace[2].awake, []);
  assert.equal(run('trace', file, '--trace=230', inputs, '--reduced').trace[0].channels.leftFlash, 0);
  const { file: frame } = run('frame', file, '--trace=230', inputs);
  assert.match(readFileSync(frame, 'utf8'), /<feGaussianBlur stdDeviation="13"\/>/);

  const scene = JSON.parse(readFileSync(file, 'utf8'));
  scene.artboard.nodes[0].children[0].feather = 100;
  write(join(cwd, 'bad-feather.json'), JSON.stringify(scene));
  assert.throws(() => run('check', 'bad-feather.json'), /feather: expected a number from 0 to 64/);
});

test('Versus HUD keeps panels on the edges when previewing a wider or taller viewport', () => {
  const { file, run } = fixture('versus-hud');
  const wide = readFileSync(run('frame', file, '--size=1200x144', '--out=wide.svg').file, 'utf8');
  assert.match(wide, /width="1200" height="144" viewBox="-100 0 1200 144"/);
  assert.match(wide, /translate\(-100 0\) rotate\(0\) scale\(1 1\)/);
  assert.match(wide, /translate\(1100 0\) rotate\(0\) scale\(-1 1\)/);
  const tall = readFileSync(run('frame', file, '--size=1000x344', '--out=tall.svg').file, 'utf8');
  assert.match(tall, /viewBox="0 -100 1000 344"/);
  assert.match(tall, /translate\(0 -100\) rotate\(0\)/);
  assert.throws(() => run('frame', file, '--size=0x144'), /invalid frame size/);
});

test('HUD tracks health and ammo, emits one reload marker, and sleeps after settling', () => {
  const { file, run } = fixture('game-hud');
  const commands = '--commands=health=0.2@0.10 ammo=2@0.10 reload@0.25';
  const { trace } = run('trace', file, '--trace=0,320,530,980,1200', commands);
  assert.deepEqual(trace[0].awake, []);
  assert.equal(trace[1].states.condition, 'warning');
  assert.equal(trace[2].states.condition, 'low');
  assert.equal(trace[2].channels.healthWidth, 33.800000000000004);
  assert.equal(trace[2].channels.ammo2, 1);
  assert.equal(trace[2].channels.ammo3, 0);
  assert.ok(trace[2].channels.reloadWidth > 0 && trace[2].channels.reloadWidth < 76);
  assert.deepEqual(trace[3].markers, [{ name: 'reloadReady', layer: 'reload', state: 'ready', at: 950 }]);
  assert.deepEqual(trace[4].markers, []);
  assert.deepEqual(trace[4].awake, []);
  const [coarse] = run('trace', file, '--trace=1200', commands).trace;
  assert.deepEqual(coarse.channels, trace[4].channels);
  assert.deepEqual(coarse.markers, trace[3].markers);
});

test('cancelling a reload or skipping a reaction cancels its marker', () => {
  const hud = fixture('game-hud');
  const [cancelled] = hud.run('trace', hud.file, '--trace=1300', '--commands=reload@0.1 cancelReload@0.3').trace;
  assert.equal(cancelled.states.reload, 'idle');
  assert.deepEqual(cancelled.awake, []);
  assert.deepEqual(cancelled.markers, []);
  const sprout = fixture('sprout');
  const [skipped] = sprout.run('trace', sprout.file, '--trace=1300', '--commands=correct@0.1 skip@0.3').trace;
  assert.equal(skipped.states.reaction, 'idle');
  assert.deepEqual(skipped.markers, []);
});

test('Sprout can interrupt and retrigger, preserving light and marker behavior under reduced motion', () => {
  const { file, run } = fixture('sprout');
  const commands = '--commands=correct@0.1 incorrect@0.2 correct@0.25 correct@0.3 light=1@0.35';
  const args = ['--trace=0,220,520,805,1400', commands];
  const normal = run('trace', file, ...args).trace;
  const reduced = run('trace', file, ...args, '--reduced').trace;
  assert.deepEqual(normal.map((x) => x.states.reaction), ['idle', 'incorrect', 'correct', 'reward', 'idle']);
  assert.equal(normal[2].channels.lightX, 44);
  assert.equal(normal[3].markers[0].at, 790);
  assert.ok(normal[2].channels.bodyY < normal[0].channels.bodyY);
  assert.equal(reduced[2].channels.bodyY, normal[0].channels.bodyY);
  assert.equal(reduced[3].channels.badgeAlpha, 1);
  assert.equal(reduced[3].channels.badgeScale, 1);
  assert.deepEqual(reduced.map((x) => x.markers), normal.map((x) => x.markers));
  assert.deepEqual(reduced[4].awake, []);
});

test('long tracks preserve interpolation and exact hold boundaries in trace and reduced motion', () => {
  const { cwd, file, run } = fixture('sprout');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  scene.channels.sample = 0;
  const track = Array.from({ length: 896 }, (_, i) => [5 + i / 2, i]);
  track.push([453, 1000, 'hold'], [461, 1200, 'inOut'], [469, 1500, 'out'], [477, 1300, 'in']);
  scene.clips.correct.tracks.sample = track;
  scene.clips.correct.reducedAt = 453;
  write(join(cwd, 'long-track.json'), JSON.stringify(scene));

  const times = [0, 4.5, 5, 253.25, 452.75, 453, 457, 461, 465, 473, 477, 485];
  const trace = times.map((time) => 125 + time).join(',');
  const args = ['trace', 'long-track.json', `--trace=${trace}`, '--commands=correct@0.125'];
  const normal = run(...args).trace.map((row) => Math.round(row.channels.sample * 1000) / 1000);
  assert.deepEqual(normal, [0, 0, 0, 496.5, 895, 1000, 1119.194, 1200, 1489.795, 1473.026, 1300, 1300]);
  const reduced = run(...args, '--reduced').trace.map((row) => row.channels.sample);
  assert.deepEqual(reduced, times.map(() => 1000));
});

test('malformed assets fail before packaging and frames resolve the light channel', () => {
  const { cwd, file, run } = fixture('sprout');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  value.clips.correct.tracks.bodyY[1][0] = 0;
  write(join(cwd, 'bad.json'), JSON.stringify(value));
  assert.throws(() => run('pack', 'bad.json'), /keyframe times must be strictly increasing/);
  write(join(cwd, 'bad.json'), readFileSync(file, 'utf8').replace('"lightX": -22', '"__proto__": -22'));
  assert.throws(() => run('check', 'bad.json'), /reserved field name/);
  assert.throws(() => run('trace', file, '--commands=light=blue@0.2'), /takes a number/);

  const frame = run('frame', file, '--trace=200', '--commands=light=1@0.1');
  const svg = readFileSync(frame.file, 'utf8');
  assert.match(svg, /<svg .*viewBox="0 0 240 260"/);
  assert.match(svg, /<radialGradient .*cx="44" cy="-83"/);
  assert.match(svg, /<path d="M -7 -105 C /);
});

test('single-file assets can embed painted layers and hold an image swap until its key', () => {
  const { cwd, file, run } = fixture('sprout');
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8z8CwkYGBgYGJAQrgDAAqOQG2ps3ojQAAAABJRU5ErkJggg==';
  const webp = 'UklGRhwAAABXRUJQVlA4TA8AAAAvAYAAEAcQ/Y/GBiKi/wEA';
  writeFileSync(join(cwd, 'art.png'), Buffer.from(png, 'base64'));
  writeFileSync(join(cwd, 'art.webp'), Buffer.from(webp, 'base64'));
  const embedded = run('image', 'art.png');
  assert.throws(() => run('image', 'art.png', '--size=0x0'), /invalid image size/);
  assert.deepEqual(run('image', 'art.png', '--size=120x120'), embedded);
  assert.equal(embedded.uri, `data:image/png;base64,${png}`);
  assert.deepEqual([embedded.width, embedded.height, embedded.rgbaBytes], [2, 3, 24]);
  const next = run('image', 'art.webp');
  assert.deepEqual([next.width, next.height], [2, 3]);
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  scene.images = { painting: embedded.uri, alternate: next.uri };
  scene.channels.paintingAlpha = 0.3;
  scene.clips.correct.tracks.paintingAlpha = [[0, 0.3], [75, 0.8, 'hold']];
  const layer = { kind: 'image', image: 'painting', x: 10, y: 20, width: 28, height: 42, opacity: 'paintingAlpha' };
  scene.artboard.nodes.push(layer);
  write(join(cwd, 'painted.json'), JSON.stringify(scene));
  const packed = run('pack', 'painted.json');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(packed.file, 'utf8')).images), ['painting']);
  const inputs = '--commands=correct@0.1';
  const { trace } = run('trace', packed.file, '--trace=100,174.99,175', inputs);
  assert.deepEqual(trace.map((row) => row.channels.paintingAlpha), [0.3, 0.3, 0.8]);
  const preview = readFileSync(run('frame', packed.file, '--trace=175', inputs).file, 'utf8');
  assert.ok(preview.includes(`<image href="${embedded.uri}" x="10" y="20" width="28" height="42" opacity="0.8"`));

  for (const [name, payload, length] of [['art.png', png, 24], ['art.webp', webp, 25]]) {
    writeFileSync(join(cwd, name), Buffer.from(payload, 'base64').subarray(0, length));
    assert.throws(() => run('image', name), /invalid embedded image/);
  }

  layer.image = 'missing';
  write(join(cwd, 'painted.json'), JSON.stringify(scene));
  assert.throws(() => run('check', 'painted.json'), /expected a name from images/);
  scene.images.painting = `data:image/webp;base64,${png}`;
  write(join(cwd, 'painted.json'), JSON.stringify(scene));
  assert.throws(() => run('check', 'painted.json'), /images.painting: expected an embedded PNG or WebP/);
});

test('group masks can animate a path coordinate in a seekable preview', () => {
  const { cwd, file, run } = fixture('sprout');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  const group = scene.artboard.nodes[1];
  scene.channels.edge = 10;
  scene.clips.correct.tracks.edge = [[0, 10], [100, 40]];
  group.clip = [['M', -20, -100], ['L', 'edge', -100], ['L', 'edge', 0], ['L', -20, 0], ['Z']];
  write(join(cwd, 'clip.json'), JSON.stringify(scene));
  const commands = '--commands=correct@0.1';
  const first = readFileSync(run('frame', 'clip.json', '--trace=100', commands).file, 'utf8');
  const end = readFileSync(run('frame', 'clip.json', '--trace=200', commands).file, 'utf8');
  assert.match(first, /<clipPath id="(clip-\d+)"><path d="M -20 -100 L 10 -100 L 10 0 L -20 0 Z"\/><\/clipPath>/);
  assert.match(end, /<clipPath id="(clip-\d+)"><path d="M -20 -100 L 40 -100 L 40 0 L -20 0 Z"\/><\/clipPath>/);
  assert.match(end, /<g transform="[^"]+" clip-path="url\(#clip-\d+\)">/);
  group.clip[1][1] = 'absent';
  write(join(cwd, 'clip.json'), JSON.stringify(scene));
  assert.throws(() => run('check', 'clip.json'), /\.clip\[1\]\[1\]: unknown channel "absent"/);
});

test('asset check measures nested attachment transforms and catches drift within a clip', () => {
  const { cwd, file, run } = fixture('sprout');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  scene.channels.drift = 0;
  scene.clips.correct.tracks.drift = [[0, 0], [100, 10], [200, 0]];
  scene.artboard.nodes.push({
    kind: 'group', x: 100, y: 80, rotation: 90, scaleX: 2, scaleY: 3,
    children: [{
      kind: 'group', x: 4, y: 5, rotation: 90, scaleX: -1, scaleY: 0.5,
      points: { flame: { x: 'drift', y: 2 } }, children: [],
    }],
  }, {
    kind: 'group', x: 85, y: 86,
    points: { glow: { x: 0, y: 0 } }, children: [],
  });
  scene.attachments = [{ from: 'flame', to: 'glow', maxDistance: 1 }];
  const save = () => write(join(cwd, 'attachments.motion.json'), JSON.stringify(scene));
  save();
  assert.equal(run('check', 'attachments.motion.json').samples, 1);
  const flameGroup = scene.artboard.nodes.at(-2);
  const glowGroup = scene.artboard.nodes.at(-1);
  flameGroup.anchor = { x: 'left' };
  glowGroup.anchor = { x: 'right' };
  save();
  assert.throws(() => run('check', 'attachments.motion.json', '--size=280x260'),
    /is 40 artboard points apart at 0 ms/);
  delete flameGroup.anchor;
  delete glowGroup.anchor;
  save();
  const cue = '--commands=correct@0.125';
  const rows = run('trace', 'attachments.motion.json', '--trace=125:225:70', cue).trace;
  assert.deepEqual(rows.map((row) => row.t_ms), [125, 195, 225]);
  assert.deepEqual(rows.map((row) => Math.round(row.points.flame.x)), [85, 106, 115]);
  assert.deepEqual(rows.map((row) => Math.round(row.points.flame.y)), [86, 86, 86]);
  assert.deepEqual(rows[2].points.glow, { x: 85, y: 86 });
  assert.throws(() => run('check', 'attachments.motion.json', '--trace=125:325:20', cue),
    /attachment flame → glow is 30 artboard points apart at 225 ms \(limit 1\)/);
  assert.throws(() => run('check', 'attachments.motion.json', '--trace=0:60000:1', cue), /invalid asset trace times/);
  assert.throws(() => run('frame', 'attachments.motion.json', '--trace=125:325:20', cue), /takes one time/);

  scene.attachments[0].maxDistance = 30;
  save();
  const packed = run('pack', 'attachments.motion.json');
  assert.deepEqual(run('check', packed.file, '--trace=125:325:20', cue).attachments,
    [{ from: 'flame', to: 'glow', maxDistance: 30, distance: 30, t_ms: 225 }]);

  const last = scene.artboard.nodes.at(-1);
  last.points.flame = last.points.glow;
  save();
  assert.throws(() => run('check', 'attachments.motion.json'), /duplicate point name/);
  delete last.points.flame;
  delete last.points.glow;
  save();
  assert.throws(() => run('check', 'attachments.motion.json'), /unknown point "glow"/);
});
