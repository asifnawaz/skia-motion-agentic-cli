# Principles, engine, recipes, scenes, interface, pitfalls

Rossark's rules, every one, adapted to Skia. Numbers are in the drawing's own units (Skia points) and milliseconds. They are starting points, not laws. Sources in brackets.

## Contents
- 1. Principles (hold for anything you animate)
- 2. The engine (`templates/motion/motion.ts`)
- 3. Recipes by subject
- 4. Scenes that tell an action
- 5. Motion in the interface
- 6. Performance and pitfalls
- 7. Workflow
- Left out on purpose

## 1. Principles (hold for anything you animate)

1. **Never teleport.** Interpolate everything. A pupil slides, an arm swings, a mouth morphs. Nothing snaps from one drawing to another. A crossfade between two drawings is still a swap. (rossark §1.1)
2. **Calm by default.** Timed motion with strong curves. No bouncy overshoot. The one allowed rebound is a landing's single overshoot (body, rule 8). (rossark §1.2; the default tone here is warm and mature, no noisy celebration)
3. **Small amplitudes.** Life is subtle. When unsure, halve it. (rossark §1.3)
4. **Arcs and pivots.** Draw every moving part as its own Skia `Group` and rotate it around its joint: an arm's root, a sprout's stem, a head's neck. Sliding in a straight line looks mechanical. (rossark §1.4)
5. **Overlap and follow-through.** Parts do not move together. The tip moves later and further than the base. Give each part the same wave with a phase delay that grows along the chain. (rossark §1.5)
6. **Variety without chaos.** Repeated items (stars, sparkles, leaves) each get their own phase, speed and size from `seeded(i)`. Never `Math.random()` per frame. Never everything in sync. Things on one screen breathe out of phase. (rossark §1.6; huashu 04 §6: same t must render the same pixels)
7. **One main action per scene, plus two or three idle loops.** The main action tells the story. The loops only say "alive". Side characters and backgrounds stay quiet. (rossark §1.7)
8. **Opacity only to appear or disappear** (a sparkle, a ring, a closed-eye line taking over). Never to dim something halfway. (rossark §1.8)
9. **The layout never moves.** Motion lives inside the Canvas, as transforms on groups. Never resize or move the view on the page. (rossark §1.9)
10. **Reduced motion means still.** Loops freeze at frame 0, which must be a good drawing. One-shot scenes show their final frame, which must read on its own. (rossark §1.10)
11. **Nothing runs unseen.** Off screen, hidden or in the background, every clock is paused. (rossark §1.11)
12. **Give every move enough frames.** At 30 fps, anything under about 100 ms is two or three frames and flickers. Blinks close in 110 ms and reopen in 190 ms. Face changes take at least 100 ms. Render or export at 60 fps where the platform allows. (rossark §1.12)

## 2. The engine (`templates/motion/motion.ts`)

- **Clocks.** Everything that moves reads one clock, in ms. One clock per character, group or scene, never one per part. (rossark §2)
  - App: `useLoopClock(period, live)` for idle life, `useOneShotClock(duration, play, reduced)` for a scene that tells an action (`templates/motion/clock.app.ts`).
  - Remotion: `useClockMs()`, which is `frame / fps * 1000` (`templates/motion/clock.remotion.ts`).
- **Tracks.** Keys `[ms, value, 'out'?]` read with `track(t, keys)`. Each segment eases in and out, or eases out when marked `'out'`. In a loop, the last key equals the first. `track` stops at every key: right for ONE move (a blink, a lid). (rossark §2)
- **Flow.** For acting, a chain of poses, use `flow(t, keys)` with keys `[ms, value]`. It passes through every key with a continuous speed and never overshoots one. With `track`, the character stops dead at each pose and reads as a robot. (rossark §2, §5.1)
- **Shaping helpers.** `wave(t, period, phase)` gives -1..1 for sway, bob, breathing. `loop(t, period, phase)` gives 0..1 progress for drift and falling. `bell(p)` fades in and out over a loop. `seg(t, a, b)` turns one beat's window into 0..1. `env(t, a, b, ramp)` gates an accent wave. `seeded(i)` gives stable variety. `hop`, `hopStretch` and `keepVolume` carry body rules 8 and 9. (rossark §2)
- **Curves.** (rossark §2)
  - Things that travel (gaze, sway, a wing swinging, a lid closing): ease-in-out `bezier(0.77, 0, 0.175, 1)`.
  - Things that open or arrive (a mouth, a lid reopening, a prop appearing): ease-out `bezier(0.23, 1, 0.32, 1)`.
  - Only things leaving or falling away: ease-in `bezier(0.55, 0, 1, 0.45)`.
  - Endless loops (rotation, conveyors, falling snow): linear.
  - The engine carries its own bezier solver, so the same curve runs in the app and in Remotion. Do not import `Easing` from `remotion` or from `react-native-reanimated` in shared motion code.

## 3. Recipes by subject (rossark §3, every row)

| Subject | What lives | Recipe |
|---|---|---|
| Character, creature | eyes, breath, head | body and faces. Breathing 1–2 units over 3–5 s; head tilt 3–6°; a blink every 3–4 s |
| Tail, ears, hair, antenna, a leaf on a head | follow-through | Rotation around the root, `wave` with the phase delayed 0.1–0.2 per segment; 4–10° |
| Plant, tree, grass | sway | Rotation around the base, 1.5–4°, 3–6 s a cycle. Leaves add their own small sway on `seeded(i)` phases; tips move more than the base |
| Flag, curtain, cloth, scarf | wave | Split into strips or points; each offsets by `wave(t, period, k·i)`, so the wave travels. Amplitude grows away from the fixed edge |
| Fire, candle | flicker | Lean 2–4° and stretch 3–6% on two waves of different periods (700 and 1100 ms); the inner flame on a third. No random jitter |
| Smoke, steam | rise | Wisps rise 8–14 units while `bell(p)` fades them; 2–3 wisps out of phase |
| Water | ripples, waves | Ripples are rings that grow 0 → 1 and fade with `bell`. Surface waves are a path whose points follow `wave` with a travelling phase. Floating things bob 1–2 units and rock 2° |
| Rain, snow, falling leaves | fall | `loop` per item with a seeded phase, speed (±20%) and x drift. Snow sways sideways on a slow `wave`. Linear |
| Clouds, sky | drift | Horizontal `loop` over 20–60 s; layers further back move slower. Sun rays turn once in 30–60 s |
| Lights, lamps, stars, screens | glow, twinkle | A glow grows 2–5% over 2–4 s. Stars twinkle with a small scale and an opacity dip at seeded times. A screen flickers rarely, never constantly |
| Machines, gears, fans, clocks | mechanism | Gears turn linearly at speeds set by their tooth ratio. A clock hand steps once a second with ease-out; a colon blinks every 0.5 s |
| Phone, alarm, notification | buzz | Bursts of ±3° (4 cycles in about 0.45 s), then a pause. A notification slides in with ease-out and stays |
| Vehicles | ride | The body bobs 0.5–1 unit; wheels rotate linearly; scenery passes in parallax `loop`s. Never shake the whole frame |
| Something waiting to be tapped | a jiggle | A small squash-and-widen pulse (1.5–3%) on a 200–350 ms beat, the bulge moving to one side then the other (about 1% of its width). Stop it during the tap's anticipation; bring it back once at rest |
| Floating, levitating | a float | Rises in from a quarter to a third of its height below and slows, drifts a few percent of its height down and back, leaves rising as it fades. Feet hang; the shadow breathes with the height |
| Icon, logo | a moment | Plays once on appear (a draw-on, a small turn, a blink), then rests. No endless loops on interface chrome. A press is a 0.97 scale on the button, not inside the drawing |
| Chart, diagram | draw-on | One-shot: lines draw with a path `end` (Skia `Path start/end`), bars grow from their base with ease-out and a 40–80 ms stagger, numbers count up with ease-out. Final frame = the data |
| Scene | a story | One one-shot action when the scene appears (section 4 here), then the idle loops of what is in it |

## 4. Scenes that tell an action (rossark §6)

1. **The clock:** a one-shot clock of a few seconds that starts when the scene appears.
2. **The beats:** each beat is a window, written as data: `const BEAT = { tap: 4000, shock: [4000, 4400], windUp: [4400, 4680] }`. `seg(t, a, b)` turns one into 0..1.
3. **Overlap:** the next beat starts a little before the last one ends.
4. **The end:** the scene holds on its final frame and only the idle loops keep running.
5. **A carousel of scenes:** the leaving one finishes its exit before the next starts, or crossfades over it, never through an empty or dark frame. Only the scene on screen runs.

## 5. Motion in the interface (rossark §7)

1. **Frequency decides how much.** Hundreds of times a day (typing, scrolling): no animation. Tens of times (toggles, tab switches): a minimal, fast change. Now and then (sheets, toasts, a screen change): a standard transition. Rarely (onboarding, rewards, completion): full delight, characters, a story. Spend delight where people pass rarely.
2. **Every motion has a purpose:** show where something came from or goes, show a state changed, confirm a touch, explain how something works, or celebrate a rare moment. "It looks cool" is not a purpose on a frequent screen.
3. **Continuity.** An element on both screens travels or morphs between them; it is never removed and redrawn. A transition moves in the direction of the action that caused it. A label that changes meaning morphs.
4. **Durations.** Press feedback 100–160 ms; small popovers 125–200 ms; menus 150–250 ms; sheets and modals 200–500 ms. Keep interface moves under 300 ms when you can. Idle loops in a drawing are exempt.
5. **Curves.** Entering or responding: strong ease-out. Moving on screen: strong ease-in-out. Constant motion: linear. Never ease-in on something the user is waiting for.
6. **Asymmetric timing.** Slow where the user decides, fast where the system answers. An exit is quicker than the entrance (about 65–75% of it). A blink closes faster than it opens. (rossark §7.6; LottieFiles motion-design, entrance and exit)
7. **Nothing appears from nothing.** A shape enters from a scale of 0.9–0.97 with opacity, never from 0. Tiny sparkles and rings are the exception.
8. **Press feedback.** A pressable thing scales to about 0.97 and back. The drawing inside stays as it is.
9. **Interruptible.** If the user acts again mid-animation, continue from the current value toward the new target. Never restart from zero, never jump. In the app that means animating a shared value from where it is (`withTiming(target)` on the current value).
10. **Glitches cost trust.** A hairline seam, a dropped frame, a jump at a loop seam or a flickering blink says the product is careless. Check at full resolution and full frame rate (checks).

## 6. Performance and pitfalls (rossark §8, adapted to Skia)

- **One clock** per character, group or scene; every other value is a function of its time.
- **Pause** clocks off screen, when hidden, in the background and with reduced motion. A loop behind opacity 0 still costs.
- **App, Reanimated + Skia:**
  - derive Skia props with `useDerivedValue` from the clock and pass the derived value to the prop; never `setState` per frame;
  - `withRepeat` restarts from the current value: reset to 0 first, cancel in the cleanup (`clock.app.ts` does it);
  - declare curves at the top of the module (worklet capture);
  - put `live` in the dependencies of anything that starts a clock.
- **Remotion:** every value is a pure function of the frame. No state carried between frames, no `useEffect` timers. A precomputed table is fine if it is built once from pure inputs.
- **Many items** (particles, stars): draw them in one Canvas from the same clock, never one animated view each.
- **Canvases are heavy.** Do not multiply them, and do not keep one running behind another.
- **Drawing traps that show in motion:**
  - **A seam where two edges meet.** Two anti-aliased edges on the same line show a hairline: a cutout ending on its shape's outline, a clip edge on top of another edge. Draw the shape as ONE outline, then zoom in to check.
  - **Overlapping parts in one path** can cancel where their directions differ (nonzero winding) and punch holes. Fill each part on its own. (rossark §8; huashu 04 §6)
  - **A glasses ring around closed eyes.** Clip the lid to a shape 1–2 pt larger than the eye (faces).
- **Determinism:** the same `t` must render the same pixels, twice. Seeded variety only. (huashu 04 §6, 07 §18)

## 7. Workflow (rossark §11)

1. **Read** the project's notes and the header comments of the art file; decisions there are law.
2. **List** what could live in the drawing: the subject, its parts and pivots, repeated items, light, background.
3. **Pick** ONE main action and two or three idle loops. Cut the rest.
4. **Split** the art into Skia groups at their pivots, without changing how frame 0 looks.
5. **Tune** with every number in a token object at the top of the file (`BUILD`, `BEAT`, `ACT`), so "slower", "smaller" or "less" is a one-line change.
6. **Check** frame 0 (reduced motion), the final frame of one-shots, and that every loop closes without a jump. For a character run the alive checklist (body) and checks.
7. **Run** the project's type check, lint and tests where the brief allows.
8. **Hand off** in plain words: what moves, what was left still on purpose, and what has not been seen on a real device.

## Left out on purpose

- rossark's SwiftUI templates and `Motion.swift` (this skill targets React Native Skia and Remotion).
- rossark §10 tools (`sheet.sh`, `track_edges.py`, `sample_colors.py`): reference-video study is not part of this skill; `skac compare` (checks) replaces the measuring.
- huashu's film-making rules (shot lists, camera grammar, art styles, AI-generated character frames): they serve explainer films, not app characters. One camera rule applies here: a fast move is an accent, counted on one hand per film (huashu 镜头语言 §2, §3).
