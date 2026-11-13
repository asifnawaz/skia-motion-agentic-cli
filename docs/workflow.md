# Workflow

Check first, look once at the end. Each step names the command and the JSON field to read. Flags and
output fields are in [commands.md](commands.md); the loop and the rig are in `skac docs blind`.

1. **Start.** `skac create my-motion`, then `npm install` once. Inside a project, `add <Name>` writes
   `src/<Name>.tsx` and `src/<Name>.rig.ts` at 60 fps, 480 frames. Read `ok` and `files`.
2. **Read.** `skac docs blind`, `skac docs rules`, `skac docs motion/skill` and the topics it names,
   whole. Then `docs gotchas`.
3. **Look at what exists.** `inspect <Name>`: read `width`, `height`, `fps`, `frames` and `props`.
   (`schema` is for Skia's drawing components, not compositions.)
4. **Write `meta` and the rig.** Put the request's beats in `meta.beats` and the default events in
   `meta.events` first, then `rig(ms, events)`. If the task gives `<Name>.spec.json`, it is the
   judge; its shapes win over the starter's.
5. **Read the numbers.** `<Name> --stats` (ranges, fastest moments) and `<Name> --story` (the motion
   as timed lines, beats beside what moved).
6. **Check.** `<Name> --check`. Read `ok`, then each item in `failures`: `fix` says what to change,
   `docs` which topic to read. Run it again until `ok`. Read `spec.beats`: `self-declared` means
   no spec file, so the rig is graded against its own beats.
7. **Probe colours.** `<Name> --probe=x,y --at=s` reads AARRGGBB at points (in pt) at `s` seconds.
8. **Render.** `<Name> --verify` (frame 0), then `<Name> --render`. Read `ok`, `path` and the
   `compare` block. `--commands "tap@4.0"` passes events; without it the composition uses its own
   default events.
9. **Measure.** `compare` gates `ok` on `spec_ok` and `blank_frames` only. Read the advice too:
   `motion`, `still_frames`, `longest_still_s`, `jerk` and `peak` against `skac docs motion/checks`.
10. **Look once.** `<Name> --screenshot --at=0.5,4.2 --sheet`, then read the PNG. Looks are counted
    in `--check`'s `views`.
11. **Compare versions.** `compare a.mp4 b.mp4` returns `summary` rankings; `--baseline` pins one
    as the reference.
12. **Export for an app.** A scene made with `add <Name> --draw` keeps its drawing in
    `src/<Name>.draw.ts`. When `--check` is ok, `skac <Name> --export <app-dir>` writes the rig, the
    drawing and a component into the app. `skac docs app` has the three-line usage.

If a step fails, read `error` and `hint`, change one thing, and run the same step again.
