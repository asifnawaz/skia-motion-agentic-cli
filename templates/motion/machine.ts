// machine.ts: the skac.machine/1 core (skac docs machine), an engine file like motion.ts. It imports only the motion
// engine's curves, so it runs the same in Node (the CLI's checks), in Remotion and on the app's UI thread. Every
// function is a worklet. The app imports it through skia-motion-agentic-cli/runtime, never as a copy.
// Define each worklet helper before its callers. Babel initializes worklets with factory calls that capture their dependencies immediately.
//
// One pure function does the work: advance(compiled, snapshot, toMs, writes, clock) -> snapshot. The CLI replays a
// log through it from the start; the app advances it each frame from the last frame's snapshot. Because a value can
// change only at a write (the app's or an action's), every condition changes only at a write, an exit-time crossing
// or a mix's end, and advance jumps from one such instant to the next. Splitting a run into frames therefore gives
// the same snapshot as running it whole.
import { EASE_IN, EASE_IN_OUT, EASE_OUT } from './motion';

export const SCHEMA = 'skac.machine/1';
/** Rive's cap, kept: one layer changes state at most this often in one instant. */
export const MAX_CHANGES = 100;

export type Literal = boolean | number | string;
export type PartBox = { x: number; y: number; w: number; h: number; rot?: number };
export type Pose = { channels: Record<string, number>; parts?: Record<string, PartBox> };
export type Clip = { ms: number; reducedAt?: number; play: (localMs: number) => Pose };
export type Clips = Record<string, Clip>;
/** A value write at `at` ms of machine time. A trigger is written with `to: true`. */
/** A write of `to` into `value` at machine time `at`; `hit` marks the machine's own (a hit area's action), which may write an out-value. */
export type Write = { at: number; value: string; to: Literal; hit?: boolean };
/** The reading of a named clock, in ms. The CLI simulates it from machine time; the app reads its shared value. */
export type ClockRead = (name: string, t: number) => number;
export type StateEntry = { layer: string; state: string; at: number };

type Condition = readonly Literal[];
type Action = { set?: string; to?: Literal; fire?: string };
// The CLI validates literal choices and tuple shapes. JSON imports widen those to strings and arrays.
export type Machine = {
  schema: string;
  values?: Record<string, { type: string; default?: Literal; options?: readonly string[]; bind?: string }>;
  clocks?: Record<string, { wrap_ms?: number; step_hz: number }>;
  layers: readonly {
    name: string;
    entry: string | readonly { to: string; when?: readonly Condition[] }[];
    clock?: string;
    states: Record<string, {
      clip?: string; loop?: string; speed?: number; reason?: string;
      blend?: { by: string; keys: readonly (readonly (number | string)[])[] }; on_enter?: readonly Action[]; on_exit?: readonly Action[];
    } | undefined>;
    transitions?: readonly {
      from: string; to: string; when?: readonly Condition[]; exit_at?: number; duration_ms?: number;
      ease?: string; on_start?: readonly Action[]; on_end?: readonly Action[];
    }[];
  }[];
  hits?: readonly { part: string; on: string; set?: string; to?: Literal; fire?: string }[];
};

// Compiled forms: names resolved to indices once, on load.
const OP = { '==': 0, '!=': 1, '<': 2, '<=': 3, '>': 4, '>=': 5 } as const;
const TRIGGER_OP = 6;
const LOOP = { once: 0, loop: 1, pingpong: 2 } as const;
const EASE = { linear: 0, out: 1, inOut: 2, in: 3 } as const;
const EXIT = -2;
const ANY = -1;

/** [value index, op, operand value index or -1, literal operand] */
type CCond = [number, number, number, Literal];
/** [value index, operand value index or -1, literal, fire] */
type CAction = [number, number, Literal, boolean];
type CState = {
  name: string; clip: string; keys: [number, string][] | null; by: number; loop: number; speed: number; ms: number;
  enter: CAction[]; exit: CAction[]; reason: string;
};
type CTrans = { from: number; to: number; when: CCond[]; triggers: number[]; exitAt: number; dur: number; ease: number; start: CAction[]; end: CAction[] };
type CLayer = {
  name: string; clock: string; wrap: number; states: CState[]; entry: { to: number; when: CCond[] }[];
  trans: CTrans[]; any: number[]; byState: number[][];
};
export type Compiled = {
  values: { name: string; type: string; def: Literal; bind: string; options: readonly string[] }[];
  index: Record<string, number>;
  layers: CLayer[];
  hits: { part: string; on: string; action: CAction }[];
};

/** One layer's place: its state (or EXIT, holding `heldS` at `held` with blend input `heldBy`), when it entered, and any mix running. */
export type LayerSnap = {
  s: number; at: number; cAt: number; held: number; heldS: number; heldBy: number;
  mixFrom: number; mixAt: number; mixCAt: number; mixStart: number; mixEnd: number; mixTr: number;
};
/** Everything the machine knows at `t`: values and each layer. Plain numbers, so it copies to the UI thread. */
export type Snapshot = { t: number; vals: Literal[]; layers: LayerSnap[] };

function clipOf(clips: Clips, name: string): Clip {
  'worklet';
  const c = clips[name];
  if (!c) throw new Error(`skac runtime: no clip named "${name}"`);
  return c;
}

/** Resolve a machine (already judged by `skac <Name> --machine`) against its clips. Throws on a schema it cannot read. */
export function compile(m: Machine, clips: Clips): Compiled {
  'worklet';
  if (m.schema !== SCHEMA) throw new Error(`skac runtime reads ${SCHEMA}, not ${String(m.schema)}: update skia-motion-agentic-cli`);
  const values: Compiled['values'] = [];
  const index: Record<string, number> = {};
  for (const name of Object.keys(m.values ?? {})) {
    const v = m.values![name]!;
    index[name] = values.length;
    const def: Literal = v.default !== undefined ? v.default
      : v.type === 'number' ? 0 : v.type === 'enum' ? v.options![0]! : v.type === 'string' ? '' : false;
    values.push({ name, type: v.type, def, bind: v.bind ?? 'in', options: v.options ?? [] });
  }
  // A string operand names a value unless it is an option of the enum it is compared with or written to.
  const ref = (x: Literal, owner: string): number =>
    (typeof x === 'string' && Object.hasOwn(index, x) && !(m.values?.[owner]?.options ?? []).includes(x) ? index[x]! : -1);
  const conds = (when: readonly Condition[] | undefined): CCond[] =>
    (when ?? []).map(([name, op, rhs]): CCond => {
      const owner = name as string;
      return op === undefined ? [index[owner]!, TRIGGER_OP, -1, true]
        : [index[owner]!, OP[op as keyof typeof OP], ref(rhs!, owner), rhs!];
    });
  const acts = (list: readonly Action[] | undefined): CAction[] =>
    (list ?? []).map((a) => (a.fire !== undefined
      ? [index[a.fire]!, -1, true, true] as CAction
      : [index[a.set!]!, ref(a.to!, a.set!), a.to!, false] as CAction));
  const layers: CLayer[] = m.layers.map((L) => {
    const names = Object.keys(L.states);
    const at = (n: string) => (n === 'exit' ? EXIT : n === '*' ? ANY : names.indexOf(n));
    const states: CState[] = names.map((n) => {
      const s = L.states[n]!;
      const keys = s.blend ? s.blend.keys.map((k) => [k[0], k[1]] as [number, string]) : null;
      const lengths = keys ? keys.map((k) => clipOf(clips, k[1]).ms) : [s.clip ? clipOf(clips, s.clip).ms : 0];
      return {
        name: n, clip: s.clip ?? '', keys, by: s.blend ? index[s.blend.by]! : -1, loop: LOOP[(s.loop ?? 'once') as keyof typeof LOOP], speed: s.speed ?? 1,
        ms: Math.max(...lengths), enter: acts(s.on_enter), exit: acts(s.on_exit), reason: s.reason ?? '',
      };
    });
    const trans: CTrans[] = (L.transitions ?? []).map((t) => {
      const when = conds(t.when);
      return {
        from: at(t.from), to: at(t.to), when, triggers: when.filter((c) => c[1] === TRIGGER_OP).map((c) => c[0]),
        exitAt: t.exit_at ?? -1, dur: t.duration_ms ?? 0, ease: EASE[(t.ease ?? 'linear') as keyof typeof EASE], start: acts(t.on_start), end: acts(t.on_end),
      };
    });
    const entry = typeof L.entry === 'string' ? [{ to: at(L.entry), when: [] as CCond[] }] : L.entry.map((e) => ({ to: at(e.to), when: conds(e.when) }));
    const clock = L.clock ?? '';
    return {
      name: L.name, clock, wrap: clock ? m.clocks![clock]!.wrap_ms ?? 0 : 0, states, entry, trans,
      any: trans.map((t, i) => (t.from === ANY ? i : -1)).filter((i) => i >= 0),
      byState: states.map((_, si) => trans.map((t, i) => (t.from === si ? i : -1)).filter((i) => i >= 0)),
    };
  });
  const hits = (m.hits ?? []).map((h) => ({
    part: h.part, on: h.on,
    action: (h.fire !== undefined ? [index[h.fire]!, -1, true, true] : [index[h.set!]!, ref(h.to!, h.set!), h.to!, false]) as CAction,
  }));
  return { values, index, layers, hits };
}

/** The machine before its first instant: defaults set, no layer entered. advance(…, 0, …) enters them. */
export function start(c: Compiled): Snapshot {
  'worklet';
  return {
    t: -1,
    vals: c.values.map((v) => (v.type === 'trigger' ? false : v.def)),
    layers: c.layers.map(() => ({ s: -1, at: 0, cAt: 0, held: 0, heldS: -1, heldBy: 0, mixFrom: -1, mixAt: 0, mixCAt: 0, mixStart: 0, mixEnd: 0, mixTr: -1 })),
  };
}

function copy(s: Snapshot): Snapshot {
  'worklet';
  return { t: s.t, vals: s.vals.slice(), layers: s.layers.map((l) => ({ ...l })) };
}

function holds(c: CCond, vals: Literal[], used: number[]): boolean {
  'worklet';
  const a = vals[c[0]]!;
  if (c[1] === TRIGGER_OP) return a === true && used.indexOf(c[0]) < 0;
  const b = c[2] >= 0 ? vals[c[2]]! : c[3];
  switch (c[1]) {
    case 0: return a === b;
    case 1: return a !== b;
    case 2: return (a as number) < (b as number);
    case 3: return (a as number) <= (b as number);
    case 4: return (a as number) > (b as number);
    default: return (a as number) >= (b as number);
  }
}

function allHold(when: CCond[], vals: Literal[], used: number[]): boolean {
  'worklet';
  for (const c of when) if (!holds(c, vals, used)) return false;
  return true;
}

function run(actions: CAction[], vals: Literal[]): void {
  'worklet';
  for (const a of actions) vals[a[0]] = a[3] ? true : a[1] >= 0 ? vals[a[1]]! : a[2];
}

/** When the exit time of transition `tr` falls for layer `l`, in machine ms; -1 when it has none. Frame-clock layers only. */
function exitTime(L: CLayer, l: LayerSnap, tr: CTrans): number {
  'worklet';
  if (tr.exitAt < 0 || l.s < 0) return -1;
  const st = L.states[l.s]!;
  return l.at + (tr.exitAt * st.ms) / st.speed;
}

function sinceEntry(L: CLayer, at: number, cAt: number, t: number, clock: ClockRead): number {
  'worklet';
  if (!L.clock) return Math.max(0, t - at);
  const d = clock(L.clock, t) - cAt;
  return L.wrap > 0 ? ((d % L.wrap) + L.wrap) % L.wrap : Math.max(0, d);
}

/** A layer's time inside its current state, in clip ms before looping: frame time, or its named clock since entry. */
function localMs(L: CLayer, l: LayerSnap, t: number, clock: ClockRead): number {
  'worklet';
  const st = L.states[l.s]!;
  return sinceEntry(L, l.at, l.cAt, t, clock) * st.speed;
}

/** Enter state `to` of layer `li` at `t` from its current one, through transition `tr` (or none, on entry). */
function enter(c: Compiled, s: Snapshot, li: number, to: number, tr: CTrans | null, t: number, clock: ClockRead, entries?: StateEntry[]): void {
  'worklet';
  const L = c.layers[li]!;
  const l = s.layers[li]!;
  const from = l.s;
  if (from >= 0) run(L.states[from]!.exit, s.vals);
  if (tr) run(tr.start, s.vals);
  const reading = L.clock ? clock(L.clock, t) : 0;
  if (to === EXIT) {
    l.held = from >= 0 ? localMs(L, l, t, clock) : 0;
    l.heldS = from;
    const by = from >= 0 ? L.states[from]!.by : -1;
    l.heldBy = by >= 0 ? (s.vals[by] as number) : 0;
    l.s = EXIT;
    l.mixTr = -1;
    if (tr) run(tr.end, s.vals);
    return;
  }
  if (tr && tr.dur > 0 && from >= 0) {
    l.mixFrom = from; l.mixAt = l.at; l.mixCAt = l.cAt; l.mixStart = t; l.mixEnd = t + tr.dur;
    l.mixTr = L.trans.indexOf(tr);
  } else {
    l.mixTr = -1;
  }
  l.s = to; l.at = t; l.cAt = reading;
  if (entries) entries.push({ layer: L.name, state: L.states[to]!.name, at: t });
  run(L.states[to]!.enter, s.vals);
  if (tr && l.mixTr < 0) run(tr.end, s.vals);
}

/** Try layer `li`'s transitions at `t`, Any State first, then the current state's. True when one fired. */
function step(c: Compiled, s: Snapshot, li: number, t: number, clock: ClockRead, used: number[], entries?: StateEntry[]): boolean {
  'worklet';
  const L = c.layers[li]!;
  const l = s.layers[li]!;
  if (l.s < 0) return false; // exited, or not entered yet
  if (l.mixTr >= 0) return false; // Rive's default: no exit during a transition
  const lists = [L.any, L.byState[l.s]!];
  for (const list of lists) {
    for (const i of list) {
      const tr = L.trans[i]!;
      if (tr.from === ANY && tr.to === l.s) continue;
      if (tr.exitAt >= 0 && t < exitTime(L, l, tr)) continue;
      if (!allHold(tr.when, s.vals, used)) continue;
      for (const v of tr.triggers) used.push(v);
      enter(c, s, li, tr.to, tr, t, clock, entries);
      return true;
    }
  }
  return false;
}

/**
 * Why an outside write (the app's set or fire, a CLI event) of `to` into `name` is refused, or '' when the machine takes it:
 * the value must exist, be an in or both value, and `to` must fit its type (a trigger takes true).
 */
export function writeProblem(c: Compiled, name: string, to: Literal): string {
  'worklet';
  if (!Object.hasOwn(c.index, name)) return `the machine has no value "${name}"`;
  const i = c.index[name]!;
  const v = c.values[i]!;
  if (v.bind === 'out') return `"${name}" is an out-value: the machine writes it, the app reads it`;
  const fits = v.type === 'trigger' ? to === true
    : v.type === 'boolean' ? typeof to === 'boolean'
      : v.type === 'number' ? typeof to === 'number' && Number.isFinite(to)
        : v.type === 'string' ? typeof to === 'string' && to.length <= 4096
        : typeof to === 'string' && v.options.includes(to);
  if (fits) return '';
  const wanted = v.type === 'trigger' ? 'a fire (true)' : v.type === 'enum' ? `one of ${v.options.join(', ')}` : `a ${v.type}`;
  return `"${name}" takes ${wanted}, not ${JSON.stringify(to)}`;
}

/** Everything due at instant `t`: its writes, ending mixes, entry at 0, then every layer's transitions until none fires. */
function instant(c: Compiled, s: Snapshot, t: number, writes: Write[], clock: ClockRead, entries?: StateEntry[]): void {
  'worklet';
  for (const w of writes) {
    const i = c.index[w.value];
    if (i === undefined || (!w.hit && writeProblem(c, w.value, w.to))) continue; // the hook and the rig refuse these first
    s.vals[i] = c.values[i]!.type === 'trigger' ? true : w.to;
  }
  for (let li = 0; li < c.layers.length; li++) {
    const l = s.layers[li]!;
    if (l.mixTr >= 0 && l.mixEnd <= t) {
      const tr = c.layers[li]!.trans[l.mixTr]!;
      l.mixTr = -1;
      run(tr.end, s.vals);
    }
  }
  if (s.t < 0) {
    for (let li = 0; li < c.layers.length; li++) {
      const branch = c.layers[li]!.entry.find((e) => allHold(e.when, s.vals, [])) ?? c.layers[li]!.entry[c.layers[li]!.entry.length - 1]!;
      enter(c, s, li, branch.to, null, t, clock);
    }
  }
  const used: number[][] = c.layers.map(() => []);
  const changes = c.layers.map(() => 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (let li = 0; li < c.layers.length; li++) {
      if (changes[li]! >= MAX_CHANGES) continue;
      if (step(c, s, li, t, clock, used[li]!, entries)) {
        changes[li]! += 1;
        changed = true;
      }
    }
  }
  for (let i = 0; i < c.values.length; i++) if (c.values[i]!.type === 'trigger') s.vals[i] = false;
  s.t = t;
}

/** The next instant after `s.t` at which something is due without a write: an exit time or a mix's end. */
function nextDue(c: Compiled, s: Snapshot): number {
  'worklet';
  let next = Infinity;
  for (let li = 0; li < c.layers.length; li++) {
    const L = c.layers[li]!;
    const l = s.layers[li]!;
    if (l.s < 0) continue;
    if (l.mixTr >= 0) { if (l.mixEnd > s.t) next = Math.min(next, l.mixEnd); continue; }
    if (L.clock) continue; // exit times are refused on named-clock layers
    for (const list of [L.any, L.byState[l.s]!]) {
      for (const i of list) {
        const e = exitTime(L, l, L.trans[i]!);
        if (e > s.t) next = Math.min(next, e);
      }
    }
  }
  return next;
}

/**
 * The machine at `toMs`, from `s`, with `writes` applied at their times (those after `s.t` and at or before `toMs`;
 * a write before 0 applies at 0). Pure: `s` is not changed.
 */
export function advance(c: Compiled, s: Snapshot, toMs: number, writes: Write[], clock: ClockRead, entries?: StateEntry[]): Snapshot {
  'worklet';
  const out = copy(s);
  const due = writes
    .map((w, i) => ({ w, i, at: Math.max(0, w.at) }))
    .filter((x) => x.at > out.t && x.at <= toMs)
    .sort((a, b) => a.at - b.at || a.i - b.i);
  let k = 0;
  if (out.t < 0 && toMs >= 0) {
    const atZero: Write[] = [];
    while (k < due.length && due[k]!.at === 0) atZero.push(due[k++]!.w);
    instant(c, out, 0, atZero, clock);
  }
  for (let guard = 0; guard < 100000; guard++) {
    if (out.t < 0) break;
    const nextWrite = k < due.length ? due[k]!.at : Infinity;
    const t = Math.min(nextWrite, nextDue(c, out));
    if (!(t <= toMs)) break;
    const now: Write[] = [];
    while (k < due.length && due[k]!.at === t) now.push(due[k++]!.w);
    instant(c, out, t, now, clock, entries);
  }
  if (out.t >= 0) out.t = Math.max(out.t, toMs);
  return out;
}

/** A clip's own time for a state's loop mode; under reduced motion a once-clip shows its end and a loop its start. */
function clipTime(loop: number, ms: number, local: number, reduced: boolean, reducedAt?: number): number {
  'worklet';
  if (ms === 0) return 0;
  if (reduced) return reducedAt ?? (loop === 0 ? ms : 0);
  if (loop === 0) return Math.min(local, ms);
  if (loop === 1) return local % ms;
  const p = local % (2 * ms);
  return p <= ms ? p : 2 * ms - p;
}

function lerpPose(a: Pose, b: Pose, w: number): Pose {
  'worklet';
  const channels: Record<string, number> = { ...a.channels };
  for (const k of Object.keys(b.channels)) {
    const bv = b.channels[k]!;
    const av = a.channels[k];
    channels[k] = av === undefined ? bv : av + (bv - av) * w;
  }
  let parts: Record<string, PartBox> | undefined;
  if (a.parts || b.parts) {
    parts = { ...(a.parts ?? {}) };
    for (const k of Object.keys(b.parts ?? {})) {
      const bp = b.parts![k]!;
      const ap = a.parts?.[k];
      if (ap === undefined) { parts[k] = bp; continue; }
      const box: PartBox = { x: ap.x + (bp.x - ap.x) * w, y: ap.y + (bp.y - ap.y) * w, w: ap.w + (bp.w - ap.w) * w, h: ap.h + (bp.h - ap.h) * w };
      // rot only when a side has it, so a part keeps the same fields on every frame.
      if (ap.rot !== undefined || bp.rot !== undefined) box.rot = (ap.rot ?? 0) + ((bp.rot ?? 0) - (ap.rot ?? 0)) * w;
      parts[k] = box;
    }
  }
  return parts ? { channels, parts } : { channels };
}

/** State `si`'s pose `local` ms in: its clip, or its 1D blend at the current value. */
function statePose(L: CLayer, si: number, local: number, vals: Literal[], clips: Clips, reduced: boolean): Pose {
  'worklet';
  const st = L.states[si]!;
  if (!st.keys) {
    if (!st.clip) return { channels: {} };
    const clip = clipOf(clips, st.clip);
    return clip.play(clipTime(st.loop, clip.ms, local, reduced, clip.reducedAt));
  }
  const v = vals[st.by] as number;
  const keys = st.keys;
  const at = (k: [number, string]) => {
    const clip = clipOf(clips, k[1]);
    return clip.play(clipTime(st.loop, clip.ms, local, reduced, clip.reducedAt));
  };
  if (v <= keys[0]![0]) return at(keys[0]!);
  for (let i = 1; i < keys.length; i++) {
    if (v <= keys[i]![0]) {
      const a = keys[i - 1]!;
      const b = keys[i]!;
      return lerpPose(at(a), at(b), (v - a[0]) / (b[0] - a[0]));
    }
  }
  return at(keys[keys.length - 1]!);
}

function ease(kind: number, p: number): number {
  'worklet';
  const q = Math.min(1, Math.max(0, p));
  if (kind === 1) return EASE_OUT(q);
  if (kind === 2) return EASE_IN_OUT(q);
  if (kind === 3) return EASE_IN(q);
  return q;
}

/**
 * What the machine draws at `t` (at or after `s.t`, before the next instant): every layer's pose, mixes applied, a later
 * layer's channel or part over an earlier one's.
 */
export function pose(c: Compiled, clips: Clips, s: Snapshot, t: number, clock: ClockRead, reduced = false): Pose {
  'worklet';
  const channels: Record<string, number> = {};
  let parts: Record<string, PartBox> | undefined;
  for (let li = 0; li < c.layers.length; li++) {
    const L = c.layers[li]!;
    const l = s.layers[li]!;
    let p: Pose;
    if (l.s === EXIT) {
      if (l.heldS < 0) continue;
      // An exited layer holds its pose: a blend keeps the input it had when the layer exited.
      const by = L.states[l.heldS]!.by;
      let vals = s.vals;
      if (by >= 0) { vals = s.vals.slice(); vals[by] = l.heldBy; }
      p = statePose(L, l.heldS, l.held, vals, clips, reduced);
    } else if (l.s < 0) {
      continue;
    } else {
      p = statePose(L, l.s, localMs(L, l, t, clock), s.vals, clips, reduced);
      if (l.mixTr >= 0 && t < l.mixEnd && !reduced) {
        const from = L.states[l.mixFrom]!;
        const fromPose = statePose(L, l.mixFrom, sinceEntry(L, l.mixAt, l.mixCAt, t, clock) * from.speed, s.vals, clips, reduced);
        const tr = L.trans[l.mixTr]!;
        p = lerpPose(fromPose, p, ease(tr.ease, (t - l.mixStart) / (l.mixEnd - l.mixStart)));
      }
    }
    for (const k of Object.keys(p.channels)) channels[k] = p.channels[k]!;
    if (p.parts) parts = { ...(parts ?? {}), ...p.parts };
  }
  return parts ? { channels, parts } : { channels };
}

/**
 * Whether the machine at `s` can change what it draws without a write. `frame` is false when every frame-clock layer
 * rests (no mix, no exit time it could take, a still pose), so the app may stop its frame callback; layers on a named
 * clock follow that clock instead and are listed in `clocked` while their pose moves with it.
 */
export function settled(c: Compiled, s: Snapshot, clock: ClockRead, reduced = false): { frame: boolean; awake: string[]; clocked: string[] } {
  'worklet';
  const awake: string[] = [];
  const clocked: string[] = [];
  for (let li = 0; li < c.layers.length; li++) {
    const L = c.layers[li]!;
    const l = s.layers[li]!;
    if (l.s === EXIT) continue;
    if (l.s < 0) { awake.push(L.name); continue; }
    const st = L.states[l.s]!;
    const moving = !reduced && st.loop !== 0 && st.ms > 0;
    // A once-clip can start over at its entry phase on a wrapping clock.
    // A mix and its on_end run on machine time, whatever clock the clips read.
    if (L.clock && l.mixTr >= 0 && s.t < l.mixEnd) { awake.push(L.name); continue; }
    if (L.clock) { if (!reduced && st.ms > 0 && (moving || L.wrap > 0 || localMs(L, l, s.t, clock) < st.ms)) clocked.push(L.name); continue; }
    let busy = l.mixTr >= 0 && s.t < l.mixEnd;
    if (!busy && moving) busy = true;
    if (!busy && !reduced && st.ms > 0 && s.t < l.at + st.ms / st.speed) busy = true; // a once-clip still playing
    if (!busy) {
      for (const list of [L.any, L.byState[l.s]!]) {
        for (const i of list) {
          const tr = L.trans[i]!;
          if (tr.exitAt >= 0 && exitTime(L, l, tr) > s.t && allHold(tr.when, s.vals, [])) busy = true;
        }
      }
    }
    if (busy) awake.push(L.name);
  }
  return { frame: awake.length === 0, awake, clocked };
}

/** The name of the first hit area whose part box (rotated about its centre, radians) holds the point, or ''. */
export function hitTest(c: Compiled, p: Pose, x: number, y: number): string {
  'worklet';
  for (const h of c.hits) {
    const b = p.parts?.[h.part];
    if (!b) continue;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    const r = -(b.rot ?? 0);
    const dx = (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r);
    const dy = (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r);
    if (Math.abs(dx) <= b.w / 2 && Math.abs(dy) <= b.h / 2) return h.part;
  }
  return '';
}

/** The writes a hit on `part` makes at `at`: its trigger, or its value set. */
export function hitWrites(c: Compiled, part: string, at: number, vals: Literal[]): Write[] {
  'worklet';
  const out: Write[] = [];
  for (const h of c.hits) {
    if (h.part !== part) continue;
    const a = h.action;
    out.push({ at, value: c.values[a[0]]!.name, to: a[3] ? true : a[1] >= 0 ? vals[a[1]]! : a[2], hit: true });
  }
  return out;
}

/** A named clock as the CLI simulates it: stepped at its rate from machine time 0, wrapping at its length. */
export function simulatedClock(m: Machine): ClockRead {
  'worklet';
  return (name: string, t: number) => {
    'worklet';
    const k = m.clocks?.[name];
    if (!k) return t;
    // Whole steps first, then ms: n * 1000 / hz is exact at every whole second, where floor(t / step) * step is not.
    const n = Math.floor((Math.max(0, t) * k.step_hz) / 1000 + 1e-9);
    const stepped = (n * 1000) / k.step_hz;
    return k.wrap_ms ? stepped % k.wrap_ms : stepped;
  };
}

/** An event a composition takes (seconds): a trigger `{name, at}`, a write `{name, to, at}`, or a hit `{pointer, x, y, at}`. */
export type MachineEvent = { name?: string; to?: Literal; pointer?: 'tap' | 'down' | 'up'; x?: number; y?: number; at: number };
export type MachineRig = ((ms: number, events?: MachineEvent[]) => Pose) & {
  /** Each layer's state, the values, and what keeps the machine awake, at `ms`. For `--trace` and the settle rule. */
  inspect: (ms: number, events?: MachineEvent[]) => {
    states: Record<string, string>; values: Record<string, Literal>; awake: string[]; clocked: string[];
    reasons: Record<string, string>; writes_ms: number[];
  };
};

/**
 * A rig(ms, events) for the CLI and Remotion: the machine replayed from its start to `ms` with the events as writes,
 * named clocks simulated. A pointer event hit-tests the part boxes drawn at its instant and makes that hit's writes.
 */
// It runs on the JS thread (the CLI's rig); the directive keeps every engine export a worklet, as --export checks.
export function machineRig(m: Machine, clips: Clips, defaults: MachineEvent[] = []): MachineRig {
  'worklet';
  const c = compile(m, clips);
  const clock = simulatedClock(m);
  const wrappedMotion = new Map<string, boolean>();
  const movesOnWrap = (L: CLayer, si: number, vals: Literal[]) => {
    const st = L.states[si]!;
    const end = Math.min(L.wrap * st.speed, st.ms);
    if (!Number.isFinite(end)) return true;
    const key = JSON.stringify([L.name, si, vals[st.by]]);
    const cached = wrappedMotion.get(key);
    if (cached !== undefined) return cached;
    // Sample the effective pose at 120 Hz, including the phase endpoint. Bound the work for very long clips.
    const keyAt = (ms: number) => JSON.stringify(statePose(L, si, ms, vals, clips, false));
    const first = keyAt(0);
    const steps = Math.min(12000, Math.ceil(end * 120 / 1000));
    let moving = keyAt(end) !== first;
    for (let i = 1; !moving && i < steps; i++) moving = keyAt(end * (i / steps)) !== first;
    wrappedMotion.set(key, moving);
    return moving;
  };
  const writesOf = (events: MachineEvent[]): Write[] => {
    const writes: Write[] = [];
    const sorted = events.map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i);
    for (const { e } of sorted) {
      const at = e.at * 1000;
      if (e.pointer) {
        if (e.pointer !== 'tap') continue; // down and up hit areas wait for a runtime gesture model (M2)
        const s = advance(c, start(c), at, writes, clock);
        const part = hitTest(c, pose(c, clips, s, at, clock), e.x ?? 0, e.y ?? 0);
        if (part) writes.push(...hitWrites(c, part, at, s.vals));
      } else if (e.name !== undefined) {
        const to = e.to ?? true;
        const problem = writeProblem(c, e.name, to);
        if (problem) throw new Error(`event ${e.name}${e.to === undefined ? '' : `=${String(e.to)}`}@${e.at}: ${problem}`);
        writes.push({ at, value: e.name, to });
      }
    }
    return writes;
  };
  const at = (ms: number, events: MachineEvent[]) => {
    const writes = writesOf(events);
    return { writes, s: advance(c, start(c), ms, writes, clock) };
  };
  const rig = ((ms: number, events: MachineEvent[] = defaults) => {
    const { s } = at(ms, events);
    return pose(c, clips, s, ms, clock);
  }) as MachineRig;
  rig.inspect = (ms: number, events: MachineEvent[] = defaults) => {
    const { s, writes } = at(ms, events);
    const states: Record<string, string> = {};
    const reasons: Record<string, string> = {};
    c.layers.forEach((L, li) => {
      const l = s.layers[li]!;
      states[L.name] = l.s === EXIT ? 'exit' : l.s < 0 ? '' : L.states[l.s]!.name;
      reasons[L.name] = l.s >= 0 ? L.states[l.s]!.reason : '';
    });
    const values: Record<string, Literal> = {};
    c.values.forEach((v, i) => { values[v.name] = s.vals[i]!; });
    const z = settled(c, s, clock);
    const clocked = z.clocked.filter((name) => {
      const li = c.layers.findIndex((L) => L.name === name);
      const L = c.layers[li]!;
      const si = s.layers[li]!.s;
      return !L.wrap || L.states[si]!.loop !== LOOP.once || movesOnWrap(L, si, s.vals);
    });
    // Only writes applied by `ms` count: a write after it has not happened yet at this sample.
    return { states, values, awake: z.awake, clocked, reasons, writes_ms: writes.filter((w) => w.at <= ms).map((w) => w.at) };
  };
  return rig;
}
