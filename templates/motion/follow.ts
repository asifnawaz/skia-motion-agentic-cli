// follow.ts: follow-through for an interface, ported from the reels kit (word-quran-reels reels/_kit/dynamics.js lines 18-48,
// class Follower). A follower's value chases a leader's value through a damped spring: it lags, then settles. In a group the
// leader moves first and the children trail it, each by its own spring, so one move reads as one object (Lasseter: overlapping
// action). Imports nothing; every exported function is a worklet.
//
// Pure in time, like the reels: the spring is integrated from t = 0 in fixed 1/120 s steps and read back by interpolation. A
// worklet holds no module state, so there is no hidden cache: the caller builds the table once (`followTable`, on the JS thread
// or in useMemo) and passes it to `follow` every frame.

/**
 * The default spring for an interface, and why.
 * - omega 18 rad/s, zeta 0.8: a step settles with 1.5 % overshoot (exp(-pi zeta / sqrt(1 - zeta^2))), inside the owner's 5 % cap
 *   with room for the table's 120 Hz integration; the child lags its leader by 2 zeta / omega = 89 ms, the same lag as
 *   MOVE.lagMs (90 ms, rossark rule 4), so a follower sits one lag behind without anything to tune.
 * - leadMs 90: the leader is read that far ahead (dynamics.js `lead`, O-650: "it felt delayed"), so the lag lands the child
 *   ON the beat, not after it. Set it to 0 for a child that should trail the beat.
 * A looser spring (zeta below 0.69) overshoots past 5 %; the checks flag it (`skac/overshoot`).
 */
export const FOLLOW = { omega: 18, zeta: 0.8, leadMs: 90 };

const STEP = 1 / 120; // dynamics.js STEP, seconds
const SUB = 2; // dynamics.js SUB: two semi-implicit Euler substeps per table step

/**
 * Build the table once: `leader(ms)` is the leader's value; the table covers 0 to `durationMs`. The state starts at the
 * leader's value (at `leadMs`) with zero velocity, as dynamics.js does. `vmax` caps the follower's speed in units per second
 * (dynamics.js VMAX, for angles); the default is no cap. Returns [value0, speed0, value1, speed1, ...] at 1/120 s.
 */
export function followTable(leader: (ms: number) => number, durationMs: number, omega: number = FOLLOW.omega, zeta: number = FOLLOW.zeta, leadMs: number = FOLLOW.leadMs, vmax: number = Infinity): number[] {
  'worklet';
  const n = Math.ceil(durationMs / (STEP * 1000)) + 2;
  const h = STEP / SUB;
  const out: number[] = [];
  let x = 0;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const target = leader(i * STEP * 1000 + leadMs);
    if (i === 0) {
      x = target;
    } else {
      for (let j = 0; j < SUB; j++) {
        v += (omega * omega * (target - x) - 2 * zeta * omega * v) * h;
        v = Math.max(-vmax, Math.min(vmax, v));
        x += v * h;
      }
    }
    out.push(x, v);
  }
  return out;
}

const read = (table: number[], ms: number, k: number) => {
  'worklet';
  const last = table.length / 2 - 1;
  const x = Math.max(0, ms) / (STEP * 1000);
  const i = Math.min(last - 1, Math.floor(x));
  const u = Math.min(1, x - i);
  const a = table[2 * i + k];
  return a + (table[2 * i + 2 + k] - a) * u;
};

/**
 * Use when a part trails a leader and settles: a group moving into place behind its first element, a tail behind a body, a
 * badge behind a card. Returns the follower's value at `ms` (the table's 0 to its duration; held after it). Use it in place of
 * the leader's own value on the child, or add `share * (follow(...) - leader(ms))` to blend. Not for the leader itself.
 */
export function follow(table: number[], ms: number): number {
  'worklet';
  return read(table, ms, 0);
}

/** The follower's speed at `ms`, in units per second (dynamics.js `at(t).v`): drive a squash or a lean from it. */
export function followSpeed(table: number[], ms: number): number {
  'worklet';
  return read(table, ms, 1);
}
