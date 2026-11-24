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
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES5, jsx: ts.JsxEmit.ReactJSX },
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

test('mobile binding initializes before the first pose and applies batches between capped frames', () => {
  const core = load('templates/motion/machine.ts', { './motion': load('templates/motion/motion.ts') });
  const reactions = [];
  let tick;
  const { useMachine } = load('runtime/useMachine.ts', {
    '../templates/motion/machine': core,
    './version': {},
    react: { useCallback: (fn) => fn, useMemo: (fn) => fn(), useEffect: (fn) => fn() },
    'react-native-worklets': {
      scheduleOnUI: (fn, ...args) => fn(...args), scheduleOnRN: (fn, ...args) => fn(...args),
    },
    'react-native-reanimated': {
      useSharedValue: (value) => ({ value }), useReducedMotion: () => false,
      useFrameCallback: (callback) => { tick = callback; return { setActive() {} }; },
      useAnimatedReaction: (prepare, apply) => {
        let previous;
        reactions.push(() => { const next = prepare(); apply(next, previous); previous = next; });
      },
    },
  }, 'production');
  const machine = {
    schema: 'skac.machine/1',
    values: { title: { type: 'string', default: 'Default' }, visible: { type: 'boolean', default: false } },
    layers: [{
      name: 'main', entry: [{ to: 'show', when: [['visible', '==', true]] }, { to: 'hide' }],
      states: { show: { clip: 'moving' }, hide: { clip: 'hidden' } },
    }],
  };
  const changes = [];
  const handle = useMachine(machine, {
    moving: { ms: 100, play: (time) => ({ channels: { position: 10 + time } }) },
    hidden: { ms: 0, play: () => ({ channels: { position: 0 } }) },
  }, { initialValues: { title: 'Ready', visible: true }, frameRate: 25, observeValues: ['title', 'visible'],
    onValuesChange: (values) => changes.push({ ...values }) });
  assert.equal(handle.pose.value.channels.position, 10);
  const frame = (ms) => { tick({ timeSincePreviousFrame: ms }); reactions.forEach((reaction) => reaction()); };
  frame(10);
  assert.equal(handle.pose.value.channels.position, 10);
  handle.setValues({ title: 'Playing', visible: false });
  frame(10);
  assert.equal(handle.pose.value.channels.position, 30);
  assert.deepEqual(changes, [{ title: 'Ready', visible: true }, { title: 'Playing', visible: false }]);
  frame(10);
  assert.equal(changes.length, 2);
  assert.throws(() => handle.setValues({ title: 4, visible: true }), /takes a string/);
  assert.equal(handle.readOnUI('visible'), false);

  const beat = { value: 2400 };
  const clocked = useMachine({
    schema: 'skac.machine/1',
    clocks: { beat: { step_hz: 60 } },
    layers: [{ name: 'pulse', clock: 'beat', entry: 'on', states: { on: { clip: 'moving', loop: 'loop' } } }],
  }, { moving: { ms: 1000, play: (time) => ({ channels: { progress: time } }) } }, { clocks: { beat } });
  assert.equal(clocked.pose.value.channels.progress, 0);
  beat.value = 2640;
  reactions.forEach((reaction) => reaction());
  assert.equal(clocked.pose.value.channels.progress, 240);
});

test('production Worklets transform preserves asset tracks, marker crossings and the Skia v3 draw calls', async () => {
  const validator = await import('../../runtime/machine-schema.js');
  const motion = load('templates/motion/motion.ts', {}, 'production');
  const core = load('templates/motion/machine.ts', { './motion': motion }, 'production');
  const base64 = load('runtime/base64.ts', {}, 'production');
  const binary = load('runtime/asset-binary.ts', { './base64': base64 }, 'production');
  const runtime = load('runtime/asset.ts', {
    './machine-schema.js': validator,
    '../templates/motion/motion': motion,
    './asset-image': load('runtime/asset-image.ts', { './base64': base64, './asset-binary': binary }, 'production'),
    './base64': base64,
    './asset-binary': binary,
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
  asset.fonts = { ui: 'data:font/ttf;base64,font' };
  asset.artboard.nodes.push({
    kind: 'text', text: { value: 'title' }, x: 8, y: 10, width: 120, fontSize: 16,
    fonts: ['ui'], fontFeatures: [{ name: 'tnum', value: 1 }], direction: 'rtl', align: 'end', fill: '#FFFFFF',
  });
  asset.artboard.nodes.push({ kind: 'image', image: 'painted', x: 1, y: 2, width: 18, height: 20, opacity: 0.5 });
  asset.artboard.nodes.push({ kind: 'image', image: 'duplicate', x: 0, y: 0, width: 18, height: 20, opacity: 0 });
  asset.artboard.nodes.push({
    kind: 'mesh', image: 'portrait', opacity: 0.75,
    vertices: [[0, 0, 0, 0], ['lightX', 0, 1, 0], [0, 20, 0, 1]],
    indices: [0, 1, 2],
    pins: {
      tip: {
        triangle: 0, weights: [0, 0.5, 0.5],
        children: [{ kind: 'ellipse', x: 0, y: 0, width: 2, height: 2, fill: '#000000' }],
      },
    },
  });
  asset.images = {
    painted: 'data:image/webp;base64,painted', duplicate: 'data:image/webp;base64,painted', unused: 'data:image/webp;base64,unused',
  };
  asset.imageSlots = { portrait: 'painted' };
  asset.palette = { accent: '#0D7654' };
  const strokePath = [['M', 1, 2], ['L', 80, 2]];
  asset.artboard.nodes.push({ kind: 'path', commands: strokePath, stroke: {
    color: { palette: 'accent' }, width: 4, cap: 'round', join: 'bevel',
    trim: { start: 0.2, end: 0.75 }, dash: { intervals: [5, 3], phase: 'lightX' },
  } });
  const shaders = [];
  const image = {
    width: () => 2, height: () => 3,
    makeShaderOptions(...options) { shaders.push(options); return 'source-texture'; },
  };
  const imageDraws = [];
  const meshDraws = [];
  const decodes = [];
  const gradients = [];
  const filters = [];
  const fonts = [];
  const paragraphs = [];
  const translations = [];
  const clipsDrawn = [];
  const clipRects = [];
  const strokes = [];
  let pathBuilds = 0;
  const pathBuilder = () => {
    pathBuilds++;
    const points = [];
    return {
      moveTo(x, y) { points.push([x, y]); }, lineTo(x, y) { points.push([x, y]); },
      quadTo() {}, cubicTo() {}, close() {}, detach: () => points,
    };
  };
  const byteReads = [];
  const skia = {
    Data: {
      fromBase64: (data) => data,
      fromBytes(data) {
        assert.equal(data.byteOffset, 0);
        assert.equal(data.byteLength, data.buffer.byteLength);
        byteReads.push(Array.from(data));
        return 'native-bytes';
      },
    },
    Typeface: { MakeFreeTypeFaceFromData: (data) => data },
    TypefaceFontProvider: { Make: () => ({ registerFont: (...args) => fonts.push(args) }) },
    ParagraphBuilder: { Make(style, provider) {
      assert.ok(provider);
      let text;
      let width;
      return {
        pushStyle(attributes) {
          assert.deepEqual(Array.from(attributes.fontFamilies), ['ui']);
          assert.deepEqual(Array.from(attributes.fontFeatures, ({ name, value }) => [name, value]), [['tnum', 1]]);
        },
        addText(value) { text = value; },
        pop() {},
        build() {
          return {
            layout(value) { width = value; },
            paint(_canvas, x, y) { paragraphs.push([text, x, y, width, style.textDirection, style.textAlign]); },
          };
        },
      };
    } },
    Image: { MakeImageFromEncoded(data) { decodes.push(data); return image; } },
    Paint: () => ({
      setAntiAlias() {}, setColor(color) { this.color = color; }, setAlphaf(alpha) { this.alpha = alpha; },
      setShader(shader) { this.shader = shader; }, setMaskFilter(filter) { filters.push(filter); },
      setStyle(style) { this.style = style; }, setStrokeWidth(width) { this.width = width; },
      setStrokeCap(cap) { this.cap = cap; }, setStrokeJoin(join) { this.join = join; },
      setPathEffect(effect) { this.effect = effect; },
    }),
    Color: (hex) => Object.assign([0, 0, 0, 1], { hex }),
    Path: { Trim: (...args) => args },
    PathEffect: { MakeDash: (...args) => args },
    PathBuilder: { Make: pathBuilder },
    Shader: { MakeRadialGradient(center) { gradients.push(center.x); } },
    MaskFilter: { MakeBlur: (...args) => args },
    XYWHRect: (...xywh) => xywh,
    RRectXY: (rect) => rect,
    MakeVertices: (mode, positions, textures, _colors, indices) => ({ mode, positions, textures, indices }),
  };
  const canvas = {
    save() {}, restore() {}, translate(x, y) { translations.push([x, y]); }, scale() {}, rotate() {},
    clipRect(rect) { clipRects.push(rect); },
    clipPath(path, op, antiAlias) { clipsDrawn.push({ path, op, antiAlias }); },
    drawPath(path, paint) {
      if (paint.style === 1) strokes.push(JSON.parse(JSON.stringify({
        path, color: paint.color.hex, width: paint.width, cap: paint.cap, join: paint.join, effect: paint.effect,
      })));
    },
    drawOval() {}, drawRRect() {},
    drawImageRectOptions(image, src, dest, filter, mipmap, paint) {
      imageDraws.push({ image, src, dest, filter, mipmap, alpha: paint.alpha });
    },
    drawVertices(vertices, blend, paint) {
      meshDraws.push({ ...JSON.parse(JSON.stringify(vertices)), blend, alpha: paint.alpha, shader: paint.shader });
    },
  };
  const { decodeAssetImages, drawAsset, prepareAssetDrawing, rebindAssetMeshShaders } = load('runtime/asset-draw.ts', {
    './asset': runtime,
    './asset-layout': load('runtime/asset-layout.ts', {}, 'production'),
    './asset-mesh': load('runtime/asset-mesh.ts', {}, 'production'),
    './asset-roll': load('runtime/asset-roll.ts', { './asset-unicode': load('runtime/asset-unicode.ts', {}, 'production') }, 'production'),
    './asset-ink': load('runtime/asset-ink.ts', { './asset-unicode': load('runtime/asset-unicode.ts', {}, 'production') }, 'production'),
    'react-native-skia': {
      Skia: skia, BlurStyle: { Normal: 0 }, TileMode: { Clamp: 0, Decal: 3 }, FilterMode: { Linear: 1 },
      MipmapMode: { None: 0 }, ClipOp: { Intersect: 1 }, VertexMode: { Triangles: 0 }, BlendMode: { SrcOver: 3 },
      TextDirection: { RTL: 0, LTR: 1 }, TextAlign: { Start: 4, End: 5, Center: 2 },
      PaintStyle: { Stroke: 1 }, StrokeCap: { Round: 1 }, StrokeJoin: { Bevel: 2 },
    },
  }, 'production');
  assert.equal(typeof drawAsset.__workletHash, 'number');
  const images = decodeAssetImages(asset);
  const drawing = prepareAssetDrawing(asset, images);
  const fixedPaths = pathBuilds;
  assert.ok(fixedPaths > 0);
  drawAsset(canvas, drawing, pose.channels, 320, 260, images, { title: 'مرحبا' });
  assert.deepEqual(fonts, [['font', 'ui']]);
  assert.deepEqual(paragraphs, [['مرحبا', 8, 10, 120, 0, 5]]);
  assert.equal(pathBuilds, fixedPaths + 1, 'the channel-driven clip is the only path rebuilt');
  assert.deepEqual(decodes, ['painted']);
  assert.equal(images.duplicate, images.painted);
  assert.equal(images.portrait, images.painted);
  assert.equal(Object.hasOwn(images, 'unused'), false);
  assert.deepEqual(clipsDrawn, [{ path: [[-40, -150], [44, -150], [44, 20]], op: 1, antiAlias: true }]);
  assert.deepEqual(imageDraws, [{ image, src: [0, 0, 2, 3], dest: [1, 2, 18, 20], filter: 1, mipmap: 0, alpha: 0.5 }]);
  assert.ok(gradients.includes(44));
  assert.deepEqual(filters, [[0, 5, true]]);
  assert.deepEqual(translations.slice(0, 2), [[40, 0], [80, 223]]);
  assert.ok(translations.some(([x, y]) => x === 22 && y === 10));
  assert.deepEqual(shaders, [[3, 3, 1, 0]]);
  assert.deepEqual(strokes, [{
    path: [[[1, 2], [80, 2]], 0.2, 0.75, false],
    color: '#0D7654', width: 4, cap: 1, join: 2, effect: [[5, 3], 44],
  }]);
  assert.deepEqual(meshDraws, [{
    mode: 0, positions: [{ x: 0, y: 0 }, { x: 44, y: 0 }, { x: 0, y: 20 }],
    textures: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 3 }],
    indices: [0, 1, 2], alpha: 0.75, blend: 3, shader: 'source-texture',
  }]);
  const warmed = { ...image, makeShaderOptions: () => 'warmed-texture' };
  const rebound = rebindAssetMeshShaders(drawing, { ...images, portrait: warmed });
  drawAsset(canvas, rebound, { ...pose.channels, lightX: 30 }, 320, 260, { ...images, portrait: warmed });
  assert.deepEqual(meshDraws[1].positions[1], { x: 30, y: 0 });
  assert.equal(meshDraws[1].shader, 'warmed-texture');
  const replacement = { ...warmed, width: () => 27, height: () => 31 };
  const overridden = decodeAssetImages(asset, { portrait: replacement });
  assert.equal(overridden.portrait, replacement);
  drawAsset(canvas, prepareAssetDrawing(asset, overridden), pose.channels, 320, 260, overridden);
  assert.deepEqual(meshDraws[2].textures, [{ x: 0, y: 0 }, { x: 27, y: 0 }, { x: 0, y: 31 }]);
  assert.throws(() => decodeAssetImages(asset, { invalid: replacement }), /Unknown motion image slot/);
  clipRects.length = 0;
  drawAsset(canvas, drawing, pose.channels, 240, 100, images, {}, { fit: 'cover' });
  assert.deepEqual(clipRects[0], [0, 0, 240, 100]);

  const storage = Uint8Array.of(10, 20, 30, 40, 50);
  const raster = { mime: 'image/webp', bytes: storage.subarray(1, 3) };
  const typeface = { mime: 'font/otf', bytes: storage.subarray(3) };
  const raw = { ...asset, images: { painted: raster, duplicate: raster }, fonts: { ui: typeface, other: typeface } };
  const rawImages = decodeAssetImages(raw);
  prepareAssetDrawing(raw, rawImages);
  assert.deepEqual(byteReads, [[20, 30], [40, 50]], 'the Skia factories read only the exact bytes, once per resource');
  assert.equal(rawImages.painted, rawImages.portrait);
  assert.equal(rawImages.painted, rawImages.duplicate);
  assert.deepEqual(fonts.slice(-2), [['native-bytes', 'ui'], ['native-bytes', 'other']]);

  const host = { face: 'borrowed', dispose: () => assert.fail('host face was disposed') };
  const optional = { ...asset, fonts: { fallback: typeface }, fontSlots: { ui: { fallback: 'fallback' } } };
  prepareAssetDrawing(optional, images);
  assert.deepEqual(fonts.slice(-2), [['native-bytes', 'fallback'], ['native-bytes', 'ui']]);
  const beforeOverride = byteReads.length;
  prepareAssetDrawing(optional, images, { ui: host });
  assert.equal(byteReads.length, beforeOverride, 'the replaced embedded fallback is not decoded');
  assert.deepEqual(fonts.at(-1), [host, 'ui']);
  const bound = asset.artboard.nodes.find((node) => node.kind === 'text');
  const shared = {
    ...optional,
    fontSlots: { ...optional.fontSlots, label: { fallback: 'fallback' } },
    artboard: { ...asset.artboard, nodes: [...asset.artboard.nodes, { ...bound, fonts: ['label'] }] },
  };
  prepareAssetDrawing(shared, images, { ui: host });
  assert.deepEqual(fonts.slice(-3), [['native-bytes', 'fallback'], [host, 'ui'], ['native-bytes', 'label']]);
  const external = { ...asset, fonts: undefined, fontSlots: { ui: {} } };
  assert.throws(() => prepareAssetDrawing(external, images), /Missing motion font slots: ui/);
  assert.throws(() => prepareAssetDrawing(external, images, { wrong: host }), /fontSlots.wrong: unknown font slot/);
  const beforeHost = byteReads.length;
  const hostDrawing = prepareAssetDrawing(external, images, { ui: host });
  drawAsset(canvas, hostDrawing, pose.channels, 320, 260, images, { title: 'Host font' });
  assert.equal(paragraphs.at(-1)[0], 'Host font');
  assert.equal(byteReads.length, beforeHost);
  assert.deepEqual(fonts.at(-1), [host, 'ui']);
});

test('drawing a clip in the host canvas supports absolute time and direct shared values', () => {
  const renders = [];
  const { drawMotionClip } = load('runtime/mobile.tsx', {
    'react': { forwardRef: (render) => render },
    'react/jsx-runtime': {},
    'react-native': {},
    'react-native-skia': {},
    'react-native-reanimated': {},
    './asset': {},
    './asset-draw': { drawAsset: (...args) => renders.push(args) },
    './asset-load': {},
    './asset-layout': {},
    './useMachine': {},
    './useMotionAsset': {},
  }, 'production');
  assert.equal(typeof drawMotionClip.__workletHash, 'number');
  const canvas = {};
  const images = {};
  const drawing = { textBindings: ['title'] };
  const asset = {
    drawing, images, machine: { values: { title: { default: 'Ready' } } },
    clips: { pulse: { ms: 120, reducedAt: 50, play: (time) => ({ channels: { time, glow: 0 } }) } },
  };
  const glow = { value: 0.25 };
  const options = { width: 120, height: 80, channels: { glow } };
  drawMotionClip(canvas, asset, 'pulse', 60, options);
  glow.value = 0.5;
  drawMotionClip(canvas, asset, 'pulse', 250, options);
  drawMotionClip(canvas, asset, 'pulse', -20, { ...options, text: { title: 'Back' } });
  drawMotionClip(canvas, asset, 'pulse', 90, { ...options, reduced: true });
  assert.deepEqual(renders.map(([target, scene, channels, width, height, resources, values]) => {
    assert.equal(target, canvas);
    assert.equal(scene, drawing);
    assert.equal(resources, images);
    assert.equal(width, 120);
    assert.equal(height, 80);
    return [channels.time, channels.glow, values.title];
  }), [[60, 0.25, 'Ready'], [120, 0.5, 'Ready'], [0, 0.5, 'Back'], [50, 0.5, 'Ready']]);
  assert.throws(() => drawMotionClip(canvas, asset, 'missing', 0, options), /Unknown motion clip/);
});

test('a rolling number draws an odometer through the production worklet transform', async () => {
  const validator = await import('../../runtime/machine-schema.js');
  const motion = load('templates/motion/motion.ts', {}, 'production');
  const base64 = load('runtime/base64.ts', {}, 'production');
  const binary = load('runtime/asset-binary.ts', { './base64': base64 }, 'production');
  const runtime = load('runtime/asset.ts', {
    './machine-schema.js': validator, '../templates/motion/motion': motion,
    './asset-image': load('runtime/asset-image.ts', { './base64': base64, './asset-binary': binary }, 'production'),
    './base64': base64, './asset-binary': binary,
  }, 'production');
  const asset = runtime.parseAsset(JSON.stringify({
    schema: 'skac.asset/1', name: 'Roll',
    artboard: { width: 200, height: 60, nodes: [{
      kind: 'text', text: { value: 'to' }, roll: { progress: 'turn', from: 'from', ease: 'linear' }, x: 10, y: 5, width: 100, fontSize: 20,
      fill: '#000000', fonts: [], align: 'center',
    }] },
    channels: { turn: 0 }, clips: { run: { ms: 100, tracks: { turn: [[0, 0], [100, 1]] } } },
    machine: { schema: 'skac.machine/1', values: { from: { type: 'string', default: '+9' }, to: { type: 'string', default: '+10' } },
      layers: [{ name: 'roll', entry: 'run', states: { run: { clip: 'run' } } }] },
  }));
  const paints = [];
  const clips = [];
  const features = [];
  let builds = 0;
  const skia = {
    Data: { fromBase64: (data) => data },
    Typeface: { MakeFreeTypeFaceFromData: (data) => data },
    TypefaceFontProvider: { Make: () => ({ registerFont() {} }) },
    // Every character is 10 wide; a centred line starts at (width - length) / 2. Unseen runs are laid out but not painted.
    ParagraphBuilder: { Make(style) {
      builds++;
      let text = '';
      let shown = '';
      let color;
      return {
        pushStyle(attributes) {
          features.push(Array.from(attributes.fontFeatures ?? [], ({ name }) => name).join());
          color = attributes.color;
        },
        addText(value) { text += value; if (color !== 'rgba(0,0,0,0)') shown += value; },
        pop() {},
        build: () => {
          let left = 0;
          return {
            layout(width) { left = style.textAlign === 2 ? (width - text.length * 10) / 2 : 0; },
            getLongestLine: () => text.length * 10, getHeight: () => 24, getLineMetrics: () => [{ baseline: 18 }],
            getRectsForRange: (start, end) => [{ x: left + start * 10, y: 0, width: (end - start) * 10, height: 24 }],
            paint(_canvas, x, y) { paints.push([shown, x, y]); },
          };
        },
      };
    } },
    Color: (hex) => hex,
    XYWHRect: (...xywh) => xywh,
    Paint: () => ({ setImageFilter(filter) { this.filter = filter; } }),
    ImageFilter: { MakeBlur: (sigmaX, sigmaY) => ({ sigmaX, sigmaY }) },
  };
  const layers = [];
  const canvas = {
    save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
    clipRect(rect) { clips.push(rect); },
    saveLayer(paint) { layers.push(paint.filter); },
  };
  const { drawAsset, prepareAssetDrawing } = load('runtime/asset-draw.ts', {
    './asset': runtime,
    './asset-layout': load('runtime/asset-layout.ts', {}, 'production'),
    './asset-mesh': load('runtime/asset-mesh.ts', {}, 'production'),
    './asset-roll': load('runtime/asset-roll.ts', { './asset-unicode': load('runtime/asset-unicode.ts', {}, 'production') }, 'production'),
    './asset-ink': load('runtime/asset-ink.ts', { './asset-unicode': load('runtime/asset-unicode.ts', {}, 'production') }, 'production'),
    'react-native-skia': {
      Skia: skia, ClipOp: { Intersect: 1 }, TextDirection: { RTL: 0, LTR: 1 }, TextAlign: { Start: 4, End: 5, Center: 2 }, TileMode: { Decal: 3 },
    },
  }, 'production');
  const drawing = prepareAssetDrawing(asset, {});
  builds = 0;
  // Half way from 9 to 10 is 9.5: the units turn 9 -> 0 and the tens enter from blank, both half way. Skia lays out "+0" (centred at
  // 40 in the 100-wide box) and "+00" (at 35); half way the "+" is at 37.5, drawn in the "+0" layout moved 2.5 left, and the digit run
  // starts after it at 10 + 47.5.
  drawAsset(canvas, drawing, { turn: 0.5 }, 200, 60, {}, { from: '+9', to: '+10' });
  assert.deepEqual(paints, [
    ['+', 7.5, 5], ['1', 52.5, 5 + 12], ['9', 62.5, 5 - 12], ['0', 62.5, 5 + 12],
  ]);
  assert.deepEqual(clips, [[0, 0, 200, 60], [57.5, 5, 5, 24], [62.5, 5, 10, 24]]); // the board, then one column per place
  // The digit columns were laid out once in prepare: a rolling frame builds only the "+0" and "+00" layouts, not one per digit drawn.
  assert.equal(builds, 2);
  paints.length = 0;
  clips.length = 0;
  // At rest the roll is the plain paragraph of the number it shows, so it lays out exactly as asset check measures it.
  drawAsset(canvas, drawing, { turn: 0 }, 200, 60, {}, { from: '+9', to: '+10' });
  assert.deepEqual(paints, [['+9', 10, 5]]);
  assert.ok(features.every((list) => list.includes('tnum')), 'digits draw with tabular figures');
  paints.length = 0;
  // A value with two runs of digits cannot roll: it cuts at half way.
  drawAsset(canvas, drawing, { turn: 0.4 }, 200, 60, {}, { from: '1,200', to: '1,300' });
  assert.deepEqual(paints.map(([text]) => text), ['1,200']);
  // The clip runs the roll in 100 ms: 0 to 240 at a tenth of the way turns the units 2400 times a second and the tens 240, so both
  // smear (a vertical blur of 0.2 of the 24 pt line), and the hundreds, at 24 a second, stay sharp.
  drawAsset(canvas, drawing, { turn: 0.1 }, 200, 60, {}, { from: '0', to: '240' });
  assert.deepEqual(layers, [{ sigmaX: 0, sigmaY: 24 * 0.2 }, { sigmaX: 0, sigmaY: 24 * 0.2 }]);
});

test('a row lays out by ink and draws its plate through the production worklet transform', async () => {
  const validator = await import('../../runtime/machine-schema.js');
  const motion = load('templates/motion/motion.ts', {}, 'production');
  const base64 = load('runtime/base64.ts', {}, 'production');
  const binary = load('runtime/asset-binary.ts', { './base64': base64 }, 'production');
  const runtime = load('runtime/asset.ts', {
    './machine-schema.js': validator, '../templates/motion/motion': motion,
    './asset-image': load('runtime/asset-image.ts', { './base64': base64, './asset-binary': binary }, 'production'),
    './base64': base64, './asset-binary': binary,
  }, 'production');
  const asset = runtime.parseAsset(JSON.stringify({
    schema: 'skac.asset/1', name: 'Row',
    artboard: { width: 180, height: 120, nodes: [{ kind: 'group', x: 90, y: 60,
      row: { gap: 4, align: 'center', plate: { padding: [10, 6], fill: '#FFF6DC', widest: '+88' } },
      children: [
        { kind: 'ellipse', x: 0, y: 0, width: 18, height: 18, fill: '#E6B43C' },
        { kind: 'text', text: { value: 'count' }, x: 0, y: 0, width: 80, fontSize: 20, fill: '#1D2B2A' },
      ] }] },
    channels: {}, clips: { show: { ms: 0, tracks: {} } },
    machine: { schema: 'skac.machine/1', values: { count: { type: 'string', default: '+3' } },
      layers: [{ name: 'counter', entry: 'show', states: { show: { clip: 'show' } } }] },
  }));
  const calls = [];
  // Every character is 10 wide on a baseline at 18, its glyph drawn 1..9 across and 14 tall above the baseline (a cap height of 14).
  const font = { measureText: (text) => ({ x: 0, y: text === 'x' ? -10 : -14, width: 10, height: text === 'x' ? 10 : 14 }) };
  const skia = {
    Data: { fromBase64: (data) => data },
    Typeface: { MakeFreeTypeFaceFromData: (data) => data },
    TypefaceFontProvider: { Make: () => ({ registerFont() {} }) },
    ParagraphBuilder: { Make() {
      let text = '';
      return {
        pushStyle() {}, pop() {}, addText(value) { text += value; },
        build: () => ({
          layout() {}, getLongestLine: () => text.length * 10, getHeight: () => 24, getLineMetrics: () => [{ baseline: 18 }],
          getRectsForRange: (start, end) => [{ x: start * 10, y: 0, width: (end - start) * 10, height: 24 }],
          extendedVisit(visit) {
            const chars = [...text];
            visit(0, { font, origin: { x: 0, y: 0 }, glyphs: chars.map(() => 1), positions: chars.map((_, i) => ({ x: i * 10, y: 18 })),
              bounds: chars.map(() => ({ x: 1, y: -14, width: 8, height: 14 })) });
          },
          paint(_canvas, x, y) { calls.push(['paint', text, x, y]); },
        }),
      };
    } },
    Paint: () => ({ setAntiAlias() {}, setColor() {}, setStyle() {}, setStrokeWidth() {}, setAlphaf() {}, setBlendMode() {} }),
    RRectXY: (rect, rx, ry) => ({ rect, rx, ry }),
    Color: (hex) => hex,
    XYWHRect: (...xywh) => xywh,
  };
  const canvas = {
    save() {}, restore() {}, scale() {}, rotate() {}, clipRect() {},
    translate(x, y) { calls.push(['translate', x, y]); },
    drawRRect(rrect) { calls.push(['plate', ...rrect.rect, rrect.rx]); },
    drawOval(rect) { calls.push(['oval', ...rect]); },
  };
  const unicode = load('runtime/asset-unicode.ts', {}, 'production');
  const { drawAsset, prepareAssetDrawing } = load('runtime/asset-draw.ts', {
    './asset': runtime,
    './asset-layout': load('runtime/asset-layout.ts', {}, 'production'),
    './asset-mesh': load('runtime/asset-mesh.ts', {}, 'production'),
    './asset-roll': load('runtime/asset-roll.ts', { './asset-unicode': unicode }, 'production'),
    './asset-ink': load('runtime/asset-ink.ts', { './asset-unicode': unicode }, 'production'),
    'react-native-skia': {
      Skia: skia, ClipOp: { Intersect: 1 }, PaintStyle: { Fill: 0, Stroke: 1 }, TextDirection: { RTL: 0, LTR: 1 },
      TextAlign: { Start: 4, End: 5, Center: 2 },
    },
  }, 'production');
  drawAsset(canvas, prepareAssetDrawing(asset, {}), {}, 180, 120, {}, { count: '+3' });
  // "+3" inks 1..19 with its cap band 4..18 (centre 11); the disc is 0..18 (centre 9). With a 4 pt gap the pair is 40 wide, centred: the
  // disc moves to -20 and up 9, the text to 1 and up 11. The plate is sized for "+88" (28 + 4 + 18 = 50, padded to 70) and the taller
  // half-height (the disc's 9, padded to 15), a full pill.
  const after = calls.slice(calls.findIndex(([kind]) => kind === 'plate'));
  assert.deepEqual(after, [
    ['plate', -35, -15, 70, 30, 15],
    ['translate', -20, -9], ['oval', 0, 0, 18, 18],
    ['translate', 1, -11], ['paint', '+3', 0, 0],
  ]);
});

test('a row on react-native-skia without extendedVisit falls back to advances and cap height', async () => {
  const validator = await import('../../runtime/machine-schema.js');
  const motion = load('templates/motion/motion.ts', {}, 'production');
  const base64 = load('runtime/base64.ts', {}, 'production');
  const binary = load('runtime/asset-binary.ts', { './base64': base64 }, 'production');
  const runtime = load('runtime/asset.ts', {
    './machine-schema.js': validator, '../templates/motion/motion': motion,
    './asset-image': load('runtime/asset-image.ts', { './base64': base64, './asset-binary': binary }, 'production'),
    './base64': base64, './asset-binary': binary,
  }, 'production');
  const asset = runtime.parseAsset(JSON.stringify({
    schema: 'skac.asset/1', name: 'Row',
    artboard: { width: 180, height: 120, nodes: [{ kind: 'group', x: 90, y: 60,
      row: { gap: 4, align: 'center', plate: { padding: [10, 6], fill: '#FFF6DC', widest: '+88' } },
      children: [
        { kind: 'ellipse', x: 0, y: 0, width: 18, height: 18, fill: '#E6B43C' },
        { kind: 'text', text: { value: 'count' }, x: 0, y: 0, width: 80, fontSize: 20, fill: '#1D2B2A' },
      ] }] },
    channels: {}, clips: { show: { ms: 0, tracks: {} } },
    machine: { schema: 'skac.machine/1', values: { count: { type: 'string', default: '+3' } },
      layers: [{ name: 'counter', entry: 'show', states: { show: { clip: 'show' } } }] },
  }));
  const calls = [];
  let web = false;
  // Every character is 10 wide on a baseline at 18, its glyph drawn 1..9 across and 14 tall above the baseline (a cap height of 14).
  const font = { measureText: (text) => ({ x: 0, y: text === 'x' ? -10 : -14, width: 10, height: text === 'x' ? 10 : 14 }) };
  const skia = {
    Data: { fromBase64: (data) => data },
    Typeface: { MakeFreeTypeFaceFromData: (data) => data },
    TypefaceFontProvider: { Make: () => ({ registerFont() {}, matchFamilyStyle: (name) => ({ name }) }) },
    Font: (face, size) => ({ measureText: (text) => ({ x: 0, y: text === 'x' ? -size / 2 : -size * 0.6, width: 10, height: size }) }),
    ParagraphBuilder: { Make() {
      let text = '';
      return {
        pushStyle() {}, pop() {}, addText(value) { text += value; },
        build: () => ({
          layout() {}, getLongestLine: () => text.length * 10, getHeight: () => 24, getLineMetrics: () => [{ baseline: 18 }],
          getRectsForRange: (start, end) => [{ x: start * 10, y: 0, width: (end - start) * 10, height: 24 }],
          ...(web && { extendedVisit() { throw new Error('Not implemented on React Native Web'); } }),
          paint(_canvas, x, y) { calls.push(['paint', text, x, y]); },
        }),
      };
    } },
    Paint: () => ({ setAntiAlias() {}, setColor() {}, setStyle() {}, setStrokeWidth() {}, setAlphaf() {}, setBlendMode() {} }),
    RRectXY: (rect, rx, ry) => ({ rect, rx, ry }),
    Color: (hex) => hex,
    XYWHRect: (...xywh) => xywh,
  };
  const canvas = {
    save() {}, restore() {}, scale() {}, rotate() {}, clipRect() {},
    translate(x, y) { calls.push(['translate', x, y]); },
    drawRRect(rrect) { calls.push(['plate', ...rrect.rect, rrect.rx]); },
    drawOval(rect) { calls.push(['oval', ...rect]); },
  };
  const unicode = load('runtime/asset-unicode.ts', {}, 'production');
  const { drawAsset, prepareAssetDrawing } = load('runtime/asset-draw.ts', {
    './asset': runtime,
    './asset-layout': load('runtime/asset-layout.ts', {}, 'production'),
    './asset-mesh': load('runtime/asset-mesh.ts', {}, 'production'),
    './asset-roll': load('runtime/asset-roll.ts', { './asset-unicode': unicode }, 'production'),
    './asset-ink': load('runtime/asset-ink.ts', { './asset-unicode': unicode }, 'production'),
    'react-native-skia': {
      Skia: skia, ClipOp: { Intersect: 1 }, PaintStyle: { Fill: 0, Stroke: 1 }, TextDirection: { RTL: 0, LTR: 1 },
      TextAlign: { Start: 4, End: 5, Center: 2 },
    },
  }, 'production');
  drawAsset(canvas, prepareAssetDrawing(asset, {}), {}, 180, 120, {}, { count: '+3' });
  // No extendedVisit: "+3" is its advance box, 0..20, from the cap height above the baseline at 18 down to it. The text has no font of
  // its own here, so the cap height is 0.7 of the 20 pt size, 14: the band is 4..18 (centre 11), as the measured glyphs gave. The disc is
  // 0..18. The pair is 42 wide: the disc moves to -21 and up 9, the text to 1 and up 11; the plate is sized for "+88" (30 + 4 + 18 = 52,
  // padded to 72).
  const after = calls.slice(calls.findIndex(([kind]) => kind === 'plate'));
  assert.deepEqual(after, [
    ['plate', -36, -15, 72, 30, 15],
    ['translate', -21, -9], ['oval', 0, 0, 18, 18],
    ['translate', 1, -11], ['paint', '+3', 0, 0],
  ]);
  // React Native Web has the method and throws: the same fallback.
  web = true;
  calls.length = 0;
  drawAsset(canvas, prepareAssetDrawing(asset, {}), {}, 180, 120, {}, { count: '+3' });
  assert.deepEqual(calls.slice(calls.findIndex(([kind]) => kind === 'plate')), after);
});
