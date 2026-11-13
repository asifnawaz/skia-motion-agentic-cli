# Motion: read this first

A standard for any character or interface motion drawn with `@shopify/react-native-skia`, in an app with Reanimated or in a Remotion video rendered by `skac`. Use it to animate a character, give a drawing idle life, act out a reaction to a tap, build a face that changes expression, add a wind-up before a hop, or check a render for smoothness.

It is rossark-motion-skill's method (body, weight, timing, smoothness), huashu-art-motion's face set made into smooth channels, and LottieFiles motion-design's anticipation capped to rossark's speed. Typed templates run in both places.

Calm, believable motion for drawings: nothing teleports, nothing bounces, nothing shouts. The character is never frozen, never stops dead at a pose, and never moves faster than the reference's hop. (rossark §1)

## Read in this order

1. `skac docs motion/principles`: the 12 principles, the engine and curves, recipes for every kind of subject, scenes, interface motion, pitfalls, workflow.
2. `skac docs motion/body`: weight, timing and smoothness for a whole character: the 15 acting rules, the speed cap, the code shape, the alive checklist.
3. `skac docs motion/faces`: the face set (open, blink, look, shock, delight, grin, squint, squeeze, worry) as channels, with times; the readable surprised mouth.
4. `skac docs motion/anticipation`: the wind-up before a burst, and the cap on the burst.
5. `skac docs motion/idle`: idle that is alive, not a breathing icon.
6. `skac docs motion/remotion-and-app`: the sRGB fix, the render command, Skia notes, the app's clocks.
7. `skac docs motion/checks`: `skac compare`, the frame list, watching at speed.

## Templates (copy them next to the drawing)

`skac create` and `skac samples` put them in your project's `src/motion/`; import them from there. In an older project, copy them from the package's `templates/motion/`.

| File | What | Runs in |
|---|---|---|
| `templates/motion/motion.ts` | the engine: `bezier`, the three curves, `track`, `flow`, `seg`, `env`, `wave`, `loop`, `bell`, `seeded`, `hop`, `hopStretch`, `keepVolume`, `spring`, `DEG` | both (no imports, worklets) |
| `templates/motion/clock.remotion.ts` | the sRGB fix and `useClockMs()` | Remotion |
| `templates/motion/clock.app.ts` | `useLoopClock`, `useOneShotClock`, `useLive` | app |
| `templates/motion/face.ts` | `faceAt`, `blinkKeys`, `eyeGeometry`, `mouthGeometry` and their types; no React or Skia, so a rig can import it | both (worklets) |
| `templates/motion/liveFace.tsx` | re-exports `face.ts`, plus `<LiveEye>`, `<LiveMouth>` | both (components take plain values) |

## The method in eight lines

1. One clock in ms; every value is a pure function of it. (rossark §2)
2. Acting channels read `flow`; single moves (a blink) read `track`. (rossark §5.1)
3. Every channel = key pose + idle waves + follow-through by delay + accents. (rossark §5.3)
4. Faces morph through channels in at least 100 ms; nothing swaps. (faces)
5. A burst starts with a wind-up and launches on a gravity arc no faster than 0.54 pt/ms. (anticipation)
6. Idle has an event every 1.2–2 s, each with a cause. (idle)
7. Peaks never share a frame. (body)
8. Done means `skac compare` passes, the frame list reads, and it looks smooth at real speed. (checks)

## Defaults you can change

These set a tone: calm and mature. They are a style, not a law. Override them when your product wants something else, and write the change down in your project.

- Calm motion: no noisy celebration, overshoot 5% at most, one rebound on a landing.
- No text inside character motion; draw characters in vector shapes only.

Licences and which file adapts which source: `NOTICE.md` at the package root.
