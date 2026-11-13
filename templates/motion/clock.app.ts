// clock.app.ts: the app's clocks (Reanimated 3/4), adapted from rossark-motion-skill
// templates/react-native/motion.ts (MIT, see NOTICE.md at the package root).
//
// HOW IT RUNS: app only. Remotion has no Reanimated; it uses clock.remotion.ts instead.
// Read the clock inside `useDerivedValue(() => ...)` and pass the derived value straight to a
// Skia prop (Skia accepts shared values for any prop), so nothing re-renders React per frame:
//
//   const t = useLoopClock(6000, live);                       // live = visible && !reducedMotion
//   const body = useDerivedValue(() => [{ translateY: -1.5 * (wave(t.value, 3000) + 1) / 2 }]);
//   <Group transform={body}>...</Group>
//
// Not yet run in the app: the Remotion path is the one proven by a rendered composition.
import { useEffect } from 'react';
import { Easing, cancelAnimation, useReducedMotion, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';

/**
 * A looping clock, 0 -> period ms, forever. Frozen at 0 when `live` is false (reduced motion,
 * off screen, app in background): frame 0 must be a good drawing (rossark §1.10, §1.11).
 */
export function useLoopClock(period: number, live: boolean): SharedValue<number> {
  const clock = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(clock);
    // withRepeat restarts from the CURRENT value: always reset first (rossark §8).
    clock.value = 0;
    if (!live) return;
    clock.value = withRepeat(withTiming(period, { duration: period, easing: Easing.linear }), -1);
    return () => cancelAnimation(clock);
  }, [live, period, clock]);
  return clock;
}

/**
 * A clock that plays ONCE, 0 -> duration ms, when `play` turns true, and holds at the end.
 * With reduced motion it jumps to the end: the final frame must read on its own (rossark §1.10).
 */
export function useOneShotClock(duration: number, play: boolean, reduced: boolean): SharedValue<number> {
  const clock = useSharedValue(reduced ? duration : 0);
  useEffect(() => {
    cancelAnimation(clock);
    if (!play) {
      clock.value = 0;
      return;
    }
    if (reduced) {
      clock.value = duration;
      return;
    }
    clock.value = 0;
    clock.value = withTiming(duration, { duration, easing: Easing.linear });
    return () => cancelAnimation(clock);
  }, [play, reduced, duration, clock]);
  return clock;
}

/** Whether loops may run: reduced motion means still (rossark §1.10). Combine with visibility. */
export function useLive(visible: boolean): boolean {
  const reduced = useReducedMotion();
  return visible && !reduced;
}
