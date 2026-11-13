# Blind mode: check first, look once

You can make motion without opening an image. skac measures the motion itself and tells you which part broke which rule, at what time, and how to fix it. Your attention goes to the motion, not to code hygiene or rule bookkeeping.

Looking is allowed. It is counted, and it is for what no number can say, such as whether a reaction reads as delight. Check first. Look once at the end.

## The three layers

`skac <Name> --check` runs all three and prints one list of findings, cheapest first.

| Layer | Cost | Reads | Finds |
|---|---|---|---|
| lint | milliseconds | your source | a file and line: wall clock, `Math.random`, hand easing, text in a character |
| rig | about a second | the rig, sampled at the fps | a channel or part and a time: too fast, a face snap, an overshoot |
| pixels | seconds | a render, when one exists | blank frames, jerk, peak, longest still run, size, fps, length; the rest pose and colour points from the spec |

Every rule is in [rules.md](rules.md): `skac docs rules`.

## The spec: what counts as done

Whoever sets the task writes `src/<Name>.spec.json` beside the composition. The rig cannot grade itself, so `--check` reads the spec's boxes, points and beats. Its shape is in the header of `src/spec.js`:

```json
{ "parts": { "body": { "x": 118, "y": 388, "w": 154, "h": 174 } },
  "points": [{ "name": "body", "x": 195, "y": 475, "color": "FFF6C453" }],
  "open": ["how long the hop takes"],
  "beats": [{ "name": "hop", "part": "body", "direction": "up", "reaches": { "channel": "lift", "min": 55 } }] }
```

- `parts` are the rest-pose boxes in pt. `points` are colours at a point (AARRGGBB or #RRGGBB).
- `open` lists the numbers the request leaves to you. Everything not in `open` is fixed by the spec.
- The spec wins over the starter's example shapes. The starter `Character` is an example of drawing from named tokens, not a look to copy.
- With no spec, `--check` says the beats are self-declared (the rig's `meta.beats`) and grades the rig against itself. Ask for a spec.

## The rig: one source of truth

Keep the motion of a composition in a pure file, `src/<Name>.rig.ts`, beside `src/<Name>.tsx`. The drawing imports `rig` and draws from it. skac imports the same file. What is checked is what is drawn.

```ts
export const meta = {
  fps: 60, frames: 480, width: 780, height: 1734, scale: 2, // px; points = px / scale; frames = seconds x fps
  events: [{ name: 'tap', at: 4.0 }],                      // seconds, as --commands passes them
  beats: [{ name: 'shock', from_ms: 4000, to_ms: 4200, channel: 'wide' }], // fallback when there is no spec
  settle: { body_sy: 1 },     // channel -> rest value, for overshoot
  face: ['wide', 'lid', 'o'], // face channels, for min-change
  loop: false,
};
export function rig(ms, events) {
  return {
    channels: { wide: 0 /* number per channel */ },
    parts: { body: { x: 0, y: 0, w: 100, h: 120, rot: 0 } }, // pt, top-left origin (optional)
  };
}
```

- `rig(ms)` is a pure function of time. No clock, no random.
- `channels` are named numbers, unitless or in pt. `parts` are boxes in pt.
- `events` passed to `rig` drive the same motion in a render and in an app.
- A rule whose inputs are missing from `meta` is skipped and listed under `skipped`. It is never guessed. Fill `meta` in to turn the rule on.

`skac add <Name>` writes `<Name>.rig.ts`, and the starter `Character` already has one.

## The loop

1. Read the request and the spec. Draw the rest pose first: write `<Name>.spec.json`'s `parts` boxes and an `open` list of what the request leaves open (when a spec is given, read it instead). Beats live in the spec; without one, write them in `meta.beats` before any motion.
2. Read the rules for the job: `skac docs rules`, then the motion topics it names.
3. Write the rig so frame 0 matches the boxes, then the drawing from it, then the motion.
4. `skac <Name> --check`. Read `ok`, then each item in `failures`.
5. Fix the rig at the place the finding names, using its `fix`. Run `--check` again.
6. `skac <Name> --story` to read the motion as text events instead of frames. Check that the story matches the request, beat by beat.
7. When `--check` is clean: `skac <Name> --verify`, then `skac <Name> --render`. `--check` now adds the pixel facts from that render.
8. One look at the end: `skac <Name> --screenshot --at=<key times> --sheet`. Read the sheet once.
9. Look more only when no number can answer, and say what you looked for.

```bash
skac Character --check
skac Character --story
skac Character --render
skac Character --check
skac Character --screenshot --at=0.5,4.2,4.6,5.0,5.8,7.5 --sheet
```

## Reading a finding

Each finding has the same shape in every layer:

```json
{ "ruleId": "skac/speed-cap", "severity": "error", "message": "...", "fix": "...", "docs": "motion/anticipation",
  "part": "body", "at_s": 4.62, "value": 0.61, "limit": 0.54 }
```

- Lint findings carry `file`, `line`, `column`. Rig findings carry `at_s` and a `channel` or `part`, with the `value` and the `limit`.
- `severity: "error"` fails the check and the exit code is 1. `warn` is reported and never fails it.
- `fix` says what to change. `docs` is a topic: `skac docs <that topic>`.
- Change one thing, then run `--check` again.

Turn a rule off or change its severity in `skia-motion.json`:

```json
{ "rules": { "skac/speed-cap": "error", "skac/no-magic-motion": "off" } }
```

## Other commands in the loop

- `skac <Name> --stats`: per channel and part, the min, the max, the time of the fastest frame and its speed. Use it to find where to look in a rig.
- `skac <Name> --probe=x,y --at=<seconds>`: the colour at a point in pt as AARRGGBB (several points: `--probe="10,20;30,40"`). Use it to check the rest pose without looking. `skac <Name> --probe-box=x,y,w,h --at=<seconds>` lists the box's colours (top 8 by pixel count, with share and bbox in pt), to find what is drawn where.
- `skac lint [files...] [--fix]`: lint only. `--fix` applies the fixable rules.
- `skac update`: refresh the project's engine files and instructions from the installed skac.

Every command and flag is in [commands.md](commands.md).

## Looks are counted

Each `--screenshot` is logged to `<out>/views.jsonl`. `--check` reports `views`. If a look came before the checks passed, it adds a hint: check first, and look once at the end with `--sheet`. The count is information for you, not a penalty.

## Silencing a lint rule

Write `// skac-disable-next-line skac/<id> -- reason`. The reason is required. A disable without `-- reason` is itself an error (`skac/disable-needs-reason`).

## When you can only read text

Everything above works without an image. If you cannot view images at all, stop at step 7 and report the `--story` and `--check` output as your evidence.
