import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { transformFileSync } = require('@babel/core');
const ts = require('typescript');

const load = (path, imports = {}, envName = 'development') => {
  const filename = fileURLToPath(new URL(`../../${path}`, import.meta.url));
  const { code } = transformFileSync(filename, {
    babelrc: false,
    configFile: false,
    presets: [require.resolve('@babel/preset-typescript')],
    plugins: [require.resolve('react-native-worklets/plugin')],
    envName,
  });
  // Evaluate CommonJS in Node and mirror Metro's var bindings for factory initializers.
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES5 },
  });
  const exports = {};
  runInNewContext(outputText, {
    __DEV__: envName === 'development',
    exports,
    global: { Error },
    require(specifier) {
      assert.ok(Object.hasOwn(imports, specifier), `unexpected import ${specifier}`);
      return imports[specifier];
    },
  }, { filename, displayErrors: false });
  return exports;
};

test('Worklets 0.13.0 initializes machine helpers before capturing them', () => {
  assert.equal(require('react-native-worklets/package.json').version, '0.13.0');

  const core = load('templates/motion/machine.ts', { './motion': load('templates/motion/motion.ts') });
  const { compile, start, advance, pose } = core;
  assert.equal(typeof compile.__workletHash, 'number');
  const machine = {
    schema: 'skac.machine/1',
    values: { finish: { type: 'trigger' } },
    layers: [{
      name: 'ring', entry: 'calling',
      states: { calling: { clip: 'ripple', loop: 'loop' } },
      transitions: [{ from: 'calling', to: 'exit', when: [['finish']] }],
    }],
  };
  const clips = { ripple: { ms: 500, play: (ms) => ({ channels: { radius: ms } }) } };
  const compiled = compile(machine, clips);
  assert.equal(compiled.layers[0].states[0].ms, 500);
  const clock = (_name, t) => t;
  const finished = advance(compiled, start(compiled), 200, [{ at: 100, value: 'finish', to: true }], clock);
  assert.equal(pose(compiled, clips, finished, 200, clock).channels.radius, 100);

  const seen = new Set();
  const checkCaptures = (worklet) => {
    if (seen.has(worklet)) return;
    seen.add(worklet);
    for (const [index, capture] of (worklet?.__closure ?? []).entries()) {
      assert.notEqual(capture, undefined, `${worklet.name} has an undefined capture at index ${index}`);
      if (typeof capture === 'function') checkCaptures(capture);
    }
  };
  Object.values(core).forEach(checkCaptures);
});

test('production Worklets transform preserves asset tracks, marker crossings and the Skia v3 draw calls', async () => {
  const validator = await import('../../runtime/machine-schema.js');
  const motion = load('templates/motion/motion.ts', {}, 'production');
  const core = load('templates/motion/machine.ts', { './motion': motion }, 'production');
  const runtime = load('runtime/asset.ts', {
    './machine-schema.js': validator,
    '../templates/motion/motion': motion,
    './asset-image': load('runtime/asset-image.ts', {}, 'production'),
  }, 'production');
  const asset = runtime.parseAsset(readFileSync(new URL('../../templates/assets/sprout.json', import.meta.url), 'utf8'));
  asset.artboard.nodes[0].feather = 5;
  asset.artboard.nodes[1].anchor = { x: 'left' };
  asset.artboard.nodes[1].clip = [['M', -40, -150], ['L', 'lightX', -150], ['L', 'lightX', 20], ['Z']];
  const clips = runtime.assetClips(asset);
  assert.equal(typeof clips.correct.play.__workletHash, 'number');
  const compiled = core.compile(asset.machine, clips);
  const clock = (_name, t) => t;
  const entries = [];
  const state = core.advance(compiled, core.start(compiled), 740, [
    { at: 100, value: 'correct', to: true },
    { at: 250, value: 'light', to: 1 },
  ], clock, entries);
  assert.equal(runtime.assetMarkerEvents(asset, entries)[0].name, 'rewardLanded');
  const pose = core.pose(compiled, clips, state, 740, clock);
  asset.artboard.nodes.push({ kind: 'image', image: 'painted', x: 1, y: 2, width: 18, height: 20, opacity: 0.5 });
  asset.artboard.nodes.push({ kind: 'image', image: 'duplicate', x: 0, y: 0, width: 18, height: 20, opacity: 0 });
  asset.images = {
    painted: 'data:image/webp;base64,painted', duplicate: 'data:image/webp;base64,painted', unused: 'data:image/webp;base64,unused',
  };
  const image = { width: () => 2, height: () => 3 };
  const imageDraws = [];
  const decodes = [];
  const gradients = [];
  const filters = [];
  const translations = [];
  const clipsDrawn = [];
  let pathBuilds = 0;
  const pathBuilder = () => {
    pathBuilds++;
    const points = [];
    return {
      moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); },
      quadTo() {}, cubicTo() {}, close() {}, detach: () => points,
    };
  };
  const skia = {
    Data: { fromBase64: (data) => data },
    Image: { MakeImageFromEncoded(data) { decodes.push(data); return image; } },
    Paint: () => ({
      setAntiAlias() {}, setColor() {}, setAlphaf(alpha) { this.alpha = alpha; },
      setShader() {}, setMaskFilter(filter) { filters.push(filter); },
    }),
    Color: () => [0, 0, 0, 1],
    PathBuilder: { Make: pathBuilder },
    Shader: { MakeRadialGradient(center) { gradients.push(center.x); } },
    MaskFilter: { MakeBlur: (...args) => args },
    XYWHRect: (...xywh) => xywh,
    RRectXY: (rect) => rect,
  };
  const canvas = {
    save() {}, restore() {}, translate(x, y) { translations.push([x, y]); }, scale() {}, rotate() {}, clipRect() {},
    clipPath(path, op, antiAlias) { clipsDrawn.push({ path, op, antiAlias }); },
    drawPath() {}, drawOval() {}, drawRRect() {},
    drawImageRectOptions(image, src, dest, filter, mipmap, paint) {
      imageDraws.push({ image, src, dest, filter, mipmap, alpha: paint.alpha });
    },
  };
  const { decodeAssetImages, drawAsset, prepareAssetDrawing } = load('runtime/asset-draw.ts', {
    './asset': runtime,
    './asset-layout': load('runtime/asset-layout.ts', {}, 'production'),
    'react-native-skia': { Skia: skia, BlurStyle: { Normal: 0 }, TileMode: { Clamp: 0 }, FilterMode: { Linear: 1 }, MipmapMode: { None: 0 }, ClipOp: { Intersect: 1 } },
  }, 'production');
  assert.equal(typeof drawAsset.__workletHash, 'number');
  const images = decodeAssetImages(asset);
  const drawing = prepareAssetDrawing(asset);
  const fixedPaths = pathBuilds;
  assert.ok(fixedPaths > 0);
  drawAsset(canvas, drawing, pose.channels, 320, 260, images);
  assert.equal(pathBuilds, fixedPaths + 1, 'the channel-driven clip is the only path rebuilt');
  assert.deepEqual(decodes, ['painted']);
  assert.equal(images.duplicate, images.painted);
  assert.equal(Object.hasOwn(images, 'unused'), false);
  assert.deepEqual(clipsDrawn, [{ path: [[-40, -150], [44, -150], [44, 20]], op: 1, antiAlias: true }]);
  assert.deepEqual(imageDraws, [{ image, src: [0, 0, 2, 3], dest: [1, 2, 18, 20], filter: 1, mipmap: 0, alpha: 0.5 }]);
  assert.ok(gradients.includes(44));
  assert.deepEqual(filters, [[0, 5, true]]);
  assert.deepEqual(translations.slice(0, 2), [[40, 0], [80, 223]]);
});
