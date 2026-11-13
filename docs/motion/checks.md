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
| `motion.before_event`, `motion.after_event` | mean per-frame change (YDIF) before and after `--event` | before ≥ 0.25 means the idle is not a breathing icon (in the six-build test, rossark scored 0.152, judged too quiet; huashu 0.311); after > before |
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
| `skac/speed-cap` | part x, y per sample | no root part, and no child relative to its parent, moves faster than 0.54 pt/ms | whether the speed looks right; a slow part that jumps is caught only by `jerk` on the render. A good combo's take-off stretch reaches 0.591 pt/ms, so an error would fail good motion | warn (calibrated: extent and fast raise it, but the base raises it too) |
| `skac/min-change` | face channels | no face channel crosses 90% of its range in under 100 ms in one monotonic run (the faces.md blink passes, a 50 ms close fails) | a slow lead-in followed by a one-step snap counts as one run and passes | error |
| `skac/overshoot` | channels named in `meta.settle` | a channel passes its settle value by at most 5% of its range | channels with no `settle` entry; overshoot in a part's position | error |
| `skac/in-frame` | part boxes, frame width, height, scale | no part box comes within 4% of the frame edge | what is drawn outside the box (shadows, tails); the box edge is not the ink edge. Extent could not trip it on the test rig | warn (unproven: no mutation raises it) |
| `skac/idle-cadence` | `meta.events`, speed peaks | an idle event, or activity, at least every 2 s before the first input | whether the idle looks alive; a twitch counts as an event | warn (unproven: no mutation raises it) |
| `skac/dead-hold` | all channels and parts | nothing holds still for more than 500 ms | a small visible move below the still thresholds reads as still | warn (unproven: no mutation raises it) |
| `skac/loop-seam` | first and last sample, when `meta.loop` | the step from the last frame to the first is no bigger than the largest step inside the clip | a seam in motion direction or speed that has the same position; only runs for a looping clip | warn (unproven: no mutation raises it) |
| `skac/determinism` | two samplings of the same times | the rig is a pure function of ms (no clock, random or kept state) | state that differs only between renders or machines | warn (unproven: no mutation raises it) |
| `skac/beat-moves` | `meta.beats`, channels or parts | each named beat's channel changes by 5% of its range, or its part travels 0.5 pt, in its window | direction, size or look; self-declared beats are judged against themselves. The nowindup and stretch mutations were missed | error |
| `skac/ground` | planted parts, `meta.ground_y` | planted parts stand on the contact line when not airborne; floor parts stay on the floor plane | timing: airborne windows are absolute times, so a late hop also shows as a ground finding | error |
| `skac/attached` | `meta.attached` pairs | the distance between two box centres drifts at most `within_pt` (25 and 28 pt on the base combo) | rotation, or a joint that looks wrong but stays in range | error |
| `skac/samples` | every channel and part | no NaN or missing value; the rig was sampled | whether values are right; no rule runs after it fails | error (engine) |
| `skac/no-rules` | rules that ran | at least one rule judged something | that the rule was the right one | error (engine) |
| `skac/spec-beat` | `<Name>.spec.json` beats, rig samples | each spec beat moves in its window, in the named direction, and reaches its `reaches` min or max | how it looks; relative terms only unless the request gave numbers. Runs only when the spec file exists | error (spec) |
| `skac/spec-point` | spec points, one rendered pixel each | the colour at a named point is within 24 per channel of the spec | anything off the named points | error (spec) |
| `skac/rest-spec` | spec parts, still at t=0 | each part box's edges sit on the drawing's edges | an edge up to one stroke width too far in, when a colour boundary lies inside the part | error (spec) |
| compare's pixel facts (section 1) | the mp4, luma per frame | format, blank frames, jerk, peak, longest still run | a whole-frame mean: a small move on a small character can read still, so look at the frames before trusting `longest_still_s` | reported, not a rule |

No check judges beauty. A look at the end still is still required.
