# Making motion with `skia-motion-agentic-cli`

`skac` (the package `skia-motion-agentic-cli`) turns a project of Skia drawings into an mp4. You draw with
`@shopify/react-native-skia`; Remotion renders every frame headlessly. Its verbs follow the `rive` CLI.

Every command prints exactly one JSON document. A failure is
`{"ok":false,"error":"...","hint":"..."}` with exit code 1. Read `ok` first.

Read any topic below with `skac docs <topic>`. The topic is the file name without `.md`, so
[workflow.md](workflow.md) is `docs workflow`. `docs` on its own returns this index, and
`docs --search <text>` lists each line, in every topic, that mentions the text.
Topics a project adds through the `docs` list in `skia-motion.json` appear too.

## The loop

You need no image until the end. Each command and its output are in [commands.md](commands.md).

```bash
skac Character --stats
skac Character --story
skac Character --check
skac Character --probe=195,475 --at=0
skac Character --render
```

1. **Write `meta` and the rig.** `src/<Name>.rig.ts` exports `meta` (fps, frames, size, `events`,
   the request's `beats`) and `rig(ms, events)`, a pure function of time. The drawing reads only from it.
2. **`--stats` and `--story`.** `--stats` gives each channel's and part's range and fastest moment.
   `--story` prints the motion as timed text lines, with the beats beside what moved.
3. **`--check`.** Lint, rig rules, the task's spec and, after a render, the pixel facts, in one reply.
   Fix each item in `failures` and run it again until `ok`. When the task gives a
   `<Name>.spec.json` (rest-pose boxes, colour points, beats), `--check` judges against it.
4. **`--probe=x,y --at=s`.** The colour at a point, in points, at `s` seconds (AARRGGBB).
5. **`--render`.** Writes the mp4 and returns a `compare` block. Only `spec_ok` and
   `blank_frames` decide `ok`; the other fields are advice with marks in `skac docs motion/checks`.

The task's spec file wins over the starter's example shapes: the sprout, its boxes and colours are
an example to replace.

New compositions run at 60 fps (frames = seconds × 60); 120 is allowed. The rules give the same
verdict at any rate, and `compare` measures at 30 fps instants, so its marks hold at 30, 60 and 120.

## Commands at a glance

| Command | Does |
|---|---|
| `create [dir]` | scaffold a project (`init` is an alias) |
| `add <Name>` | add a composition and its rig to a project |
| `samples` / `samples <name> [dir]` | list runnable example projects / copy one |
| `inspect <Name>` | the resolved scene: size, fps, frames, the props it reads |
| `schema [Name]` | a Skia drawing component's props (`schema Group`), not a composition's |
| `doctor` | version, environment, project, headless browser and GL |
| `<Name> --verify` / `--screenshot --at=a,b --sheet` | frame 0 as a PNG / stills at chosen times |

Every flag, file and output field is in [commands.md](commands.md).

## Where to look

| You need | Read |
|---|---|
| The loop, the rig and how to read a finding | `docs blind` |
| Every rule, its fix and its topic | `docs rules` |
| Every command, flag and output field | [commands.md](commands.md) |
| The order of work, step by step | [workflow.md](workflow.md) |
| Things that fail silently: colours, blank frames, setup order | [gotchas.md](gotchas.md) |
| Motion rules: start with `docs motion/skill`, then the topics it names | `docs motion/skill`, `motion/principles`, `motion/body`, `motion/faces`, `motion/anticipation`, `motion/idle`, `motion/remotion-and-app`, `motion/checks` |
| Anything your project adds | the `docs` list in `skia-motion.json` |
| A complete project that already works | `samples` |
