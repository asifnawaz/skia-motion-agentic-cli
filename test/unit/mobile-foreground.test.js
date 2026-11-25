import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

// runtime/mobile.tsx bundled with its imports stubbed, as mobile-layout.test.js does: React Native is not installed here.
const source = readFileSync(new URL('../../templates/assets/game-hud.json', import.meta.url), 'utf8');
const { outputFiles: [{ text }] } = await build({
  entryPoints: [fileURLToPath(new URL('../../runtime/mobile.tsx', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-native', 'react-native-skia', 'react-native-reanimated'],
  plugins: [{ name: 'stub-machine', setup(b) { b.onResolve({ filter: /^\.\/useMachine$/ }, () => ({ path: 'machine-stub', external: true })); } }],
});

function player(currentState) {
  const slots = [];
  let slot = 0;
  let live;
  const listeners = [];
  const jsx = (type, props) => ({ type, props });
  const modules = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    react: {
      forwardRef: (fn) => (props) => fn(props, null),
      useCallback: (fn) => fn,
      useEffect: (fn) => { fn(); },
      useImperativeHandle() {},
      useMemo: (compute) => compute(),
      useRef: (current) => ({ current }),
      useState: (initialize) => {
        const index = slot++;
        if (!(index in slots)) slots[index] = typeof initialize === 'function' ? initialize() : initialize;
        return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
      },
    },
    'react-native': {
      AppState: {
        currentState,
        addEventListener: (_event, listener) => { listeners.push(listener); return { remove() {} }; },
      },
      StyleSheet: { absoluteFill: {}, flatten: (style) => style },
      View: 'View',
    },
    'react-native-skia': {
      Canvas: 'Canvas', Picture: 'Picture', TileMode: {}, BlurStyle: {}, createPicture: () => ({}),
      Skia: {
        XYWHRect: (...rect) => rect, Color: () => [0, 0, 0, 1],
        Paint: () => ({ setAntiAlias() {}, setColor() {}, setAlphaf() {}, setShader() {}, setMaskFilter() {} }),
        Shader: { MakeRadialGradient: () => ({}) }, MaskFilter: { MakeBlur: () => ({}) },
        PathBuilder: { Make: () => ({ moveTo() {}, lineTo() {}, close() {}, detach: () => ({}) }) },
      },
    },
    'react-native-reanimated': {
      useSharedValue: (value) => ({ value }), useDerivedValue: (compute) => ({ value: compute() }), useAnimatedReaction() {},
    },
    'machine-stub': { useMachine: (_m, _c, options) => { live = options.live; return { pose: { value: { channels: {} } } }; } },
  };
  const module = { exports: {} };
  new Function('module', 'require', text)(module, (name) => modules[name]);
  const loaded = module.exports.loadMotionAsset(source);
  const render = () => {
    slot = 0;
    const element = module.exports.MotionPlayer({ source: loaded });
    return element.type(element.props);
  };
  render().props.onLayout({ nativeEvent: { layout: { width: 320, height: 150 } } });
  render();
  return {
    live: () => live,
    change(state) { listeners.forEach((listener) => listener(state)); render(); },
  };
}

test("iOS 'inactive' and 'unknown' keep a player live, as Android, which has neither, does", () => {
  // iOS reports system sheets (permission prompts, password managers, StoreKit, sign-in) as 'inactive', and launch can read 'unknown'.
  for (const state of ['inactive', 'unknown', 'extension']) assert.equal(player(state).live(), true, `mounted while ${state}`);
  const app = player('active');
  app.change('inactive');
  assert.equal(app.live(), true, "a sheet that makes the app 'inactive' does not pause it");
});

test("only 'background' pauses, and the player resumes when the app is back", () => {
  assert.equal(player('background').live(), false);
  const app = player('active');
  assert.equal(app.live(), true);
  app.change('background');
  assert.equal(app.live(), false);
  app.change('active');
  assert.equal(app.live(), true);
});
