// useMachine.ts: play a skac.machine/1 scene in an app (skac docs app). Reanimated and Worklets only, never Skia: the
// exported index.tsx draws `pose` with the app's own Skia package.
//
// The machine's snapshot lives in a shared value and moves forward on the UI thread through the same advance() the
// CLI checks with. A frame callback runs only while a frame-clock layer is awake or a write waits; once the machine
// rests it switches itself off and the last pose stays. Layers on a named clock follow that clock's shared value
// through the pose reaction, so they step with the app's own clock and cost nothing between its steps.
import { useCallback, useEffect, useMemo } from 'react';
import { useAnimatedReaction, useFrameCallback, useReducedMotion, useSharedValue, type FrameInfo, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import {
  advance, compile, hitTest, hitWrites, pose as poseAt, settled, start, writeProblem,
  type Clips, type ClockRead, type Literal, type Machine, type Pose, type Snapshot, type StateEntry, type Write,
} from '../templates/motion/machine';
import { assertRuntimeVersion } from './version';

declare const __DEV__: boolean;

/** Dev-only timing probe (skac docs app): frame timestamps, in ms, of the frame that applied a write and of the first frame that drew something different after it. */
export type MachineProbe = { onWrite?: (frameMs: number) => void; onChanged?: (frameMs: number) => void };

export type MachineOptions = {
  /** false stops time and the frame callback (hidden, background, covered). Default true. */
  live?: boolean;
  /** Overrides the system's reduced-motion setting: once-clips show their end, loops their start. */
  reduced?: boolean;
  /** Named clocks the machine's layers read, as shared values in ms (Word Quran passes its ambient phase × 64000). */
  clocks?: Record<string, SharedValue<number>>;
  probe?: MachineProbe;
  /** Entries after initialization, in machine order. Delivered on the React Native thread. */
  onStateEntries?: (entries: StateEntry[]) => void;
  /** The skac version that wrote the exported machine module. */
  exportedBy?: string;
};

type Values<M extends Machine> = 'values' extends keyof M ? NonNullable<M['values']> : {};
type ValueName<V> = Extract<keyof V, string>;
type WritableName<V> = ValueName<{ [K in keyof V as V[K] extends { bind: 'out' } ? never : K]: V[K] }>;
type TriggerName<V> = string extends keyof V ? string : ValueName<{
  [K in WritableName<V> as V[K] extends { type: 'trigger' } ? K : never]: V[K];
}>;
type WriteValue<V> = V extends { type: 'boolean' } ? boolean
  : V extends { type: 'number' } ? number
    : V extends { type: 'enum'; options: readonly (infer O extends string)[] } ? O
      : V extends { type: 'trigger' } ? true : Literal;

export type MachineHandle<M extends Machine = Machine> = {
  /** What to draw: channels and part boxes. Read it in a derived value or a Skia picture; it changes only when the drawing does. */
  pose: SharedValue<Pose>;
  /** Write a value from JavaScript; it applies at the next frame. */
  set: <K extends WritableName<Values<M>>>(name: K, to: WriteValue<Values<M>[NoInfer<K>]>) => void;
  /** Fire a trigger from JavaScript. */
  fire: (name: TriggerName<Values<M>>) => void;
  /** Write a value from the UI thread (a gesture worklet); it applies at the next frame. */
  setOnUI: MachineHandle<M>['set'];
  /** Tap the point (x, y) in pt from the UI thread: the first hit area under it makes its writes. Returns the part's name, or ''. */
  tapOnUI: (x: number, y: number) => string;
  /** A value as the machine holds it now, on the UI thread: how an out-value reaches an animated style. */
  readOnUI: (name: ValueName<Values<M>>) => Literal | undefined;
};

function sameNumbers(left: Record<string, number | undefined>, right: Record<string, number | undefined>): boolean {
  'worklet';
  if (left === right) return true;
  let remaining = 0;
  for (const key in left) {
    if (!Object.hasOwn(left, key) || left[key] === undefined) continue;
    if (!Object.hasOwn(right, key) || left[key] !== right[key]) return false;
    remaining++;
  }
  for (const key in right) {
    if (Object.hasOwn(right, key) && right[key] !== undefined) remaining--;
  }
  return remaining === 0;
}

function samePose(left: Pose, right: Pose): boolean {
  'worklet';
  if (!sameNumbers(left.channels, right.channels)) return false;
  const { parts: leftParts } = left;
  const { parts: rightParts } = right;
  if (leftParts === rightParts) return true;
  if (!leftParts || !rightParts) return false;
  let remaining = 0;
  for (const name in leftParts) {
    if (!Object.hasOwn(leftParts, name)) continue;
    if (!Object.hasOwn(rightParts, name) || !sameNumbers(leftParts[name]!, rightParts[name]!)) return false;
    remaining++;
  }
  for (const name in rightParts) {
    if (Object.hasOwn(rightParts, name)) remaining--;
  }
  return remaining === 0;
}

/** Play `machine` with its `clips`. The machine and clips must be stable (module constants), as an exported scene's are. */
export function useMachine<const M extends Machine>(machine: M, clips: Clips, options: MachineOptions = {}): MachineHandle<M> {
  if (__DEV__ && options.exportedBy !== undefined) assertRuntimeVersion(options.exportedBy);
  const { live = true, clocks = {}, probe, onStateEntries } = options;
  const systemReduced = useReducedMotion();
  const reduced = options.reduced ?? systemReduced;
  const compiled = useMemo(() => compile(machine, clips), [machine, clips]);
  // The clocks its layers run on: the pose reads only these, and each must be passed, since a missing one would read
  // machine time, which stops while the machine rests.
  const clockNames = useMemo(() => [...new Set(compiled.layers.map((L) => L.clock).filter((n) => n))], [compiled]);
  const missing = clockNames.filter((n) => !clocks[n]);
  if (missing.length) throw new Error(`useMachine: layers run on clock${missing.length > 1 ? 's' : ''} ${missing.join(', ')}; pass clocks={{ ${missing.join(', ')} }} as shared values in ms`);

  // The snapshot at machine time `ms`; writes wait in `pending` until the next frame stamps and applies them.
  const read: ClockRead = (name: string, t: number) => {
    'worklet';
    const clock = clocks[name];
    return clock ? clock.value : t;
  };
  // Entered at mount, at machine time 0, with each named clock's reading now.
  const first = useMemo(() => advance(compiled, start(compiled), 0, [], read), [compiled]); // eslint-disable-line react-hooks/exhaustive-deps
  const ms = useSharedValue(0);
  const snapshot = useSharedValue<Snapshot>(first);
  const pending = useSharedValue<Write[]>([]);
  const lastChannels = useSharedValue('');
  const awaitingChange = useSharedValue(false);
  const liveNow = useSharedValue(live);
  const firstPose = useMemo(() => poseAt(compiled, clips, first, 0, read, reduced), [first]); // eslint-disable-line react-hooks/exhaustive-deps
  const pose = useSharedValue<Pose>(firstPose);

  useAnimatedReaction(
    () => {
      if (!liveNow.value) return undefined;
      // Subscribe to the named clocks, including when the frame callback sleeps.
      for (const n of clockNames) void clocks[n]!.value;
      return poseAt(compiled, clips, snapshot.value, ms.value, read, reduced);
    },
    (next) => {
      // The reaction subscribes only to the prepare inputs. Updating its output cannot wake it again.
      if (next && !samePose(next, pose.value)) pose.value = next;
    },
  );

  const tick = useCallback((frame: FrameInfo) => {
    'worklet';
    const writes = pending.value;
    // The first frame after a wake has no previous frame (dt 0); advance takes writes after the snapshot's time only,
    // so writes waiting then are stamped a hair later, or they would be lost.
    const dt = frame.timeSincePreviousFrame ?? 0;
    const t = ms.value + (writes.length ? Math.max(dt, 0.001) : dt);
    ms.value = t;
    if (writes.length) {
      pending.value = [];
      if (probe?.onWrite) { scheduleOnRN(probe.onWrite, frame.timestamp); awaitingChange.value = true; }
    }
    const entries: StateEntry[] | undefined = onStateEntries ? [] : undefined;
    const next = advance(compiled, snapshot.value, t, writes.map((w) => ({ ...w, at: t })), read, entries);
    snapshot.value = next;
    if (entries?.length && onStateEntries) scheduleOnRN(onStateEntries, entries);
    if (probe?.onChanged) {
      const key = JSON.stringify(poseAt(compiled, clips, next, t, read, reduced).channels);
      if (key !== lastChannels.value) {
        lastChannels.value = key;
        if (awaitingChange.value) { awaitingChange.value = false; scheduleOnRN(probe.onChanged, frame.timestamp); }
      }
    }
    if (pending.value.length === 0 && settled(compiled, next, read, reduced).frame) scheduleOnRN(sleep);
  }, [compiled, clips, reduced, probe, onStateEntries]);

  const frames = useFrameCallback(tick, false);
  // The callback is switched from JavaScript only: switching it from a worklet makes a synchronous remote call that
  // release builds refuse (found in Word Quran, 18 Oct 2026).
  function sleep() {
    frames.setActive(false);
  }
  // It reads `live` through its shared value: the tick holds an older copy of this function.
  const wake = useCallback(() => { if (liveNow.value) frames.setActive(true); }, [frames, liveNow]);
  useEffect(() => {
    liveNow.value = live;
    frames.setActive(live);
  }, [frames, live, liveNow, reduced]);

  const setOnUI = useCallback((name: string, to: Literal) => {
    'worklet';
    pending.value = [...pending.value, { at: 0, value: name, to }];
    scheduleOnRN(wake);
  }, [pending, wake]);
  const set = useCallback((name: string, to: Literal) => {
    const problem = writeProblem(compiled, name, to);
    if (problem) throw new Error(`useMachine set: ${problem}`);
    // The UI worklet queues the wake after any sleep the tick has already queued on JavaScript.
    scheduleOnUI(setOnUI, name, to);
  }, [compiled, setOnUI]);
  const fire = useCallback((name: string) => set(name, true), [set]);
  const tapOnUI = useCallback((x: number, y: number) => {
    'worklet';
    const part = hitTest(compiled, pose.value, x, y);
    if (!part) return '';
    const writes = hitWrites(compiled, part, 0, snapshot.value.vals);
    pending.value = [...pending.value, ...writes];
    scheduleOnRN(wake);
    return part;
  }, [compiled, pose, snapshot, pending, wake]);
  const readOnUI = useCallback((name: string) => {
    'worklet';
    const i = compiled.index[name];
    return i === undefined ? undefined : snapshot.value.vals[i];
  }, [compiled, snapshot]);

  return { pose, set, fire, setOnUI, tapOnUI, readOnUI };
}
