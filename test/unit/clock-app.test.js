import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadModules } from './helpers.js';

// clock.app.ts imports react and react-native-reanimated, which skac does not install. Stub both: one render,
// effects run at once, and the frame callback is driven by hand, as Reanimated drives it on the UI thread.
const S = { cb: null, active: false, last: null };
const { clock: { useLoopClock } } = loadModules({ clock: './templates/motion/clock.app.ts' }, {
  react: {
    useCallback: (f) => f,
    useEffect: (f) => { f(); },
  },
  'react-native-reanimated': {
    useSharedValue: (value) => ({ value }),
    useFrameCallback(cb, active) {
      Object.assign(S, { cb, active, last: null });
      return { setActive: (a) => { S.active = a; if (!a) S.last = null; } };
    },
    useReducedMotion: () => false,
    cancelAnimation: () => {},
    withTiming: (v) => v,
    Easing: { linear: (x) => x },
  },
});

/** One display frame `dt` ms after the last, as Reanimated reports it: no previous frame after a (re)start. */
const frame = (dt) => {
  if (!S.active) return;
  S.cb({ timeSincePreviousFrame: S.last === null ? null : dt });
  S.last = dt;
};

test('useLoopClock: a pause freezes the clock where it is, and a resume carries on from there', () => {
  const clock = useLoopClock(1000, true);
  for (let i = 0; i < 31; i++) frame(10); // the first frame has no previous one: 300 ms after 31 frames
  assert.equal(clock.value, 300);
  S.active = false; // live turns false: what the effect's setActive(false) does
  for (let i = 0; i < 50; i++) frame(10);
  assert.equal(clock.value, 300, 'frozen, not reset to 0');
  S.active = true;
  S.last = null;
  for (let i = 0; i < 11; i++) frame(10);
  assert.equal(clock.value, 400, 'resumed from 300');
});

test('useLoopClock: wraps at the period and starts at 0 when not live', () => {
  const clock = useLoopClock(100, true);
  for (let i = 0; i < 16; i++) frame(10);
  assert.equal(clock.value, 50);
  const idle = useLoopClock(100, false);
  for (let i = 0; i < 16; i++) frame(10);
  assert.equal(idle.value, 0);
});
