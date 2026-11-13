// Character.rig.ts: every moving value of the Character, as a pure function of time in ms.
// Character.tsx draws from rig(ms) and nothing else, so `skac Character --check` tests the numbers that are drawn.
// Pattern for a new composition: write `meta` (fps, size, the beats you were asked for) first, then rig(),
// then run `skac <Name> --check` and read each finding's `fix`. `skac <Name> --story` prints the motion as text.
//
// The shapes below (a round body, a two-leaf sprout) are an example of drawing from named tokens about a pivot,
// not a look to copy. Build your character from your task's Character.spec.json: its boxes, points and beats.

import { bell, keepVolume, wave } from './motion/motion';

export type RigEvent = { name: string; at: number }; // at: seconds

export const meta = {
  fps: 60,
  frames: 480,
  width: 390, // px; points = px / scale
  height: 867,
  scale: 1,
  events: [{ name: 'tap', at: 4.0 }] as RigEvent[],
  // The beats the request asked for, each with the channel that must move inside its window.
  // Character.spec.json holds the same beats for `--check`; these are the fallback when a project has no spec.
  beats: [
    { name: 'crouch', from_ms: 4000, to_ms: 4200, channel: 'stretch' },
    { name: 'hop', from_ms: 4200, to_ms: 4700, channel: 'lift' },
    { name: 'settle', from_ms: 4700, to_ms: 5200, channel: 'squash' },
  ],
  parts: ['body', 'sprout'],
  parents: { sprout: 'body' }, // the sprout rides the body; its own speed is measured relative to it
  settle: { squash: 1 }, // the landing squash comes back to 1 without passing it
  face: ['lid'],
  loop: false,
};

/** The body: an oval standing on `ground`, centred on `cx`, outlined with a `stroke` drawn half outside. */
export const BODY = { cx: 195, ground: 560, width: 150, height: 170, stroke: 4 };

/**
 * The sprout, in pt about its pivot (cx, body top), y up negative. Its box runs from the stem tip to the outer
 * edge of the body's stroke; the leaf tips sit at the box's mid-height and set its half-width.
 */
const SPROUT_TOP = -26;
const SPROUT_BOTTOM = -BODY.stroke / 2;
export const SPROUT = {
  stemTip: SPROUT_TOP,
  stemBase: 8, // inside the body, hidden under it
  stemWidth: 4,
  leafBase: -9, // where both leaves leave the stem
  leafTip: { x: 16, y: (SPROUT_TOP + SPROUT_BOTTOM) / 2 },
  leafBulge: 6, // how far each leaf's edge bows out from its axis
  bottom: SPROUT_BOTTOM,
};

// Idle (ms), two layers as in `skac docs motion/idle`: waves that never stop, and a small event every 1.2-2 s.
// Every idle term is 0 at 0 ms, so frame 0 is the rest pose the spec's boxes describe.
const BREATH_PERIOD = 2600;
const BREATH_DEPTH = 0.02;
const DRIFT_PERIOD = 4800;
const DRIFT = 1.5; // pt of weight drift sideways
const SPROUT_SWAY = [5, 3600, 2, 1900]; // degrees, period; degrees, period
const SPROUT_DRAG = 60; // degrees of sprout tilt per unit of squash or stretch
// Idle events. The eyes lead and the weight follows 100 ms later; the last event ends facing front 400 ms
// before the tap at 4 s, so the reaction starts from a clean pose. A blink lands on each turn.
const GLIDE = 480;
// Glance left, back; right, back (eyes, pt). Mid-hold the eyes settle 1.5 pt further on their target (a small
// saccade), so a held glance stays alive on screen instead of reading as a still frame.
const LOOK: [number, number][] = [[400, -7], [1050, -8.5], [1700, 0], [5400, 7], [6050, 8.5], [6800, 0]];
const WEIGHT = 6 / 7; // pt of body shift per pt of eye lead
const WEIGHT_LAG = 100;
const LOOK_UP: [number, number][] = [[2900, -3.5], [3300, 0]]; // up at its own sprout, then back (pt)
const LOOK_UP_GLIDE = 300;
const SHAKE_AT = 3000; // a small shake while looking up, so the sprout swings
const SHAKE_LENGTH = 600;
const SHAKE = 3; // degrees, two cycles
const BLINKS = [400, 2400, 2660, 5400, 6800, 7500]; // on each turn, a double blink, and one after the last turn
const BLINK_CLOSE = 110; // faces.md: close 110 ms ease-in-out, hold 40, reopen 190 ease-out
const BLINK_HOLD = 40;
const BLINK_OPEN = 190;

// Tap reaction (ms after the event). Each piece starts and ends at rest speed.
const CROUCH_END = 140; // crouch down to CROUCH
const TAKE_OFF = 200; // lift starts
const UNFOLD_END = 260; // unfold from CROUCH to 1 + STRETCH, centred on take-off while the lift is still slow
const LANDING = 700; // lift back to 0
const AIR = LANDING - TAKE_OFF;
const CROUCH = 0.9; // stretch at the lowest point of the crouch
const STRETCH = 0.06; // extra height at take-off, eased back to 1 by landing
const JUMP = 60; // pt: lift = JUMP * sin^2(pi * a), peak speed pi * JUMP / AIR = 0.377 pt/ms
const SQUASH = 0.22; // landing squash: depth SQUASH / e at SQUASH_TIME after contact, never passing 1
const SQUASH_TIME = 90;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** 0 -> 1 with zero speed at both ends. */
const ease = (p: number) => (1 - Math.cos(Math.PI * clamp01(p))) / 2;
const mix = (a: number, b: number, p: number) => a + (b - a) * ease(p);

/** Crouch, unfold and air stretch (1 = rest), lift (pt) and landing squash (1 = rest) after the latest tap. */
function react(ms: number, events: RigEvent[]) {
  const taps = events.filter((e) => e.name === 'tap' && e.at * 1000 <= ms);
  if (!taps.length) return { stretch: 1, lift: 0, squash: 1 };
  const u = ms - taps[taps.length - 1].at * 1000;
  const stretch =
    u < CROUCH_END ? mix(1, CROUCH, u / CROUCH_END)
    : u < UNFOLD_END ? mix(CROUCH, 1 + STRETCH, (u - CROUCH_END) / (UNFOLD_END - CROUCH_END))
    : mix(1 + STRETCH, 1, (u - UNFOLD_END) / (LANDING - UNFOLD_END));
  const lift = u > TAKE_OFF && u < LANDING ? JUMP * bell((u - TAKE_OFF) / AIR) ** 2 : 0;
  const l = Math.max(0, u - LANDING) / SQUASH_TIME;
  const squash = 1 - SQUASH * l * Math.exp(-l); // critically damped: one dip, back to 1
  return { stretch, lift, squash };
}

/** A value that glides (ease, `glide` ms) to each key's value from the key's time; 0 before the first key. */
function track(ms: number, keys: [number, number][], glide: number) {
  let v = 0;
  for (const [at, to] of keys) {
    if (ms < at) break;
    v = mix(v, to, (ms - at) / glide);
  }
  return v;
}

/** 0 = eyes open, 1 = closed. */
function blink(ms: number) {
  const start = BLINKS.filter((b) => b <= ms).pop();
  if (start === undefined) return 0;
  const p = ms - start;
  if (p < BLINK_CLOSE) return ease(p / BLINK_CLOSE);
  if (p < BLINK_CLOSE + BLINK_HOLD) return 1;
  const q = clamp01((p - BLINK_CLOSE - BLINK_HOLD) / BLINK_OPEN);
  return (1 - q) ** 3; // ease-out reopen: fast off the closed lid, slow into open
}

export function rig(ms: number, events: RigEvent[] = meta.events) {
  const { stretch, lift, squash } = react(ms, events);
  const sy = stretch * squash * (1 + BREATH_DEPTH * wave(ms, BREATH_PERIOD));
  const sx = keepVolume(sy);
  const { cx, ground, width, height, stroke } = BODY;
  const half = SPROUT.leafTip.x;
  const look = track(ms, LOOK, GLIDE);
  const lookUp = track(ms, LOOK_UP, LOOK_UP_GLIDE);
  const shift = DRIFT * wave(ms, DRIFT_PERIOD) + WEIGHT * track(ms - WEIGHT_LAG, LOOK, GLIDE);
  const s = (ms - SHAKE_AT) / SHAKE_LENGTH;
  const shake = s > 0 && s < 1 ? SHAKE * Math.sin(4 * Math.PI * s) : 0;
  const [a1, p1, a2, p2] = SPROUT_SWAY;
  const sproutTilt = a1 * wave(ms, p1) + a2 * wave(ms, p2) + shake - (stretch * squash - 1) * SPROUT_DRAG;
  return {
    channels: {
      sy, // body height scale, about the ground point
      sx, // width scale that keeps the volume
      stretch, // crouch and air stretch only
      squash, // landing squash only
      lift, // pt off the ground
      look, // pt the eyes lead sideways; the face follows at a fraction, so it reads as a turn
      look_up: lookUp, // pt the eyes rise (negative is up)
      shift, // pt the body's weight moves sideways
      sprout_tilt: sproutTilt, // degrees about the sprout's pivot
      lid: blink(ms),
      shadow_k: 1 - lift / (JUMP * 2),
    },
    parts: {
      body: {
        x: cx + shift - ((width + stroke) / 2) * sx,
        y: ground - (height + stroke / 2) * sy - lift,
        w: (width + stroke) * sx,
        h: (height + stroke) * sy,
      },
      sprout: {
        x: cx + shift - half * sx,
        y: ground - (height - SPROUT.stemTip) * sy - lift,
        w: 2 * half * sx,
        h: (SPROUT.bottom - SPROUT.stemTip) * sy,
        rot: sproutTilt,
      },
    },
  };
}
