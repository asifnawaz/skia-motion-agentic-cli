---
name: skia-motion-agentic-cli
description: Makes, checks and renders motion for characters and interfaces drawn with @shopify/react-native-skia (idle life, a reaction to a tap, a face, a wind-up and hop, a scene on a Skia layer), rendered headlessly by Remotion, through skia-motion-agentic-cli (skac) commands that all answer in JSON. Checks timing, smoothness and numbered motion rules without opening an image. Use when asked to animate a character, mascot or interface in Skia, to plan or time Skia motion for an app screen, to produce an mp4 of it, or to check a motion's timing, smoothness, rules or blank frames.
---

# skia-motion-agentic-cli

Every command prints one JSON document. Read `ok`; on `false`, read `error` and `hint`.

No PNG is needed. Check first; look once at the end.

1. Before you write any motion, read these topics whole, in this order (about 20 KB in all): `skac docs`, `skac docs blind`, `skac docs workflow`, `skac docs rules`, `skac docs gotchas`. They teach the loop, every rule and the known traps.
2. Then `skac docs motion/skill`, and each motion topic it names when your step needs it (`motion/body`, `motion/faces`, `motion/anticipation`, `motion/idle`, `motion/checks`). Read `skac docs commands` by section. A project's own motion skill, if it has one, adds its rules on top.
3. Start with `create <dir>` or, in a project, `add <Name>` (60 fps, 480 frames; 120 is allowed). Write `meta` and the request's beats in `src/<Name>.rig.ts` before any motion. Keep the motion in the rig, a pure function of time; draw from it.
4. If the task gives `<Name>.spec.json`, it is the judge; its shapes win over the starter's example shapes.
5. `<Name> --stats` and `<Name> --story`: the motion as numbers and as text. Check it against the request, beat by beat.
6. `<Name> --check`. Read `ok`, then each item in `failures`: rule, place, time, `fix`, `docs` topic. Fix there and run it again until `ok`.
7. `<Name> --probe=x,y --at=s` reads a colour at a point, as AARRGGBB.
8. `<Name> --render`. Its `compare` block gates `ok` on `spec_ok` and `blank_frames`; `jerk`, `peak` and `longest_still_s` are advice (`skac docs motion/checks`).
9. Look once at the end: `<Name> --screenshot --at=<key times> --sheet`. Looks are counted in `views`.

Other commands: `lint [files] [--fix]`, `update`. Every flag and field: `skac docs commands`.

Checks carry the code quality and the motion rules, so your attention goes to the motion. If you cannot view images, report the `--story` and `--check` output as your evidence.
