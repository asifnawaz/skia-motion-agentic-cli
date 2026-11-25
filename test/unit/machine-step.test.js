import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { transformFileSync } = require('@babel/core');
const ts = require('typescript');

// The Worklets transform and CommonJS evaluation worklets.test.js uses, so the tick runs as the app builds it.
const load = (path, imports = {}) => {
  const filename = fileURLToPath(new URL(`../../${path}`, import.meta.url));
  const { code } = transformFileSync(filename, {
    babelrc: false, configFile: false, envName: 'production',
    presets: [require.resolve('@babel/preset-typescript')],
    plugins: [require.resolve('react-native-worklets/plugin')],
  });
  const { outputText } = ts.transpileModule(code, {
    fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES5 },
  });
  const exports = {};
  runInNewContext(outputText, {
    __DEV__: false, console, exports, global: { Error },
    require(specifier) {
      assert.ok(Object.hasOwn(imports, specifier), `unexpected import ${specifier}`);
      return imports[specifier];
    },
  }, { filename });
  return exports;
};

const core = load('templates/motion/machine.ts', { './motion': load('templates/motion/motion.ts') });

function player(options = {}) {
  const reactions = [];
  let tick;
  const { useMachine } = load('runtime/useMachine.ts', {
    '../templates/motion/machine': core,
    './version': {},
    react: { useCallback: (fn) => fn, useMemo: (fn) => fn(), useEffect: (fn) => fn() },
    'react-native-worklets': { scheduleOnUI: (fn, ...args) => fn(...args), scheduleOnRN: (fn, ...args) => fn(...args) },
    'react-native-reanimated': {
      useSharedValue: (value) => ({ value }), useReducedMotion: () => false,
      useFrameCallback: (callback) => { tick = callback; return { setActive() {} }; },
      useAnimatedReaction: (prepare, apply) => {
        let previous;
        reactions.push(() => { const next = prepare(); apply(next, previous); previous = next; });
      },
    },
  });
  const machine = {
    schema: 'skac.machine/1',
    layers: [{ name: 'main', entry: 'moving', states: { moving: { clip: 'moving', loop: 'once' } } }],
  };
  const handle = useMachine(machine, { moving: { ms: 100000, play: (time) => ({ channels: { time } }) } }, options);
  return (...steps) => {
    for (const ms of steps) {
      tick({ timeSincePreviousFrame: ms });
      reactions.forEach((reaction) => reaction());
    }
    return handle.pose.value.channels.time;
  };
}

test('a stalled frame delays the clip by at most 50 ms, never jumps it ahead', () => {
  const frames = player();
  assert.equal(frames(16, 400, 16), 82);
});

test('a device that is steadily slow keeps real time; a stall on it is still cut', () => {
  const frames = player();
  const slow = Array(20).fill(66);
  frames(...slow); // the typical frame settles near 66 ms
  const before = frames();
  assert.equal(frames(66, 66, 66) - before, 198, 'steady 15 fps frames count whole');
  const stalled = frames();
  assert.ok(frames(900) - stalled < 300, 'a 900 ms stall on a 66 ms device still moves the clock less than 300 ms');
});

test('with a frame rate cap, a stall is cut to two intervals and on-time frames are kept whole', () => {
  const frames = player({ frameRate: 10 }); // interval 100 ms: a step under 200 ms always counts
  assert.equal(frames(100, 900, 100), 400);
  const smooth = player({ frameRate: 30 });
  // Frames a little late (34 ms against 33.3) keep their whole length: the clock does not drift behind.
  assert.equal(smooth(34, 34, 34), 102);
});
