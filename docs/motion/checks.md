# Checks

Three checks before anything is called done: one command, a frame list to look at, and the alive checklist (body). (rossark §7.10, §11.6; huashu 07 §16–17: check with numbers, and look at the film at normal speed)

## 1. skac compare (one command)

`skac <Name> --render` writes the mp4 and runs `compare` on it. Run `skac compare` yourself to measure other files or to rank versions. It probes each video with ffprobe, reads every frame's luma and change at 390 px wide, and prints one JSON document. `ok` is false when a video fails `spec_ok` or has blank frames.

```bash
skac <Name> --render
skac compare a.mp4 b.mp4 c.mp4 --event 4.0 --expect=780x1734@60/8 --baseline a
```

Options: `--event S` the second the tap or input lands (default 4.0); `--expect=WxH@fps/seconds` the format to require, or `none` (the default for `compare`; `--render` takes it from the composition's registration); `--baseline NAME` the video (file name without .mp4) the others are compared with.

Fields, per video, under `videos[]`:

| Field | Meaning | Pass |
|---|---|---|
| `probe` | width, height, fps, duration, codec, pix_fmt from ffprobe | h264, yuv420p |
| `spec_ok` | the probe matches `--expect` (size and fps exact, duration within 0.05 s) | true |
| `frames` | frames read | 240 for 8 s at 30 fps |
| `blank_frames` | frames whose mean luma is above 200: a lost GL context renders white; counted on every frame, not only the 30 fps instants | 0 |
| `motion.before_event`, `motion.after_event` | mean per-frame change (YDIF) before and after `--event` | a whole-frame mean, so it scales with the character's area: there is no absolute bar. Read `before` against a reference build of the same frame size, and `after` > `before`. Example: a 150 pt character in a 390x867 frame with the idle at these docs' sizes reads about 0.15, which is right for that frame; in the six-build test, rossark scored 0.152 and huashu 0.311 at their own sizes |
| `still_frames` | frames with almost no change (YDIF < 0.05): long holds or a dead idle | a few at most; no run of them while on screen |
| `jerk` | mean of \|d[i+1] − 2d[i] + d[i−1]\| over the YDIF series: how abruptly the amount of motion changes. Lower is smoother; grain or boiling lines raise it | ≤ 0.25 (rossark 0.179; huashu 0.424, its snaps) |
| `peak.ydif`, `peak.at_s` | the largest single frame change and when | ≤ 5.25 (rossark's, its hop; a build whose burst left on an expo-out curve scored 9.63) |
| `vs_baseline.jerk`, `vs_baseline.peak` | jerk and peak as a ratio to the baseline | both ≤ 1.4 |

And a `summary`: `smoothest_first` (by jerk), `gentlest_peak_first`, `liveliest_after_event_first`, and `failures`.

A high peak points at a burst that breaks the speed cap (anticipation), or at parts that peak together (body); a high jerk at snaps (a face swap, a 0.1 s glance). compare measures a 60 or 120 fps render on the 30 fps instants from frame 0 (every 2nd or 4th frame), so its numbers equal a 30 fps render's. The rig rules do not judge smoothness or stacked peaks: `jerk` and `peak` above do, on the rendered video.

## 2. Frames to look at

Capture the moments below, then look at each once at full size, then once more at 390 wide (the phone's own size), where the mouth and eyes must still read. `--screenshot` renders once at scale 1 and joins the frames into a labelled sheet:

```bash
skac <Name> --screenshot --at=0.5,2.0,3.0,4.03,4.2,4.5,5.0,5.8,6.6,7.5 --sheet
```

Read `captures[]` and `sheet` in the reply, then open each PNG with your image tool.

| Time | What to see |
|---|---|
| 0.5 | rest pose reads as the spec drawing; frame 0 is a good drawing (reduced motion) |
| 2.0 | an idle event in progress: a glance with the weight shifted, not just breathing |
| 3.0 | a second, different idle event |
| 4.03 | the tap ring has started; the face is already changing (shock leads) |
| 4.2 | shock: wide eyes and a readable O mouth (faces minimum), body nearly still |
| 4.5 | the wind-up: squashed, eyes shut tight |
| 5.0 | in the air: feet hanging, shadow smaller, arms or wings up |
| 5.8 | the delight: grin, ^^ eyes, a wave or weight shift |
| 6.6 | a calmer beat on the way home |
| 7.5 | back at rest, still alive, inside 180 pt of the rest centre |

Also check: no text or part touches the frame edge; no seam or glasses ring on closed eyes (zoom to 3×); the body outline stays round under squash (scale about the ground point).

Delete the captures when you are done.

## 3. Watch it at normal speed

Smoothness does not show on stills. Play the whole render once at real speed, and the busiest 2 s around the reaction twice. (huashu 镜头语言 §5)

## 4. What each check proves, and what it cannot see

`--check` reads the rig's samples on a fixed 120 Hz grid, so a rule gives the same verdict at 30, 60 and 120 fps. A part's position is its box centre. The reply lists `failures` (errors) and `warnings`. A warn never fails `--check`. A rig rule became an error only when its own broken mutation fails it and the base combo passes (calibration, 13 Nov). The engine and spec rows are always errors; `cfg.rules` cannot turn them off.

| check id | reads | proves | cannot see | default |
|---|---|---|---|---|
| `skac/speed-cap` | part x, y per sample | no root part, and no child relative to its parent, moves faster than 0.54 pt/ms; with `meta.kind: 'interface'`, 2.1 pt/ms (a 390 pt carry in 560 ms on inOut cubic) | whether the speed looks right; a slow part that jumps is caught only by `jerk` on the render. A good combo's take-off stretch reaches 0.591 pt/ms, so an error would fail good motion | warn (calibrated: extent and fast raise it, but the base raises it too) |
| `skac/min-change` | face channels | no face channel crosses 90% of its range in under 100 ms in one monotonic run (the faces.md blink passes, a 50 ms close fails) | a slow lead-in followed by a one-step snap counts as one run and passes | error |
| `skac/overshoot` | channels named in `meta.settle` | a channel passes its settle value by at most 5% of its range | channels with no `settle` entry; overshoot in a part's position | error |
| `skac/in-frame` | part boxes, frame width, height, scale | no part box comes within 4% of the frame edge | what is drawn outside the box (shadows, tails); the box edge is not the ink edge. Extent could not trip it on the test rig | warn (unproven: no mutation raises it) |
| `skac/idle-cadence` | `meta.events`, speed peaks | an idle event, or activity, at least every 2 s before the first input. Characters only: skipped for `meta.kind: 'interface'` | whether the idle looks alive; a twitch counts as an event | warn (unproven: no mutation raises it) |
| `skac/dead-hold` | all channels and parts; for an interface, the channels and parts its beats name | a character: nothing holds still for more than 500 ms (the character rule). An interface: inside one change (beats sharing `change`, or one beat), what its beats move never stalls over 250 ms; rest after the change is not judged | a small visible move below the still thresholds reads as still; an interface's change is self-declared | warn (unproven: no mutation raises it) |
| `skac/loop-seam` | first and last sample, when `meta.loop` | the step from the last frame to the first is no bigger than the largest step inside the clip | a seam in motion direction or speed that has the same position; only runs for a looping clip | warn (unproven: no mutation raises it) |
| `skac/determinism` | two samplings of the same times | the rig is a pure function of ms (no clock, random or kept state) | state that differs only between renders or machines | warn (unproven: no mutation raises it) |
| `skac/machine-settles` | a machine scene's states on the grid (`<Name>.machine.json`) | after its last write the machine stops drawing within `meta.settle_ms` (default 1 s), or only loop states that give a `reason` stay awake | a battery cost the app pays at rest; a loop the app should end | error (calibrated: a loop with no reason fails it, the invite passes) |
| `skac/beat-moves` | `meta.beats`, channels or parts | each named beat's channel changes by 5% of its range, or its part travels 0.5 pt, in its window | direction, size or look; self-declared beats are judged against themselves. The nowindup and stretch mutations were missed | error |
| `skac/long-fade` | opacity channels named in `meta.opacity` | no opacity channel goes from 0.05 or less to 0.95 or more (or back) in one monotonic run longer than 250 ms | a fade that is not clear to solid (a 0.3 to 0.7 dim); an element with no `meta.opacity` entry. Skipped when the scene has no `meta.opacity` | warn (calibrated: the longfade mutation fails it, the interface sample passes) |
| `skac/crossfade` | opacity channels in `meta.opacity`, part boxes | at a swap (one opacity channel falls and another rises through 0.5 within 150 ms) some part moves 2% of the frame's diagonal or scales 10% across 400 ms, carry.mjs's carried test | whether the part that moves is the thing that survives; a scene with a swap and no parts always warns. Skipped when the scene has no `meta.opacity` | warn (calibrated: the crossfade mutation fails it, the interface sample passes) |
| `skac/abrupt` | part centres at 30 fps (in the parent's frame), interfaces only | pathcheck.mjs's KINK: no change of speed over 12/1920 of the long side and over half the speed around it (a start or stop at full speed). pathcheck's JUMP is `skac/speed-cap`: a move over the cap in one frame is a speed over the cap | characters (a hop leaves and meets the ground at speed: the contact rules judge it); channels: a progress or opacity channel is not a place; an element that enters from opacity 0 starts at speed unseen | warn (calibrated: the linear mutation fails it, both samples pass) |
| `skac/morph-path` | `meta.morphs`: each `morphPath` the draw runs, as `{ name: { from, to } }` SVG strings | the two strings build the same Skia verbs (H and V are lines, S a cubic, T a quad; checked against CanvasKit), so Skia can blend them | an arc is one verb here, while Skia makes it a sweep-dependent number of conics; paths built in code rather than from SVG strings | error (calibrated: the morph mutation fails it; a morph whose verbs match passes) |
| `skac/ground` | planted parts, `meta.ground_y` | planted parts stand on the contact line when not airborne; floor parts stay on the floor plane | timing: airborne windows are absolute times, so a late hop also shows as a ground finding | error |
| `skac/attached` | `meta.attached` pairs | the distance between two box centres drifts at most `within_pt` (25 and 28 pt on the base combo) | rotation, or a joint that looks wrong but stays in range | error |
| `skac/samples` | every channel and part | no NaN or missing value; the rig was sampled | whether values are right; no rule runs after it fails | error (engine) |
| `skac/no-rules` | rules that ran | at least one rule judged something | that the rule was the right one | error (engine) |
| `skac/kind` | `meta.kind` | it is `'character'`, `'interface'` or absent | that the kind is the right one for the scene | error (engine) |
| `skac/spec-beat` | `<Name>.spec.json` beats, rig samples | each spec beat moves in its window, in the named direction, and reaches its `reaches` min or max | how it looks; relative terms only unless the request gave numbers. Runs only when the spec file exists | error (spec) |
| `skac/spec-point` | spec points, one rendered pixel each | the colour at a named point is within 24 per channel of the spec | anything off the named points | error (spec) |
| `skac/landing` | an asset's `landings`, node boxes on `asset check`'s trace | at its end key (the last change of a channel that moves it inside one clip, so a shrink into the target and the return to idle are left out), or at `at`, the flown node's centre sits inside the target's box widened by `tolerance` | whether the flight looks right on the way; a target that moves after the landing | error (calibrated: a coin that rests beside its label fails it, the same coin landing on its value passes) |
| `skac/text-clear` | every drawn piece and text box on `asset check`'s trace | no piece rests within 4 pt of a text box: neither moved in the 150 ms before, or it is the last frame, so a glow or ring that plays in place on text counts. A pass in flight warns. A piece whose box holds the whole text box is its background. Anything on a landing's target from 100 ms before the landing to 400 ms after, and `allowOverlap` pairs, are exempt | ink: a blur counts its whole feather, a path its control points (a circle is judged by its edge), and a text its glyph ink from Skia's layout, or its declared box (width by 1.2 × font size per line) when it has no font to lay out (a platform font, a host slot with no `--font`), so such a centred text reads wider than it draws | error, `warn` or `off` in `skia-motion.json` (calibrated: a burst played in place on a label fails it; the lamp has no text) |
| `skac/text-in-plate` | texts, the filled round rects behind them (or `plate: <id>`), images, on `asset check`'s trace | at rest, a plate's content (texts and images inside it) is centred across and down within 1 pt, down by the texts' optical band (cap height, or x-height for lowercase only); it keeps 4 pt inside every edge; the plate changes size by at most 1 pt between values. An image beside a text on one row is centred on the text's optical band within 1 pt, and their ink gap holds within 1 pt across values | values the trace never shows (set each with `--commands`); a round end's curve (the box is judged); texts with no font to lay out, listed as `unmeasured` | error, `warn` or `off` in `skia-motion.json` (calibrated: a hand-placed coin counter pill fails it, the same pill placed from the measured ink passes) |
| `skac/causal-chain` | an earned moment's `chain` (beats, their channels, causes and contacts) and the clip's keys | every beat but the first starts 0 to 80 ms after the contact that causes it, so each beat is set off by the one before, not by the clock; one beat, the trigger, has no cause. Beats off one contact at one ms, and moving channels no beat claims, warn | whether the contact is where things touch on screen: contacts are declared times or a beat's end; the read at real speed judges the touch | error, `warn` or `off` in `skia-motion.json` (calibrated: a chest whose lid opens 120 ms after the shake ends fails it, the same chest keyed at its contacts passes; the lamp, marked earned, fails with no chain and lists 17 start times) |
| `skac/rest-spec` | spec parts, still at t=0 | each part box's edges sit on the drawing's edges | an edge up to one stroke width too far in, when a colour boundary lies inside the part | error (spec) |
| compare's pixel facts (section 1) | the mp4, luma per frame | format, blank frames, jerk, peak, longest still run | a whole-frame mean: a small move on a small character can read still, so look at the frames before trusting `longest_still_s` | reported, not a rule |

No check judges beauty. A look at the end still is still required.
