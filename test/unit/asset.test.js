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

test('the reward counter draws a host-formatted count as text and pulses on landing', () => {
  const { file, run } = fixture('reward-counter');
  const packed = run('pack', file).file;
  const commands = '--commands=xpLabel="+18 XP"@0.15 xpLabel="+42 XP"@0.4 land@0.4';
  const args = ['--trace=0,180,485', commands];
  const { trace } = run('trace', packed, ...args);
  assert.deepEqual(trace.map(({ values }) => values.xpLabel), ['+0 XP', '+18 XP', '+42 XP']);
  assert.equal(trace[2].channels.landScale, 1.075);
  assert.equal(trace[2].markers[0].name, 'rewardLanded');
  const reduced = run('trace', packed, ...args, '--reduced').trace;
  assert.equal(reduced[2].channels.landScale, 1);
  const frame = run('frame', packed, '--trace=485', commands);
  assert.match(readFileSync(frame.file, 'utf8'), /<text[^>]*>\+42 XP<\/text>/);
});

test('font features survive binary packing and affect embedded digit layout', async () => {
  const { file, run } = fixture('reward-counter');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  const node = { kind: 'text', text: '1111', x: 0, y: 0, width: 44, fontSize: 18, fill: '#FFFFFF' };
  scene.artboard.nodes = [node];
  for (const [features, error] of [
    [[{ name: 'tnum', value: 0.5 }], /fontFeatures\[0\]\.value: expected an integer/],
    [[{ name: 'bad"', value: 1 }], /four-character OpenType feature tag/],
    [[{ name: 'tnum', value: 1 }, { name: 'tnum', value: 0 }], /duplicate font feature/],
  ]) {
    node.fontFeatures = features;
    write(file, JSON.stringify(scene));
    assert.throws(() => run('check', file), error);
  }

  node.fontFeatures = [{ name: 'pnum', value: 1 }];
  write(file, JSON.stringify(scene));
  const proportional = await run('check', file, '--text-layout');
  assert.equal(proportional.textLayout.overflow, 0);

  node.fontFeatures = [{ name: 'tnum', value: 1 }];
  write(file, JSON.stringify(scene));
  const packed = run('pack', file, '--format=binary').file;
  const frame = readFileSync(run('frame', packed).file, 'utf8');
  assert.match(frame, /font-feature-settings: 'tnum' 1/);
  const tabular = await run('check', packed, '--text-layout');
  assert.equal(tabular.textLayout.overflow, 1);
  assert.equal(tabular.warnings[0].code, 'text-overflow');
});

test('text layout checks sampled bound, multiline, RTL, and unavailable text', async () => {
  const { file, run } = fixture('reward-counter');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  const urdu = 'یہ ایک آزمائش ہے';
  scene.fonts = {
    Urdu: 'data:font/ttf;base64,' + readFileSync(new URL('../fixtures/fonts/NotoSansArabic-Subset.ttf', import.meta.url), 'base64'),
  };
  const base = { kind: 'text', x: 0, y: 0, width: 52, fontSize: 18, fill: '#FFFFFF' };
  scene.artboard.nodes = [
    { kind: 'group', children: [{ ...base, text: { value: 'xpLabel' } }] },
    { ...base, text: 'A\nB' },
    { ...base, text: 'A\nB', maxLines: 2 },
    { ...base, text: urdu, direction: 'rtl', width: 220, fonts: ['Urdu'] },
    { ...base, text: urdu, direction: 'rtl', width: 24, fonts: ['Urdu'] },
    { ...base, text: urdu + ' 😀', direction: 'rtl', width: 220, fonts: ['Urdu'] },
    { ...base, text: 'Platform', fonts: [] },
  ];
  write(file, JSON.stringify(scene));
  const args = ['--text-layout', '--size=360x640', '--trace=450,0,220,330',
    '--commands=xpLabel="+1,250 XP gained today"@0.22'];
  const checked = await run('check', file, ...args);
  assert.deepEqual(checked.textLayout, {
    engine: 'skia-paragraph', viewport: { width: 360, height: 640 },
    samples: 4, measured: 6, unmeasured: 2, overflow: 3,
  });
  const [bound, newline, narrowRtl, missing, system] = checked.warnings;
  assert.equal(bound.where, 'artboard.nodes[0].children[0]');
  assert.equal(bound.text, '+1,250 XP gained today');
  assert.equal(bound.t_ms, 220);
  assert.equal(bound.width, 52);
  assert.equal(bound.fontSize, 18);
  assert.equal(bound.wrapped, true);
  assert.ok(bound.requiredLines > bound.maxLines);
  assert.equal(newline.explicitBreaks, 1);
  assert.equal(newline.wrapped, false);
  assert.equal(newline.requiredLines, 2);
  assert.equal(narrowRtl.code, 'text-overflow');
  assert.equal(narrowRtl.text, urdu);
  assert.equal(missing.code, 'text-layout-unavailable');
  assert.deepEqual(missing.codepoints, ['U+1F600']);
  assert.equal(system.reason, 'system-font');
  assert.equal(run('check', file).textLayout, undefined);

  scene.artboard.nodes[0].children[0].width = 280;
  write(file, JSON.stringify(scene));
  const wide = await run('check', file, ...args);
  assert.equal(wide.textLayout.overflow, 2);
  assert.ok(!wide.warnings.some(({ where }) => where === bound.where));
});

test('packed CRLF labels use one hard break and report the original sampled text', async () => {
  const { file, run } = fixture('reward-counter');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  const base = { kind: 'text', x: 0, y: 0, width: 52, fontSize: 18, fill: '#FFFFFF' };
  scene.artboard.nodes = [
    { ...base, text: 'A\r\nB' },
    { ...base, text: 'A\nB' },
    { ...base, text: 'A\r\nB', maxLines: 2 },
  ];
  write(file, JSON.stringify(scene));
  for (const format of ['json', 'binary']) {
    const { file: packed } = run('pack', file, `--format=${format}`, `--out=${format}.skmotion`);
    const { textLayout, warnings } = await run('check', packed, '--text-layout');
    assert.equal(textLayout.unmeasured, 0);
    assert.equal(textLayout.measured, 3);
    assert.equal(textLayout.overflow, 2);
    assert.deepEqual(warnings.map(({ code, text, requiredLines, explicitBreaks, wrapped }) =>
      ({ code, text, requiredLines, explicitBreaks, wrapped })), [
      { code: 'text-overflow', text: 'A\r\nB', requiredLines: 2, explicitBreaks: 1, wrapped: false },
      { code: 'text-overflow', text: 'A\nB', requiredLines: 2, explicitBreaks: 1, wrapped: false },
    ]);
  }
});

test('host-only exports omit fonts and support offline preview, text QA, and unpacking', async () => {
  const { cwd, file, run } = fixture('reward-counter');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  const font = readFileSync(new URL('../../templates/fonts/allo-1.0.3/Allo-Regular.otf', import.meta.url));
  const urdu = readFileSync(new URL('../fixtures/fonts/NotoSansArabic-Subset.ttf', import.meta.url));
  const fontPath = join(cwd, 'Counter=Regular.otf');
  writeFileSync(fontPath, font);
  writeFileSync(join(cwd, 'Label.ttf'), urdu);
  const base = { kind: 'text', x: 0, y: 0, width: 180, fontSize: 18, fill: '#FFFFFF' };
  scene.artboard.nodes = [
    { ...base, text: '1111', width: 44, fonts: ['Counter'], fontFeatures: [{ name: 'tnum', value: 1 }] },
    { ...base, text: 'یہ ایک آزمائش ہے', direction: 'rtl', fonts: ['Label'] },
  ];
  const bundle = {
    schema: 'skac.bundle/1', name: 'Scoreboard', defaultArtboard: 'score',
    fonts: { Allo: 'data:font/otf;base64,' + font.toString('base64'), Urdu: 'data:font/ttf;base64,' + urdu.toString('base64') },
    fontSlots: { Counter: { fallback: 'Allo' } },
    artboards: { score: { ...scene, fontSlots: { Label: { fallback: 'Urdu' } } } },
  };
  write(file, JSON.stringify(bundle));
  const standalone = run('pack', file, '--format=binary', '--out=standalone.skmotion');
  assert.equal(standalone.sizeBreakdown.fonts, font.length + urdu.length);
  assert.equal(standalone.bytes, Object.values(standalone.sizeBreakdown).reduce((a, b) => a + b));
  assert.equal((await run('check', standalone.file, '--text-layout')).textLayout.overflow, 1);
  assert.equal(run('preview', standalone.file).ok, true);

  const mappings = ['--font=Counter=Counter=Regular.otf', '--font=Label=Label.ttf'];
  for (const format of ['json', 'binary']) {
    const host = run('pack', file, `--format=${format}`, '--fonts=host', `--out=host-${format}.skmotion`);
    assert.equal(host.sizeBreakdown.fonts, 0);
    assert.equal(host.sizeBreakdown.scene, host.bytes);
    assert.deepEqual(host.fontSlots, { Counter: {}, Label: {} });
    const unavailable = await run('check', host.file, '--text-layout');
    assert.deepEqual(unavailable.warnings.map(({ reason, slots }) => [reason, slots]),
      [['missing-font-slots', ['Counter']], ['missing-font-slots', ['Label']]]);
    // With no --font the preview draws the slots in the default face, as the app does, and says so.
    const plain = run('preview', host.file, `--out=plain-${format}.preview.html`);
    assert.deepEqual(plain.warnings.map(({ code, slots }) => [code, slots]), [['font-slot-fallback', ['Counter', 'Label']]]);
    assert.throws(() => run('preview', host.file, '--font=Unknown=Label.ttf'), /unknown font slot/);
    assert.throws(() => run('preview', host.file, mappings[0], mappings[0]), /duplicate --font/);
    const checked = await run('check', host.file, '--text-layout', ...mappings);
    assert.equal(checked.textLayout.measured, 2);
    assert.equal(checked.textLayout.overflow, 1);
    assert.equal(checked.warnings[0].text, '1111');
    const preview = readFileSync(run('preview', host.file, ...mappings).file, 'utf8');
    const viewer = JSON.parse(/<script id="scene" type="application\/json">([\s\S]*?)<\/script>/.exec(preview)[1]);
    assert.deepEqual(Object.keys(viewer.hostFonts), ['Counter', 'Label']);
    assert.equal(viewer.source, readFileSync(host.file, format === 'binary' ? 'base64' : 'utf8'));
    const frame = readFileSync(run('frame', host.file, ...mappings).file, 'utf8');
    assert.match(frame, /@font-face\{font-family:Counter;/);
    const recovered = run('unpack', host.file).file;
    const editable = JSON.parse(readFileSync(recovered, 'utf8'));
    assert.deepEqual(editable.fontSlots, { Counter: {} });
    assert.equal(editable.fonts, undefined);
    assert.equal(editable.artboards.score.fonts, undefined);
    editable.artboards.score.artboard.nodes[0].text = '8888';
    write(recovered, JSON.stringify(editable));
    const edited = run('pack', recovered, `--format=${format}`, '--fonts=host', `--out=edited-${format}.skmotion`);
    const proof = await run('check', edited.file, '--text-layout', ...mappings);
    assert.equal(proof.warnings[0].text, '8888');
  }

  scene.artboard.nodes[0].fonts = ['Allo'];
  write(file, JSON.stringify(bundle));
  assert.throws(() => run('pack', file, '--fonts=host'), /artboards.score.artboard.nodes\[0\].fonts: host export would remove the Allo font/);
  delete scene.artboard.nodes[0].fonts;
  write(file, JSON.stringify(bundle));
  assert.throws(() => run('pack', file, '--fonts=host'), /host export would remove the default font/);
  bundle.fontSlots.Counter.fallback = 'Missing';
  write(file, JSON.stringify(bundle));
  assert.throws(() => run('check', file), /bundle.fontSlots.Counter.fallback: expected an embedded font name/);
});

test('pack reports separate font and scene costs when an asset exceeds its budget', () => {
  const { file, run } = fixture('reward-counter');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  const bytes = Buffer.alloc(600_000);
  readFileSync(new URL('../../templates/fonts/allo-1.0.3/Allo-Regular.otf', import.meta.url)).copy(bytes);
  const first = 'data:font/otf;base64,' + bytes.toString('base64');
  bytes[bytes.length - 1] = 1;
  const second = 'data:font/otf;base64,' + bytes.toString('base64');
  scene.fonts = { first, second };
  scene.artboard.nodes = [{ kind: 'text', x: 0, y: 0, width: 80, fontSize: 16, fill: '#FFFFFF', text: 'Score', fonts: ['first', 'second'] }];
  write(file, JSON.stringify(scene));
  for (const format of ['binary', 'json']) {
    assert.throws(() => run('pack', file, `--format=${format}`), (error) => {
      assert.match(error.message, /packed asset exceeds 1 MiB/);
      const { bytes: size, sizeBreakdown } = error.extra;
      assert.equal(sizeBreakdown.fonts, format === 'binary' ? bytes.length * 2 : first.length + second.length);
      assert.equal(size, sizeBreakdown.fonts + sizeBreakdown.scene);
      return true;
    });
  }
});

test('painted meshes pack their textures, deform in preview and move named pin children', () => {
  const { cwd, file, run } = fixture('sprout');
  const asset = JSON.parse(readFileSync(file, 'utf8'));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8z8CwkYGBgYGJAQrgDAAqOQG2ps3ojQAAAABJRU5ErkJggg==';
  asset.images = { painting: png, eye: png, unused: png };
  asset.channels.bendY = 0;
  asset.clips.correct.tracks.bendY = [[0, 0], [200, 18]];
  asset.artboard.nodes = [{
    kind: 'group', x: 12, y: 20,
    children: [{
      kind: 'mesh', image: 'painting',
      vertices: [[0, 0, 0, 0], [40, 'bendY', 1, 0], [0, 30, 0, 1], [40, 30, 1, 1]],
      indices: [0, 1, 2, 1, 3, 2],
      pins: {
        hinge: {
          triangle: 0, weights: [0, 1, 0],
          children: [
            { kind: 'group', points: { bill: { x: 0, y: 0 } }, children: [] },
            { kind: 'image', image: 'eye', x: 0, y: 0, width: 2, height: 3 },
          ],
        },
      },
    }],
  }];
  asset.attachments = [{ from: 'hinge', to: 'bill', maxDistance: 0 }];
  write(file, JSON.stringify(asset));
  const cue = '--commands=correct@0';
  const { trace } = run('trace', file, '--trace=0,200', cue);
  assert.deepEqual(trace.map((row) => row.points.hinge), [{ x: 52, y: 20 }, { x: 52, y: 38 }]);
  assert.deepEqual(trace[1].points.hinge, trace[1].points.bill);
  assert.equal(run('check', file, '--trace=0:200:20', cue).attachments[0].distance, 0);
  const packed = run('pack', file);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(packed.file, 'utf8')).images), ['painting', 'eye']);
  const svg = readFileSync(run('frame', packed.file, '--trace=200', cue).file, 'utf8');
  assert.match(svg, /matrix\(40 18 0 30 0 0\)/);
  assert.match(svg, /<polygon points="0,0 40,18 0,30"\/>/);
  assert.match(svg, /translate\(40 18\)/);

  const mesh = asset.artboard.nodes[0].children[0];
  mesh.indices[0] = 9;
  write(join(cwd, 'invalid.json'), JSON.stringify(asset));
  assert.throws(() => run('check', 'invalid.json'), /indices\[0\]: expected a number from 0 to 3/);
  mesh.indices[0] = 0;
  mesh.pins.hinge.weights = [0, 0.9, 0];
  write(join(cwd, 'invalid.json'), JSON.stringify(asset));
  assert.throws(() => run('check', 'invalid.json'), /weights must add up to 1/);
  mesh.pins.hinge.weights = [0, 1, 0];
  mesh.vertices[1][2] = 0;
  write(join(cwd, 'invalid.json'), JSON.stringify(asset));
  assert.throws(() => run('check', 'invalid.json'), /non-collinear texture coordinates/);
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

test('binary bundles deduplicate media and round trip through the CLI without changing playback', () => {
  const { file, cwd, run } = fixture('sprout');
  const visual = JSON.parse(readFileSync(file, 'utf8'));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8z8CwkYGBgYGJAQrgDAAqOQG2ps3ojQAAAABJRU5ErkJggg==';
  visual.images = { painting: png, otherName: png };
  visual.imageSlots = { portrait: 'painting' };
  visual.artboard.nodes.push(
    { kind: 'image', image: 'portrait', x: 1, y: 2, width: 2, height: 3 },
    { kind: 'image', image: 'otherName', x: 8, y: 4, width: 2, height: 3 },
    { kind: 'text', text: '100% مرحبا 🌱', x: 1, y: 12, width: 120, fontSize: 14, fill: '#333333' },
  );
  const cue = 'data:audio/wav;base64,UklGRgAAAABXQVZF';
  const thumbnail = structuredClone(visual);
  thumbnail.name = 'Thumbnail';
  thumbnail.audio = { whoosh: cue };
  write(file, JSON.stringify({
    schema: 'skac.bundle/1', name: 'CompactBundle', defaultArtboard: 'full',
    audio: { reveal: cue }, artboards: { full: visual, thumb: thumbnail },
  }));
  const json = run('pack', file, '--out=plain.skmotion');
  const binary = run('pack', file, '--out=compact.skmotion', '--format=binary');
  const repeat = run('pack', file, '--out=repeat.skmotion', '--format=binary');
  const bytes = readFileSync(binary.file);
  assert.equal(bytes.toString('ascii', 0, 4), 'SKMO');
  assert.equal(bytes[4], 1);
  assert.deepEqual(bytes, readFileSync(repeat.file));
  const manifestEnd = 12 + bytes.readUInt32LE(8);
  const manifest = JSON.parse(bytes.toString('utf8', 12, manifestEnd));
  assert.deepEqual(manifest.resources.map(([mime]) => mime).sort(), ['audio/wav', 'font/otf', 'image/png']);
  assert.equal(manifest.asset.artboards.full.images.painting, manifest.asset.artboards.thumb.images.otherName);
  assert.equal(manifest.asset.audio.reveal, manifest.asset.artboards.thumb.audio.whoosh);
  assert.ok(binary.bytes < json.bytes);
  assert.equal(run('check', binary.file, '--artboard=thumb').name, 'Thumbnail');
  const args = ['--artboard=thumb', '--trace=0,350,900', '--commands=correct@0.1'];
  assert.deepEqual(run('trace', binary.file, ...args), run('trace', json.file, ...args));
  const svg = (packed) => readFileSync(run('frame', packed.file, '--artboard=thumb', '--trace=350').file, 'utf8');
  assert.equal(svg(binary), svg(json));
  const types = (packed) => readFileSync(run('types', packed.file, '--artboard=thumb').file, 'utf8');
  assert.equal(types(binary), types(json));
  const preview = readFileSync(run('preview', binary.file).file, 'utf8');
  const embedded = JSON.parse(preview.match(/<script id="scene" type="application\/json">(.*?)<\/script>/s)[1]);
  assert.equal(embedded.binary, true);
  assert.deepEqual(Buffer.from(embedded.source, 'base64'), bytes);
  const unpacked = run('unpack', binary.file);
  assert.deepEqual(JSON.parse(readFileSync(unpacked.file, 'utf8')), JSON.parse(readFileSync(json.file, 'utf8')));
  assert.throws(() => run('pack', file, '--format=other'), /unknown asset format/);

  const checked = join(cwd, 'invalid.skmotion');
  const reject = (value, expected) => {
    writeFileSync(checked, value);
    assert.throws(() => run('check', checked), expected);
  };
  reject(bytes.subarray(0, 11), /truncated header/);
  const future = Buffer.from(bytes);
  future[4] = 2;
  reject(future, /unsupported container version 2/);
  reject(Buffer.concat([bytes, Buffer.of(0)]), /trailing bytes/);
  reject(bytes.subarray(0, -1), /resource type or length is invalid/);
  manifest.asset.artboards.full.images.painting = 100;
  const badManifest = Buffer.from(JSON.stringify(manifest));
  const header = Buffer.from(bytes.subarray(0, 12));
  header.writeUInt32LE(badManifest.length, 8);
  reject(Buffer.concat([header, badManifest, bytes.subarray(manifestEnd)]), /unknown resource index/);
});

test('binary packing shares decoded audio bytes across noncanonical Base64 aliases', () => {
  const { file, run } = fixture('game-hud');
  const scene = JSON.parse(readFileSync(file, 'utf8'));
  const payload = Buffer.alloc(540_001, 0);
  const canonical = payload.toString('base64');
  const alias = canonical.slice(0, -3) + 'P==';
  assert.notEqual(alias, canonical);
  assert.deepEqual(Buffer.from(alias, 'base64'), payload);
  scene.audio = {
    first: `data:audio/wav;base64,${canonical}`,
    second: `data:audio/wav;base64,${alias}`,
    wav: 'data:audio/wav;base64,AA==',
    aac: 'data:audio/aac;base64,AA==',
    different: 'data:audio/wav;base64,AQ==',
  };
  write(file, JSON.stringify(scene));

  const packed = run('pack', file, '--format=binary');
  const bytes = readFileSync(packed.file);
  const manifest = JSON.parse(bytes.toString('utf8', 12, 12 + bytes.readUInt32LE(8)));
  const { first, second, wav, aac, different } = manifest.asset.audio;
  assert.equal(first, second);
  assert.equal(new Set([first, wav, aac, different]).size, 4);
  assert.equal(manifest.resources.length, 4);
  const unpacked = JSON.parse(readFileSync(run('unpack', packed.file).file, 'utf8'));
  assert.deepEqual(unpacked.audio, { ...scene.audio, second: scene.audio.first });
});

test('artboard bundles pack every board and expose bound text, semantics, audio and declarations', () => {
  const { file, cwd, run } = fixture('sprout');
  const visual = JSON.parse(readFileSync(file, 'utf8'));
  const label = 'مرحبا';
  visual.machine.values.title = { type: 'string', default: label };
  visual.machine.layers[0].states.idle.on_enter = [{ set: 'title', to: 'constructor' }];
  const font = new URL('../../templates/fonts/allo-1.0.3/Allo-Regular.otf', import.meta.url);
  visual.fonts = { label: `data:font/otf;base64,${readFileSync(font).toString('base64')}` };
  const cue = join(cwd, 'reveal.wav');
  writeFileSync(cue, Buffer.from('RIFF\0\0\0\0WAVE', 'binary'));
  visual.audio = { cue: run('resource', cue).uri };
  visual.markers[0].audio = 'cue';
  visual.semantics = [{ name: 'play', label: { value: 'title' }, role: 'button', bounds: [0, 0, 44, 44], trigger: 'correct' }];
  visual.artboard.nodes.push({
    kind: 'text', text: { value: 'title' }, x: 8, y: 2, width: 90, fontSize: 16, fill: '#f0f0f0',
    fonts: ['label'], direction: 'rtl',
  });
  const other = JSON.parse(readFileSync(file, 'utf8'));
  other.name = 'Thumbnail';
  const bundle = { schema: 'skac.bundle/1', name: 'MobileVisuals', defaultArtboard: 'reward',
    fonts: visual.fonts, audio: visual.audio, artboards: { reward: visual, thumbnail: other } };
  delete visual.fonts;
  delete visual.audio;
  write(file, JSON.stringify(bundle));
  const packed = run('pack', file);
  assert.deepEqual(packed.artboards, ['reward', 'thumbnail']);
  const packedBundle = JSON.parse(readFileSync(packed.file, 'utf8'));
  assert.equal(packedBundle.audio.cue, bundle.audio.cue);
  assert.equal(packedBundle.artboards.reward.audio, undefined);
  assert.equal(run('check', packed.file, '--artboard=thumbnail').name, 'Thumbnail');
  assert.throws(() => run('check', packed.file, '--artboard=missing'), /unknown artboard/);
  const typesFile = run('types', packed.file).file;
  const declarations = readFileSync(typesFile, 'utf8');
  assert.match(declarations, /readonly "title": \{ readonly type: "string" \}/);
  assert.match(declarations, /readonly markers: "rewardLanded"/);
  assert.equal(run('types', packed.file, '--check').file, typesFile);
  assert.throws(() => run('types', packed.file, '--check', '--artboard=thumbnail'), /missing or stale/);
  const [trace] = run('trace', packed.file, '--trace=850', '--commands=correct@0.1').trace;
  assert.equal(trace.markers[0].audio, 'cue');
  assert.equal(run('trace', packed.file, '--trace=0').trace[0].values.title, 'constructor');
  const frame = run('frame', packed.file, '--trace=100', '--commands=title=<new>@0.001');
  const svg = readFileSync(frame.file, 'utf8');
  assert.match(svg, /direction="rtl"[^>]+clip-path="url\(#text-width-\d+\)">&lt;new&gt;<\/text>/);
  assert.match(svg, /<clipPath id="text-width-\d+"><rect x="8" y="-14" width="90"/);
  visual.semantics[0].trigger = 'title';
  write(file, JSON.stringify(bundle));
  assert.throws(() => run('check', file), /writable trigger/);
});

test('packed artboards share Allo and preview image slots and host-clock strokes', () => {
  const { file, run } = fixture('sprout');
  const visual = JSON.parse(readFileSync(file, 'utf8'));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFklEQVR4nGP8z8CwkYGBgYGJAQrgDAAqOQG2ps3ojQAAAABJRU5ErkJggg==';
  visual.images = { sample: png, unused: png };
  visual.imageSlots = { portrait: 'sample' };
  visual.palette = { accent: '#1A9876' };
  visual.channels.progress = 0;
  visual.machine.clocks = { beat: { step_hz: 60 } };
  visual.clips.pulse = { ms: 1000, tracks: { progress: [[0, 0], [1000, 1]] } };
  visual.machine.layers.push({
    name: 'beatLayer', clock: 'beat', entry: 'run',
    states: { run: { clip: 'pulse', loop: 'loop', reason: 'Show externally controlled progress.' } },
  });
  visual.artboard.nodes.push(
    { kind: 'image', image: 'portrait', x: 0, y: 0, width: 18, height: 20 },
    { kind: 'path', commands: [['M', 4, 4], ['L', 80, 4]], stroke: {
      color: { palette: 'accent' }, width: 3, cap: 'round', join: 'bevel', trim: { end: 'progress' }, dash: { intervals: [5, 3], phase: 3 },
    } },
    { kind: 'path', commands: [['M', 3, 8], ['L', 33, 8], ['M', 3, 18], ['L', 33, 18]], stroke: {
      color: '#102030', width: 3, trim: { end: 'progress' },
    } },
    { kind: 'text', text: 'Good work', x: 8, y: 4, width: 120, fontSize: 20, fill: '#FFFFFF' },
  );
  const thumbnail = structuredClone(visual);
  thumbnail.name = 'Thumbnail';
  thumbnail.artboard.nodes.push({ ...thumbnail.artboard.nodes.at(-1), fonts: [] });
  const bundle = {
    schema: 'skac.bundle/1', name: 'ProgressViews', defaultArtboard: 'full', artboards: { full: visual, thumbnail },
  };
  write(file, JSON.stringify(bundle));
  const { file: packedFile } = run('pack', file);
  const packed = JSON.parse(readFileSync(packedFile, 'utf8'));
  assert.equal(Object.keys(packed.fonts).length, 1);
  const [family] = Object.keys(packed.fonts);
  const fontSource = new URL('../../templates/fonts/allo-1.0.3/Allo-Regular.otf', import.meta.url);
  assert.deepEqual(Buffer.from(packed.fonts[family].split(',')[1], 'base64'), readFileSync(fontSource));
  assert.match(packed.fontLicenses[family], /SIL OPEN FONT LICENSE/);
  assert.deepEqual(Object.keys(packed.artboards.full.images), ['sample']);
  assert.deepEqual(packed.artboards.full.artboard.nodes.at(-1).fonts, [family]);
  assert.deepEqual(packed.artboards.thumbnail.artboard.nodes.at(-2).fonts, [family]);
  assert.deepEqual(packed.artboards.thumbnail.artboard.nodes.at(-1).fonts, []);
  assert.equal(run('check', packedFile).selectedArtboard, 'full');
  assert.equal(run('preview', packedFile, '--artboard=thumbnail').selectedArtboard, 'thumbnail');
  assert.equal(run('trace', packedFile, '--trace=508').trace[0].channels.progress, 0.5);
  const svg = readFileSync(run('frame', packedFile, '--trace=500').file, 'utf8');
  assert.ok(svg.includes(png));
  assert.match(svg, /stroke="#1A9876"[^>]+stroke-dasharray="5 3" stroke-dashoffset="3"[^>]+mask=/);
  assert.match(svg, /pathLength="1" stroke-dasharray="0\.5 0\.5"/);
  assert.match(svg, /d="M 3 8 L 33 8"[^>]+stroke="#102030"/);
  assert.doesNotMatch(svg, /M 3 18 L 33 18/);
});

test('packed asset preview embeds the exact checked source and preserves it on regeneration', () => {
  const { file, run } = fixture('sprout');
  const asset = JSON.parse(readFileSync(file, 'utf8'));
  const option = '</script><p>literal enum option</p>';
  asset.machine.values.label = { type: 'enum', options: ['default', option] };
  write(file, JSON.stringify(asset));
  const packed = run('pack', file);
  const preview = run('preview', packed.file, '--size=390x844', '--reduced');
  const html = readFileSync(preview.file, 'utf8');
  const data = html.match(/<script id="scene" type="application\/json">(.*?)<\/script>/s)[1];
  assert.equal(preview.renderer, 'svg');
  assert.equal(JSON.parse(data).source, readFileSync(packed.file, 'utf8'));
  assert.deepEqual(JSON.parse(data).size, [390, 844]);
  assert.equal(JSON.parse(data).reduced, true);
  assert.ok(!html.includes(option));
  assert.throws(() => run('preview', packed.file), /cannot write/);
  run('preview', packed.file, '--size=390x844', '--reduced', '--force');
  assert.equal(readFileSync(preview.file, 'utf8'), html);
  assert.throws(() => run('preview', packed.file, `--out=${packed.file}`, '--force'), /same file/);
});

test('SVG trim restarts dash phase and shares opacity across closed contours', () => {
  const { file, run } = fixture('sprout');
  const asset = JSON.parse(readFileSync(file, 'utf8'));
  asset.artboard.nodes = [
    { kind: 'path', commands: [['M', 10, 20], ['L', 110, 20]], stroke: {
      color: '#0099FF', width: 4, trim: { start: 0.2, end: 0.75 }, dash: { intervals: [8, 8], phase: 3 },
    } },
    { kind: 'path', commands: [['M', 10, 30], ['L', 30, 30], ['Z'], ['L', 10, 70]], opacity: 0.5, stroke: {
      color: '#002244', width: 4, trim: { start: 0.25, end: 0.75 },
    } },
  ];
  write(file, JSON.stringify(asset));
  const svg = readFileSync(run('frame', file).file, 'utf8');
  assert.match(svg, /stroke="#0099FF" stroke-dasharray="8 8" stroke-dashoffset="-17"[^>]+mask=/);
  assert.match(svg, /<g opacity="0\.5"><path d="M 10 30 L 30 30 Z"[^>]+stroke-dashoffset="-0\.5"\/><path d="M 10 30 L 10 70"[^>]+stroke-dashoffset="0"\/><\/g>/);
});

test('sparse transition tracks blend through artwork defaults and lower layers', () => {
  const { file, run } = fixture('sprout');
  const asset = {
    schema: 'skac.asset/1', name: 'BlendAudit',
    artboard: { width: 100, height: 100, nodes: [{ kind: 'ellipse', x: 'x', y: 'y', width: 10, height: 10, fill: '#FFFFFF' }] },
    channels: { x: 0, y: 0 },
    clips: {
      underneath: { ms: 0, tracks: { x: [[0, 20]] } },
      before: { ms: 1000, tracks: { x: [[0, 80]] } },
      after: { ms: 1000, tracks: { y: [[0, 40]] } },
    },
    machine: { schema: 'skac.machine/1', values: { go: { type: 'trigger' } }, layers: [
      { name: 'underneath', entry: 'rest', states: { rest: { clip: 'underneath' } } },
      {
        name: 'main', entry: 'before', states: { before: { clip: 'before' }, after: { clip: 'after' } },
        transitions: [{ from: 'before', to: 'after', when: [['go']], duration_ms: 100, ease: 'linear' }],
      },
    ] },
  };
  write(file, JSON.stringify(asset));
  const packed = run('pack', file).file;
  assert.ok(run('check', packed).warnings.some(({ code, where }) =>
    code === 'sparse-blend' && where === 'machine.layers.main.transitions[0]'));
  const { trace } = run('trace', packed, '--trace=9,10,60,110', '--commands=go@0.01');
  assert.deepEqual(trace.map(({ channels: { x, y } }) => [x, y]), [[80, 0], [80, 0], [50, 20], [20, 40]]);
});

test('packed checks report clock warnings and reject invalid font headers', () => {
  const { file, cwd, run } = fixture('sprout');
  const asset = JSON.parse(readFileSync(file, 'utf8'));
  asset.machine.clocks = { beat: { wrap_ms: 1500, step_hz: 100 } };
  asset.clips.pulse = { ms: 1000, tracks: {} };
  asset.machine.layers.push({
    name: 'clocked', clock: 'beat', entry: 'pulse',
    states: { pulse: { clip: 'pulse', loop: 'loop', reason: 'Check the clock boundary.' } },
  });
  write(file, JSON.stringify(asset));
  assert.ok(run('check', run('pack', file).file).warnings.some(({ error }) => /does not divide beat.wrap_ms/.test(error)));
  write(join(cwd, 'invalid.ttf'), 'Plain text posing as a font');
  assert.throws(() => run('resource', 'invalid.ttf'), /invalid TTF or OTF font header/);
  asset.fonts = { broken: 'data:font/ttf;base64,AAEAAA==' };
  write(file, JSON.stringify(asset));
  assert.throws(() => run('check', file), /fonts.broken: expected a TTF or OTF font header/);
});

test('pack compacts larger authoring sources while keeping the runtime size limit', () => {
  const { file, cwd, run } = fixture('sprout');
  const text = readFileSync(file, 'utf8').padStart(1024 * 1024 + 1, ' ');
  write(file, text);
  assert.equal(run('check', file).ok, true);
  assert.ok(run('pack', file).bytes < 10_000);
  write(join(cwd, 'large.skmotion'), text);
  assert.throws(() => run('check', 'large.skmotion'), /at most 1 MiB/);
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
