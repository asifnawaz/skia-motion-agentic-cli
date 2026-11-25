import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const source = readFileSync(new URL('../../templates/assets/reward-counter.json', import.meta.url), 'utf8');
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

// Reanimated's rule, small: a mapper or reaction runs again when a shared value it read is set.
let tracking = null;
function shared(initial) {
  const value = { current: initial, subscribers: new Set() };
  return {
    get value() { tracking?.add(value); return value.current; },
    // As Reanimated: setting the value a shared value already holds runs nothing.
    set value(next) { if (value.current === next) return; value.current = next; for (const run of [...value.subscribers]) run(); },
  };
}
function track(run, compute) {
  const read = new Set();
  const outer = tracking;
  tracking = read;
  try { return compute(); } finally {
    tracking = outer;
    for (const value of read) value.subscribers.add(run);
  }
}

function harness() {
  const state = { pictures: 0, label: '5' };
  const pose = shared({ channels: {} });
  const snapshot = shared({ frame: 0 });
  const slots = [];
  let slot = 0;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      forwardRef: (fn) => (props) => fn(props, null),
      useCallback: (fn) => fn,
      useEffect() {},
      useImperativeHandle() {},
      useMemo: (compute, deps) => {
        const index = slot++;
        const kept = slots[index];
        if (kept && deps && kept.deps.length === deps.length && kept.deps.every((dep, i) => Object.is(dep, deps[i]))) return kept.value;
        slots[index] = { deps: deps ?? [], value: compute() };
        return slots[index].value;
      },
      useRef: (current) => ({ current }),
      useState: (initialize) => {
        const index = slot++;
        if (!(index in slots)) slots[index] = typeof initialize === 'function' ? initialize() : initialize;
        return [slots[index], (update) => { slots[index] = typeof update === 'function' ? update(slots[index]) : update; }];
      },
    },
    'react-native': {
      AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
      StyleSheet: { absoluteFill: { position: 'absolute' }, flatten: (style) => style },
      View: 'View',
    },
    'react-native-skia': {
      Canvas: 'Canvas', Picture: 'Picture', TileMode: { Clamp: 0 }, BlurStyle: { Normal: 0 },
      TextAlign: { Left: 0, Right: 1, Center: 2 }, TextDirection: { LTR: 0, RTL: 1 },
      createPicture: () => ({ picture: ++state.pictures }),
      Skia: {
        XYWHRect: (...rect) => rect,
        RRectXY: (rect) => rect,
        Color: () => [0, 0, 0, 1],
        Paint: () => ({ setAntiAlias() {}, setColor() {}, setAlphaf() {}, setShader() {}, setMaskFilter() {}, setStyle() {}, setStrokeWidth() {} }),
        Shader: { MakeRadialGradient: () => ({}) },
        MaskFilter: { MakeBlur: () => ({}) },
        Data: { fromBase64: () => ({}), fromBytes: () => ({}) },
        Typeface: { MakeFreeTypeFaceFromData: () => ({}) },
        TypefaceFontProvider: { Make: () => ({ registerFont() {} }) },
        ParagraphBuilder: { Make: () => {
          const builder = {
            pushStyle: () => builder, addText: () => builder, pop: () => builder,
            build: () => ({ layout() {}, paint() {}, getHeight: () => 0, getLongestLine: () => 0, getLineMetrics: () => [], getRectsForRange: () => [] }),
          };
          return builder;
        } },
        PathBuilder: { Make: () => ({ moveTo() {}, lineTo() {}, quadTo() {}, cubicTo() {}, close() {}, detach: () => ({}) }) },
      },
    },
    'react-native-reanimated': {
      // As worklets in development: the initial object is locked against new properties.
      useSharedValue: (initial) => shared(initial && typeof initial === 'object' ? Object.preventExtensions(initial) : initial),
      useDerivedValue(compute) {
        const out = shared(undefined);
        const run = () => { out.value = track(run, compute); };
        run();
        return out;
      },
      useAnimatedReaction(prepare, apply) {
        let previous = null;
        const run = () => {
          const next = track(run, prepare);
          apply(next, previous);
          previous = next;
        };
        run();
      },
    },
    'machine-stub': {
      useMachine: () => ({
        pose, snapshot,
        readOnUI: () => { void snapshot.value; return state.label; },
      }),
    },
  };
  const module = { exports: {} };
  new Function('module', 'require', text)(module, (name) => modules[name]);
  return { state, pose, snapshot, exports: module.exports, resetSlots: () => { slot = 0; } };
}

test('a player records a new picture only when the pose, a channel or a bound string changes', () => {
  const { state, pose, snapshot, exports, resetSlots } = harness();
  const module = { exports };
  const render = () => {
    resetSlots();
    const element = module.exports.MotionPlayer({ source });
    return element.type(element.props);
  };
  const view = render();
  view.props.onLayout({ nativeEvent: { layout: { width: 280, height: 114 } } });
  const picture = render().props.children[0].props.children;
  picture.type(picture.props);
  assert.equal(state.pictures, 1);

  // The machine runs (a hold, a wait) and writes a new snapshot each frame, but nothing drawn moves.
  for (let frame = 1; frame <= 30; frame++) snapshot.value = { frame };
  assert.equal(state.pictures, 1, 'an unchanged frame records no picture');

  state.label = '6';
  snapshot.value = { frame: 31 };
  assert.equal(state.pictures, 2, 'a changed bound string records one picture');

  pose.value = { channels: { pulse: 0.5 } };
  assert.equal(state.pictures, 3, 'a changed pose records one picture');
});

test('a MotionPicture records a new picture only when what it draws changes, not on every host frame or render', () => {
  const harnessSlots = harness();
  const { state, exports } = harnessSlots;
  const asset = exports.loadMotionAsset(source);
  const timeMs = shared(0);
  const glow = shared(0);
  const props = { asset, clip: 'pulse', timeMs, width: 280, height: 114, channels: { landGlow: glow } };
  const { resetSlots } = harnessSlots;
  resetSlots();
  const element = exports.MotionPicture(props);
  assert.equal(state.pictures, 1);
  const picture = element.props.picture;
  timeMs.value = 85;
  assert.equal(state.pictures, 2, 'a moving clip records a picture');
  // The host clock runs on past the clip's end: the pose holds, so nothing is recorded and the picture value is not set again.
  timeMs.value = 280;
  const atEnd = state.pictures;
  const held = picture.value;
  for (let frame = 1; frame <= 30; frame++) timeMs.value = 280 + frame * 16;
  assert.equal(state.pictures, atEnd, 'a held pose records no picture');
  assert.equal(picture.value, held, 'the canvas gets the same picture, so it does not present');
  glow.value = 0.5;
  assert.equal(state.pictures, atEnd + 1, 'a host channel that changes while the clip holds records one picture');
  // A render with equal props (a new options object) keeps the picture.
  resetSlots();
  exports.MotionPicture({ ...props });
  assert.equal(state.pictures, atEnd + 1, 'a render with the same props records no picture');
  resetSlots();
  exports.MotionPicture({ ...props, width: 300 });
  assert.equal(state.pictures, atEnd + 2, 'a new size records one');
});
