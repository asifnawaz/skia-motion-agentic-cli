---
name: skia-motion-agentic-cli
description: Makes, checks and renders character or UI motion drawn with @shopify/react-native-skia and rendered headlessly by Remotion, through skia-motion-agentic-cli commands that all answer in JSON. Checks the motion against numbered rules without opening an image. Use when asked to animate a character or interface in Skia, produce an mp4 of it, or check a motion's timing, smoothness, rules or blank frames.
---

# skia-motion-agentic-cli

Every command prints one JSON document. Read `ok`; on `false`, read `error` and `hint`.

No PNG is needed. Check first; look once at the end.

1. Run `skac docs blind` first. It teaches the whole loop. Then `skac docs rules` for every rule.
2. Read each other topic you need, whole: `skac docs <topic>`. After you create a composition, read `skac docs motion/skill` and the topics it names, and `workflow` and `gotchas`.
3. Start with `create <dir>` or, in a project, `add <Name>` (60 fps, 480 frames; 120 is allowed). Write `meta` and the request's beats in `src/<Name>.rig.ts` before any motion. Keep the motion in the rig, a pure function of time; draw from it.
4. If the task gives `<Name>.spec.json`, it is the judge; its shapes win over the starter's example shapes.
5. `<Name> --stats` and `<Name> --story`: the motion as numbers and as text. Check it against the request, beat by beat.
6. `<Name> --check`. Read `ok`, then each item in `failures`: rule, place, time, `fix`, `docs` topic. Fix there and run it again until `ok`.
7. `<Name> --probe=x,y --at=s` reads a colour at a point, as AARRGGBB.
8. `<Name> --render`. Its `compare` block gates `ok` on `spec_ok` and `blank_frames`; `jerk`, `peak` and `longest_still_s` are advice (`skac docs motion/checks`).
9. Look once at the end: `<Name> --screenshot --at=<key times> --sheet`. Looks are counted in `views`.

Other commands: `lint [files] [--fix]`, `update`. Every flag and field: `skac docs commands`.

Checks carry the code quality and the motion rules, so your attention goes to the motion. If you cannot view images, report the `--story` and `--check` output as your evidence.
