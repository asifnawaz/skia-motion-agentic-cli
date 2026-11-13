# AGENTS

This is a skac project: character and interface motion drawn with
@shopify/react-native-skia and rendered by Remotion. Every `skac` command
prints one JSON document; read `ok`, and on `false` read `error` and `hint`.

skac and its motion rules postdate your training data. Read the docs before
writing motion, and never guess a number the docs give.

1. `skac docs blind` first: the whole loop, with no image needed. Then
   `skac docs rules` (every rule, its fix and its topic), `workflow`,
   `gotchas` and `motion/skill`, whole, then the motion topics the job needs
   (`skac docs motion/<topic>`).
2. Write `meta` (fps 60, frames = seconds × 60, `events`, the request's
   `beats`) in `src/<Name>.rig.ts` before any motion. Keep the motion in the
   rig, a pure function of time, and draw from it. Build on `src/motion/`.
3. A task's `src/<Name>.spec.json` is the judge; it wins over the starter.
4. Read `skac <Name> --stats` and `skac <Name> --story`: the motion as
   numbers and as text. Check it does what the request asked, beat by beat.
5. Run `skac <Name> --check`. Fix each item in `failures` where it says,
   using its `fix`. Run it again until `ok`.
6. `skac <Name> --probe=x,y --at=s` reads a colour at a point (AARRGGBB).
7. Then `skac <Name> --render`. Its `compare` block gates `ok` on `spec_ok`
   and `blank_frames`; `jerk`, `peak` and `longest_still_s` are advice with
   marks in `skac docs motion/checks`. Every flag: `skac docs commands`.

Check first; look once at the end with `skac <Name> --screenshot --at=a,b --sheet`.
Looks are counted in `--check`'s `views`. Look more only when no number can
answer. When you cannot view images, `--check` and `--story` are your evidence.

`skac update` refreshes `src/motion/` and this file from the installed skac.
