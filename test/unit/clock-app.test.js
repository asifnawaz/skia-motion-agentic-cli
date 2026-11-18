import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// clock.app.ts imports react and react-native-reanimated, which skac does not install. Stub both: one render,
// effects run at once, and the frame callback is driven by hand, as Reanimated drives it on the UI thread.
const stub = `
export const state = globalThis.__clock = { cb: null, active: false };
export const useCallback = (f) => f;
export const useEffect = (f) => { f(); };
export const useSharedValue = (v) => ({ value: v });
export const useFrameCallback = (cb, active) => {
  state.cb = cb; state.active = active; state.last = null;
  return { setActive: (a) => { state.active = a; if (!a) state.last = null; } };
};
export const useReducedMotion = () => false;
export const cancelAnimation = () => {};
export const withTiming = (v) => v;
export const Easing = { linear: (x) => x };
`;
const url = 'data:text/javascript,' + encodeURIComponent(stub);
const hook = `export async function resolve(spec, ctx, next) {
  if (spec === 'react' || spec === 'react-native-reanimated') return { url: ${JSON.stringify(url)}, shortCircuit: true };
  return next(spec, ctx);
}`;
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

const { useLoopClock } = await import('../../templates/motion/clock.app.ts');
const S = globalThis.__clock;

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
