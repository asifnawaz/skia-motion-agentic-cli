# Body, weight, timing and smoothness

How a whole character acts: arrives, lands, gestures, shifts its weight, reacts. A character can hit every pose and still read as a robot. What makes it alive is how it moves between poses, and that it never fully stops. (rossark §5)

## Contents
- Body and head basics
- The 15 acting rules
- Timing and smoothness numbers
- The code shape
- Before calling it alive

## Body and head basics (rossark §4)

- **Layers.** Split the character into Skia groups: back parts (wings, back hair), body, head with the live face, front parts (hands, props).
- **Breathing.** The body group rises 1–2 units, or scales its height 1–2%, with ease-in-out.
- **Head tilt.** The head rotates around the neck pivot. Do not tilt if a hand touches the face; it would come apart.
- **Cropped by an edge.** Draw a few units past the crop, so the cut never shows when the character rises.
- **Parts about pivots, from named tokens.** Put each part's numbers in one named object, in pt about its pivot (the sprout hangs off the body top; y up is negative). Draw the part from those tokens and derive its box from them, so the drawing, the rig and the spec's box cannot drift apart. A working example is `SPROUT` in `templates/init/src/Character.rig.ts` (lines 42-52): stem tip, leaf tip and bottom are tokens, and the sprout's box in the rig is computed from them. It is an example of the method, not a look to copy; take the numbers from your task's spec.
- **A creature without a face rig** still lives through breathing, follow-through on ears or a tail, and an occasional whole-head turn.

## The 15 acting rules (rossark §5, Skia forms)

1. **Poses flow; they do not stop.** Read every acting channel with `flow`, never `track`. To hold a pose, repeat its value; the idle layer keeps the hold moving.
2. **Never a frozen frame (moving holds).** While on screen, every channel carries a small idle layer, even in a "still" pose. Use periods that divide the loop or scene, and give each part its own:
   - breathing: height ±1–1.5% over 2–3 s;
   - limbs and wings: a few degrees on two different periods, left and right out of phase;
   - joints: a few degrees;
   - head tilt: ±2° over 4–5 s;
   - weight: a little sideways drift over 4–5 s;
   - head turn: a hint, about 5% of a full turn.
3. **Layer every channel.** Final value = key pose (`flow`) + idle (`wave`s) + follow-through (a delayed copy of the parent) + accents (a `wave` switched on by `env`: a wing waving, a flutter, a hum).
4. **Follow-through by delay, not by springs.** A child part reads its parent 60–150 ms earlier, at 0.3–0.6 of its strength:
   - counter-motion: `head(t) = own(t) − 0.45 × lean(t − 110)`; the head rights itself a beat after the body leans;
   - trailing: `child(t) += 0.45 × (parent(t − 90) − parent(t))`; the child lags, then catches up, with no overshoot. Wings, leaves, tails, ears and hair work this way.
5. **Bend the limbs.** A limb is two segments sharing one round joint, driven by the root angle `a` and the joint bend `e`; the forearm points at `a + e`. Straight limbs only swing like pendulums. Keep both segments about the same length. Starting angles:

   | Gesture | a | e | Note |
   |---|---|---|---|
   | wave | 60° | +110° | forearm up beside the head, waving ±10–15° every 0.6–0.9 s |
   | hand on the hip | 30° | −95° | the joint breaks the silhouette |
   | fist pump, cheer | 55° | +60° | |
   | arms flung for balance | 80–120° | about 0 | |
   | arms up in a V | 150° | 0 | a raised straight limb can stretch about 30% |

   A one-piece wing or flipper has only `a`: rotate it about its root; a wave is the wing raised 50° with ±16° every 760 ms.
6. **Turn without new drawings (2.5D).** A `yaw` from −1 to 1 slides each part by its depth: what sticks out most (a nose, a beak) about 13% of the head's width; the eyes and mouth about 10%; the outline does not move; parts at the back (ears, wings behind) about 9% the other way; prints on the chest 8–12% of the torso, clipped to it. The pupils lead the turn by about 60 ms and the mouth trails by about 30 ms. Blink on a head turn.
7. **Shift the weight.** The hips slide sideways and carry everything above. The legs rotate from the hips so the feet stay planted: angle ≈ shift / leg length, in radians. The unweighted foot lifts out a little (for example up to 2 pt and 8° when the shift is 7 pt).
8. **Land like a body.**
   - Air time: hover a moment, then fall with gravity, `lift = top × (1 − k²)` (`hop` in motion.ts), stretching 5–10%. Right before contact, the arms or wings go up.
   - Contact: squash 15–20%, snap the arms out, recover with ONE small overshoot (about 1.05), then settle (for example 0.80 at +80 ms, 1.05 at +220 ms, 0.985 at +340 ms, 1.0 at +460 ms).
   - A hop: crouch 5–10%, stretch 5–10%, a parabola up and down, then the same squash. The crouch is the wind-up: anticipation.
9. **Keep the volume.** When the height scales by `sy`, the width scales by `1 / sy^0.6` (`keepVolume`). Scale about the ground contact point, never the centre: `<Group origin={vec(cx, groundY)} transform={[{ scaleX: sx }, { scaleY: sy }]}>`.
10. **Break the symmetry.** Left and right never mirror: different angles, phases and bends. A symmetric pose reads as a mannequin.
11. **In the air, the feet hang.** Anything held up by nothing hangs: the legs fall limp and close together; the toes point down, the foot turned 60–80° at the ankle (oval feet: rotate ±20°, narrow to 70% width and lengthen 25%); one leg folds a little shorter and the two trade slowly; arms hang a little out and sway. Flatten the feet just before touch-down.
12. **The shadow moves with the height.** It stays on the floor, outside the body's lift group, with a gap under anything in the air. Its size is `k = 1 − height / 220` (drawing units), its opacity `0.25 × (0.6 + 0.4k)`. It breathes as a body floats and grows as it falls. It also widens with the squash (multiply its width by `sx`). A flat front view keeps a thin pill or a soft ellipse (for example 120 × 16 pt, blur 3; the starter character in `templates/init/src/Character.tsx` uses 140 × 16 pt, blur 4).
13. **Props and contact.** A prop enters already moving from beyond the screen edge. A rolling prop turns by `Δx / r` and slows with ease-out. The eyes and head follow it; blink on the turn toward it. A strike: weight onto the support side, the free limbs open; the striking limb winds up and stops at the top; it swings through the prop at its fastest, contact at the middle of the swing; it follows through and comes back. A launched prop flies as a throw, `x = x0 + vx·s`, `y = y0 − vy·s + g·s²/2`, spinning, squashed 60–100 ms at contact (15% along the hit, 10% wider). The character watches it go, then reacts.
14. **The camera angle is a build, not a tweak.** A flat side or front view keeps the drawing's own proportions and a thin shadow. A view from a little above changes the whole build: head 40–50% of the height, short torso narrower than the head, no neck, short legs close together, round dark feet from above, a wide oval shadow (1.3–1.5 head widths, a third as tall) with the feet in its lower half. Keep these numbers in one `BUILD` object.
15. **Frame it for where it is seen.** On a phone, as big as the screen allows, with room for the widest pose and the highest jump, feet in the lower part of the screen.

## Timing and smoothness numbers

- **The fastest move.** The fastest body move in the reference build of a side-by-side test of six builds is its hop: 78 pt in 290 ms up, 4 × 78 / 580 ms = 0.54 pt/ms (about 9 pt a frame at 60 fps) at take-off and contact. No body translation in a calm character goes faster. Scale changes: no faster than 0.25 in 140 ms (the landing's 0.80 → 1.05). (rossark, measured in that test)
- **Peaks never stack.** Do not let a squash release, a wing flap and a launch peak on the same frame. Offset them by more than 33 ms (2 frames at 60 fps). The video's peak frame change must stay at or under the reference (checks: peak YDIF ≤ 5.25 at 390 wide).
- **Ease every travel.** Never linear for a spatial move; linear only for endless rotation and progress. (rossark §2; LottieFiles motion-design, slow in and slow out)
- **Enter longer than exit.** An exit is 65–75% of its entrance. (LottieFiles motion-design, timing tables)
- **Calm overshoot budget.** Overshoot 0% on errors and plain moves, 2–5% on feedback, 5% on a landing. Never the 15–30% "playful" or "energetic" values. (LottieFiles motion-design, overshoot budget, capped by this skill's calm default)
- **Distance stretches time.** A move twice as far takes about 1.3× as long; four times, 1.6×. (LottieFiles motion-design, distance-duration scaling)

## The code shape (rossark §5, Skia)

Keep key poses as data, one row per channel, so "hold the wave longer" edits one row:

```ts
const ACT = {
  shift: [[0, 0], [650, 0], [1150, -7], [2050, -6], [2500, 6], [3800, 0], [8000, 0]],
  lean:  [[0, 0], [650, 0], [1150, -4], [2500, 4], [3800, 0], [8000, 0]],
  // ...
} satisfies Record<string, FlowKeys>;

function pose(t: number) {
  const L = hop(t, BEAT.air[0], BEAT.air[1], BEAT.airTop);
  const sy = flow(t, ACT.squash) * (1 + 0.015 * wave(t, 2600)) * (1 + 0.08 * hopStretch(t, BEAT.air[0], BEAT.air[1]));
  const sx = keepVolume(sy);
  const lean = flow(t, ACT.lean) + 1.5 * wave(t, 4500);                   // key pose + idle
  const faceTilt = 2 * wave(t, 4400, 0.2) - 0.45 * flow(t - 110, ACT.lean); // counter-motion
  const wingR = flow(t, ACT.wingR) + 4 * wave(t, 3000) + 2 * wave(t, 1800, 0.3)
    + 16 * env(t, BEAT.wave[0], BEAT.wave[1], 200) * wave(t, 760);       // accent
  const sprout = 5 * wave(t, 3600, 0.4) + 1.4 * (flow(t - 130, ACT.lean) - flow(t, ACT.lean)); // trailing
  return { L, sy, sx, lean, faceTilt, wingR, sprout };
}
```

Draw it with Skia groups; transforms apply about `origin`, rotation in radians:

```tsx
<Group origin={vec(cx, groundY)} transform={[{ translateX: shift }, { translateY: -L }, { rotate: lean * DEG }, { scaleX: sx }, { scaleY: sy }]}>
  <Group origin={vec(cx, cy)} transform={[{ rotate: faceTilt * DEG }]}>{/* face */}</Group>
</Group>
```

## Before calling it alive (rossark §5 checklist)

- [ ] Nothing is frozen while on screen, even in a held pose.
- [ ] No moment where every part stops at once.
- [ ] The head and outer parts arrive after the body.
- [ ] Left and right do not mirror.
- [ ] The weight moves from one side to the other at least once.
- [ ] The head turns at least once, with a blink on the turn.
- [ ] Landings squash and keep the volume.
- [ ] Anything in the air has hanging feet and a shadow that changes with its height.
- [ ] Every prop enters from off screen already moving, and the eyes follow it.
- [ ] No move is faster than the fastest move above, and no two peaks share a frame (compare's `peak` judges stacked peaks on the render).
