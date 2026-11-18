import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const source = readFileSync(new URL('../../templates/assets/game-hud.json', import.meta.url), 'utf8');
const { outputFiles: [{ text }] } = await build({
  entryPoints: [fileURLToPath(new URL('../../runtime/mobile.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-native', 'react-native-skia', 'react-native-reanimated'],
  plugins: [{
    name: 'stub-machine',
    setup(build) {
      build.onResolve({ filter: /^\.\/useMachine$/ }, () => ({ path: 'machine-stub', external: true }));
    },
  }],
});

function harness() {
  const slots = [];
  let slot = 0;
  let live;
  let preparedPaths = 0;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      forwardRef: (fn) => (props) => fn(props, null),
      useCallback: (fn) => fn,
      useEffect() {},
      useImperativeHandle() {},
      useMemo: (compute) => compute(),
      useRef: (current) => ({ current }),
      useState: (initialize) => {
        const index = slot++;
        if (!(index in slots)) slots[index] = typeof initialize === 'function' ? initialize() : initialize;
        return [slots[index], (update) => { slots[index] = update(slots[index]); }];
      },
    },
    'react-native': {
      AppState: { currentState: 'active' },
      StyleSheet: { absoluteFill: { position: 'absolute' }, flatten: (style) => style },
      View: 'View',
    },
    'react-native-skia': {
      Canvas: 'Canvas', Picture: 'Picture', TileMode: { Clamp: 0 }, BlurStyle: { Normal: 0 },
      Skia: {
        Color: () => [0, 0, 0, 1],
        Paint: () => ({ setAntiAlias() {}, setColor() {}, setAlphaf() {}, setShader() {}, setMaskFilter() {} }),
        Shader: { MakeRadialGradient: () => ({}) },
        MaskFilter: { MakeBlur: () => ({}) },
        PathBuilder: { Make: () => {
          preparedPaths++;
          return { moveTo() {}, lineTo() {}, close() {}, detach: () => ({}) };
        } },
      },
    },
    'react-native-reanimated': {},
    'machine-stub': {
      useMachine: (_machine, _clips, options) => {
        live = options.live;
        return { pose: { value: { channels: {} } } };
      },
    },
  };
  const module = { exports: {} };
  new Function('module', 'require', text)(module, (name) => modules[name]);
  return {
    render(props = {}) {
      slot = 0;
      const element = module.exports.MotionPlayer({ source, ...props });
      return element.type(element.props);
    },
    layout(view, width, height) {
      view.props.onLayout({ nativeEvent: { layout: { width, height } } });
    },
    live: () => live,
    load: () => module.exports.loadMotionAsset(source),
    preload: module.exports.preloadMotionAsset,
    preparedPaths: () => preparedPaths,
  };
}

test('MotionPlayer derives its default aspect ratio from the asset and draws at the measured size', () => {
  const app = harness();
  let view = app.render();
  assert.deepEqual(Object.assign({}, ...view.props.style), { width: '100%', aspectRatio: 360 / 138 });
  const initialCanvas = view.props.children[0];
  assert.equal(initialCanvas.type, 'Canvas');
  assert.equal(initialCanvas.props.children, false);
  assert.equal(app.live(), false);

  app.layout(view, 300, 115);
  view = app.render();
  const canvas = view.props.children[0];
  assert.equal(canvas.type, 'Canvas');
  assert.equal(canvas.props.children.props.width, 300);
  assert.equal(canvas.props.children.props.height, 115);
  assert.equal(app.live(), true);

  app.layout(view, 540, 207);
  view = app.render();
  assert.equal(view.props.children[0].props.children.props.width, 540);
  assert.equal(view.props.children[0].props.children.props.height, 207);
  app.layout(view, 540, 0);
  assert.equal(app.render().props.children[0].props.children, false);
  assert.equal(app.live(), false);
});

test('MotionPlayer respects flex layouts and the existing explicit size override', () => {
  const app = harness();
  const flex = app.render({ style: { flex: 1 } });
  assert.deepEqual(Object.assign({}, ...flex.props.style), { flex: 1 });
  const fixed = app.render({ style: { width: 240 }, width: 180, height: 80 });
  assert.deepEqual(Object.assign({}, ...fixed.props.style), { width: 180, height: 80, aspectRatio: 360 / 138 });
});

test('independent players can reuse paths prepared from one loaded file', () => {
  const app = harness();
  const loaded = app.load();
  const paths = app.preparedPaths();
  assert.ok(paths > 0);
  app.render({ source: loaded, width: 160 });
  app.render({ source: loaded, width: 320 });
  assert.equal(app.preparedPaths(), paths);
});

test('preload decodes and uploads each shared image once, and accepts early Skia images', async () => {
  const app = harness();
  const loaded = app.load();
  const calls = [];
  const texture = {};
  const early = {};
  const raster = { makeTextureImage: () => { calls.push('upload'); return texture; } };
  const lazy = { makeRasterImage: async () => { calls.push('decode'); return raster; } };
  const warmed = await app.preload({ ...loaded, images: { one: lazy, another: lazy, early } }, { uploadImages: true });
  assert.deepEqual(calls, ['decode', 'upload']);
  assert.equal(warmed.images.one, texture);
  assert.equal(warmed.images.another, texture);
  assert.equal(warmed.images.early, early);
  assert.equal(warmed.key, loaded.key);
  const unsupported = { makeTextureImage() { throw new Error('no GPU backend'); } };
  const fallback = await app.preload({ ...loaded, images: { unsupported } }, { uploadImages: true });
  assert.equal(fallback.images.unsupported, unsupported);
});
