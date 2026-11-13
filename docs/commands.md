# Commands

Every command prints exactly one JSON document on stdout. Success has `ok:true`; every failure is `{ok:false, error, hint}` (plus extras such as `did_you_mean` or `output_tail`) with exit code 1. Stderr is for crashes only. Every `next` list is a set of commands you can run as written.

Run it as `skac <cmd>` once installed. Without installing: `npx skia-motion-agentic-cli <cmd>`.

## Config and global flags

The nearest `skia-motion.json` walking up from the working directory:

```json
{ "entry": "src/index.ts", "root": "src/Root.tsx", "out": "skia-motion-out", "docs": [], "gl": "angle-egl", "rules": {} }
```

`rules` sets a rule's severity (`"error"`, `"warn"` or `"off"`), for example `{ "skac/speed-cap": "error" }`. Every rule is in `skac docs rules`.

Relative paths in the file are relative to the file. Flags beat the file and defaults apply without it. Global flags: `--entry <file>`, `--root <file>`, `--out-dir <dir>` (where renders and `docs-reads.jsonl` go), `--docs-dir <dir>` (repeatable; extra docs topics), `--gl <backend>`, `--help`.

`gl` is the backend Remotion's headless browser draws Skia with: `angle-egl` (default, needs a GPU), `angle`, `egl`, `swangle` (software, for CI and machines without a GPU), `swiftshader` or `vulkan`. `--gl` beats the `SKAC_GL` environment variable, which beats the file.

## Commands at a glance

| Command | Flags | Answers with |
| --- | --- | --- |
| `doctor` | | `ok`, `version`, `environment`, `project`, `checks[]`, `fix[]` |
| `docs [topic]` | `--search <text>`, `--as <reader>` | `index`+`topics[]`, or `topic`+`text`, or `hits[]` |
| `create [dir]` (alias `init`) | `--force` | `dir`, `files[]`, `next[]` |
| `samples [name] [dir]` | `--force` | `samples[]`, or `sample`, `dir`, `files[]` |
| `add <Name>` | `--size 390x867`, `--fps 60`, `--frames 480` | `file`, `rig`, `registered`, `next[]` |
| `schema [Name]` | | Skia drawing components: `components[]`, or `declaration`+`props[]`. Not a composition's props: use `inspect` |
| `inspect [Name]` | | `compositions[]`, or the resolved scene |
| `<Name>` | | the scene plus `next[]` |
| `<Name> --verify` | | `still`, `bytes` |
| `<Name> --screenshot` | `--at=0.5,4.0`, `--advance=<s>`, `--sheet` | `preview`, `captures[]`, `sheet` |
| `<Name> --render` | `--out <file.mp4>`, `--scale <n>` (default 2), `--event <s>` | `path`, `scale`, `compare` |
| `<Name> --stats` | | `fps`, `frames`, `samples`, per channel and part: range and fastest moment |
| `<Name> --story` | | `lines[]`: the motion as text, with the beats beside what moved |
| `<Name> --check` | | `ok`, `failures[]`, `warnings[]`, `skipped[]`, `spec`, `views`, `pixels?`; exit 1 on an error |
| `<Name> --probe=x,y[;x,y]` | `--at=<s>` (one time, default 0) | `probes[]`: `{x, y, color}` in AARRGGBB |
| `lint [files...]` | `--fix` | `findings[]`, `fixed[]` |
| `update` | `--force` | `ok`, `version`, `latest`, `upgrade`, `files[]` |
| `<Name> --commands <inline or file>` | with `--verify`, `--screenshot` or `--render` | as that command; alone it renders |
| `compare <mp4...>` | `--event=4.0`, `--expect=780x1734@60/8` (or `none`, the default), `--baseline=<name>` | `videos[]`, `summary` |

## From rive to skac

| rive | skac | Difference |
| --- | --- | --- |
| `create` | `create [dir]` | Copies the project template into `dir`; installs nothing. `add <Name>` adds a composition to an existing project. |
| `docs` | `docs [topic] [--search]` | Reads the package's own docs and any `docs` dirs from the config; every read is logged to `docs-reads.jsonl`. |
| `schema` | `schema [Name]` | Reads the Skia component types in `node_modules`, not a runtime schema. |
| `inspect` | `inspect [Name]` | Reads the root file and the composition source; events come from a string match on `name === '...'`. |
| `samples` | `samples [name] [dir]` | Lists the bundled examples and copies one; today only `character`. |
| `doctor` | `doctor` | Version, environment, project, then GL/Chrome in place of devices; reports Remotion's browser status and never downloads. |
| `<dir> --verify` | `<Name> --verify` | Renders frame 0 as a still; a composition id replaces the project directory. |
| `--screenshot --advance` | `--screenshot --advance=<s>` | Renders once at scale 1 and extracts frames; `--at=` takes several times and `--sheet` joins them. |
| `--commands` | `--commands <inline or file>` | Lines `event <name> <seconds>`, `advance <seconds>`, `screenshot`; inline `tap@4.0` is shorthand. Events become `--props`, the composition reads them. |

Not covered, with the reason: `login`, `logout`, `whoami`, `push`, `pull`, `library`, `ls`, `workspace`, `open`, `build`, `aot`, `lsp`, `switch`, `uninstall` and `analytics`. There is no account or editor for Skia motion, and publishing is npm's job.

## Each command with real output

Output below comes from real runs. Absolute paths are shown as `./...`, `text` fields are cut at 200 characters with an ellipsis, and long lists are cut to the first entries.

### doctor

Version, environment, project and checks. GL/Chrome stands where rive lists devices: it runs `npx --no-install remotion browser ensure` and reports; it never downloads. `ok` is false when any check fails; each failed check carries a `fix`.

```
skac doctor
```

Exit code 0.

```json
{
  "ok": true,
  "version": "0.0.0-development",
  "environment": {
    "node": "24.19.0",
    "platform": "linux",
    "gl": "angle-egl"
  },
  "project": {
    "dir": ".",
    "config": null,
    "entry": "./src/index.ts",
    "root": "./src/Root.tsx",
    "out": "./run-out"
  },
  "checks": [
    {
      "name": "node",
      "ok": true,
      "detail": "24.19.0"
    },
    {
      "name": "remotion",
      "ok": true,
      "detail": "remotion 4.0.543"
    },
    {
      "name": "skia",
      "ok": true,
      "detail": "@shopify/react-native-skia 2.14.0"
    },
    {
      "name": "ffmpeg",
      "ok": true,
      "detail": "ffmpeg version 8.0.1-3ubuntu2 Copyright (c) 2000-2025 the FFmpeg developers"
    },
    {
      "name": "ffprobe",
      "ok": true,
      "detail": "ffprobe version 8.0.1-3ubuntu2 Copyright (c) 2007-2025 the FFmpeg developers"
    },
    {
      "name": "entry",
      "ok": true,
      "detail": "./src/index.ts"
    },
    {
      "name": "root",
      "ok": true,
      "detail": "./src/Root.tsx"
    },
    {
      "name": "out",
      "ok": true,
      "detail": "./run-out"
    },
    {
      "name": "chrome",
      "ok": true,
      "detail": " | npm warn Unknown env config \"store-dir\". This will stop working in the next major version of npm. See `npm help npmrc` for supported config options. | npm warn Unknown project config \"store-dir\". T…"
    }
  ]
}
```

### docs

The index (docs/README.md) and every topic. With a topic name the whole file comes back in `text`. Every read is appended to `<out>/docs-reads.jsonl` as `{time, topic, path, lines, as}`.

```
skac docs
```

Exit code 0.

```json
{
  "ok": true,
  "index": {
    "path": "./docs/README.md",
    "lines": 66,
    "text": "# Making motion with `skia-motion-agentic-cli`\n\n`skac` (the package `skia-motion-agentic-cli`) turns a project of Skia drawings into an mp4. You draw with\n`@shopify/react-native-skia`; Remotion render…"
  },
  "topics": [
    {
      "name": "gotchas",
      "path": "./docs/gotchas.md",
      "lines": 49,
      "heading": "Gotchas"
    },
    {
      "name": "workflow",
      "path": "./docs/workflow.md",
      "lines": 27,
      "heading": "Workflow"
    }
  ]
}
```

### docs <topic>

One topic. `--as` names the reader in the log (default `agent`). An unknown topic is `ok:false` with `did_you_mean`.

A topic of 250 lines or fewer comes back whole in `text`. A longer one comes back as `sections` plus a `notice`: one entry per `##` or `###` heading, each with `heading`, `lines` (its length; a `##` counts its `###` children) and `read`, the exact command for that section. `skac docs commands` lists about 40 sections instead of 913 lines.

```
skac docs workflow --as agent
```

Exit code 0.

```json
{
  "ok": true,
  "topic": "workflow",
  "path": "./docs/workflow.md",
  "lines": 27,
  "text": "# Workflow\n\nEach step names the command and the JSON field to read afterwards.\n\n1. **Start.** `skac create my-motion` scaffolds a project with a\n   sample character, then `npm install` once. Inside a …"
}
```

A long topic:

```
skac docs commands
```

```json
{
  "ok": true,
  "topic": "commands",
  "path": "./docs/commands.md",
  "lines": 913,
  "notice": "This topic has 913 lines, so only its sections are listed. Read one with: skac docs commands \"<heading>\"",
  "sections": [
    { "heading": "Config and global flags", "lines": 14, "read": "skac docs commands \"Config and global flags\"" }
  ]
}
```

### docs <topic> <section>

One section of a topic: the text from that heading to the next heading of the same or a higher level. The heading matches case-insensitively, exact first, then the one heading that holds all the words you gave. The reply is `{ok, topic, path, section, lines, from, text}`, where `from` is the section's first line in the file. No match, or several: `ok:false`, and `hint` lists the closest headings as read commands.

```
skac docs commands "<Name> --check"
```

### docs --search

Case-insensitive line search over the index and every topic. `text` is cut to 200 characters.

```
skac docs --search motion
```

Exit code 0.

```json
{
  "ok": true,
  "query": "motion",
  "hits": [
    {
      "topic": "README",
      "line": 1,
      "text": "# Making motion with `skia-motion-agentic-cli`"
    },
    {
      "topic": "README",
      "line": 3,
      "text": "`skac` (the package `skia-motion-agentic-cli`) turns a project of Skia drawings into an mp4. You draw with"
    }
  ]
}
```

### create

Scaffolds a project from templates/init. Refuses a non-empty directory unless `--force`. It installs nothing. `init` is an alias.

```
skac create ./my-motion
```

Exit code 0.

```json
{
  "ok": true,
  "dir": "./fresh-proj",
  "files": [
    ".gitignore",
    "package.json",
    "remotion.config.ts",
    "skia-motion.json",
    "src/Character.tsx",
    "src/Root.tsx",
    "src/index.ts",
    "tsconfig.json"
  ],
  "next": [
    "npm install",
    "skac Character --verify",
    "skac Character --render"
  ]
}
```

### samples

Lists the bundled example projects (name, description, files).

```
skac samples
```

Exit code 0.

```json
{
  "ok": true,
  "samples": [
    {
      "name": "character",
      "description": "A friendly vector character with a breathing, blinking idle and a squash-and-stretch reaction to tap events.",
      "files": [
        ".gitignore",
        "package.json",
        "remotion.config.ts",
        "skia-motion.json",
        "src/Character.tsx",
        "src/Root.tsx",
        "src/index.ts",
        "tsconfig.json"
      ]
    }
  ],
  "next": [
    "skac samples character ./my-motion"
  ]
}
```

### samples <name> [dir]

Copies one sample into `dir` (default: the sample name). Same non-empty rule as `create`.

```
skac samples character ./sample
```

Exit code 0.

```json
{
  "ok": true,
  "sample": "character",
  "dir": "./sample-proj",
  "files": [
    ".gitignore",
    "package.json",
    "remotion.config.ts",
    "skia-motion.json",
    "src/Character.tsx",
    "src/Root.tsx",
    "src/index.ts",
    "tsconfig.json"
  ],
  "next": [
    "npm install",
    "skac Character --verify",
    "skac Character --render"
  ]
}
```

### add

Writes `src/<Name>.tsx` from templates/composition.tsx.tmpl and `src/<Name>.rig.ts` from templates/rig.ts.tmpl next to the root file, and registers the composition in the root file (an import and a `<Composition>` line). The defaults are 60 fps and 480 frames (8 s): frames = seconds × fps. `--fps 120` is allowed; the rules give the same verdict at any rate.

```
skac add Pip
```

Exit code 0.

```json
{
  "ok": true,
  "name": "Pip",
  "file": "./src/Pip.tsx",
  "rig": "./src/Pip.rig.ts",
  "root": "./src/Root.tsx",
  "registered": {
    "id": "Pip",
    "width": 390,
    "height": 867,
    "fps": 60,
    "frames": 480
  },
  "next": [
    "skac Pip --check",
    "skac Pip --story",
    "skac Pip --verify"
  ]
}
```

### schema

For Skia's drawing components, not your compositions: a composition's props come from `inspect <Name>`. The drawing components exported by @shopify/react-native-skia, read from its .d.ts files in the project's node_modules.

```
skac schema
```

Exit code 0.

```json
{
  "ok": true,
  "skia_version": "2.14.0",
  "count": 62,
  "components": [
    {
      "name": "Blend",
      "file": "lib/typescript/src/renderer/components/Blend.d.ts"
    },
    {
      "name": "Group",
      "file": "lib/typescript/src/renderer/components/Group.d.ts"
    },
    {
      "name": "ImageFilter",
      "file": "lib/typescript/src/renderer/components/ImageFilter.d.ts"
    },
    {
      "note": "… 59 more"
    }
  ],
  "next": [
    "skac schema Group"
  ]
}
```

### schema <Name>

The component's declaration, its props type text and every type it extends, each with its file.

```
skac schema Group
```

Exit code 0.

```json
{
  "ok": true,
  "name": "Group",
  "file": "lib/typescript/src/renderer/components/Group.d.ts",
  "declaration": "export declare const Group: ({ layer, ...props }: SkiaProps<PublicGroupProps>) => React.JSX.Element;",
  "props": [
    {
      "type": "PublicGroupProps",
      "file": "lib/typescript/src/renderer/components/Group.d.ts",
      "text": "export interface PublicGroupProps extends Omit<GroupProps, \"layer\"> {\n    layer?: GroupProps[\"layer\"] | ChildrenProps[\"children\"];\n}"
    },
    {
      "type": "GroupProps",
      "file": "lib/typescript/src/dom/types/Common.d.ts",
      "text": "export interface GroupProps extends PaintProps, CTMProps {\n    zIndex?: number;\n}"
    }
  ]
}
```

### inspect

No name: every registered composition with its file.

```
skac inspect
```

Exit code 0.

```json
{
  "ok": true,
  "root": "./src/Root.tsx",
  "count": 21,
  "compositions": [
    {
      "id": "PlayMoment",
      "file": "./src/PlayMoment.tsx",
      "lines": 63
    },
    {
      "id": "Mascot",
      "file": "./src/Mascot.tsx",
      "lines": 121
    },
    {
      "note": "… 19 more"
    }
  ]
}
```

### inspect <Name>

The resolved scene: registration, line count, top-level consts, the props it reads (`events`) and the event names it handles (string match on `name === '…'`). `frames` is null with `frames_expr` when the registration is an expression. A bare `skac <Name>` returns the same.

```
skac inspect Character
```

Exit code 0.

```json
{
  "ok": true,
  "id": "Character",
  "component": "Character",
  "width": 390,
  "height": 867,
  "fps": 60,
  "frames": 480,
  "file": "./src/Character.tsx",
  "lines": 64,
  "consts": [
    "COLOR",
    "leafPath",
    "Character"
  ],
  "reads_events": true,
  "props": [
    "events"
  ],
  "events_handled": [],
  "next": [
    "skac Character --verify",
    "skac Character --screenshot --at=0.5,4.0 --sheet",
    "skac Character --render",
    "skac Character --commands \"tap@4.0\" --render"
  ]
}
```

**The `events` prop.** Every composition takes `events`, an array of `{name, at}` with `at` in seconds, for example `[{"name":"tap","at":4.0}]`. `--commands` fills it. With no `--commands` the composition uses its own default: the starter's `Character` and every composition from `add` default to `meta.events` (the starter's is a tap at 4.0 s). `--check`, `--stats` and `--story` use `meta.events` when no events are passed, so the render and the checks see the same events.

### <Name> --verify

Renders frame 0 as a still to `<out>/<Name>/verify.png` with the configured GL backend (`angle-egl` by default). On failure: `ok:false` with `output_tail`.

```
skac SkiaMotionSmoke --verify
```

Exit code 0.

```json
{
  "ok": true,
  "name": "SkiaMotionSmoke",
  "still": "./run-out/SkiaMotionSmoke/verify.png",
  "bytes": 11626,
  "next": [
    "skac SkiaMotionSmoke --screenshot --at=0.5 --sheet"
  ]
}
```

### <Name> --screenshot

One render at scale 1 to `preview.mp4`, then one PNG per time. Each call appends `{at, times}` to `<out>/views.jsonl`; `--check` reports that count. `--sheet` hstacks them with time labels into `sheet.png` (`sheet_labels:false` when ffmpeg lacks drawtext).

```
skac Character --screenshot --at=0.5,4.2 --sheet
```

Exit code 0.

```json
{
  "ok": true,
  "name": "Character",
  "preview": "./run-out/Character/preview.mp4",
  "captures": [
    {
      "t": 0.5,
      "path": "./run-out/Character/0.5.png"
    },
    {
      "t": 4.2,
      "path": "./run-out/Character/4.2.png"
    }
  ],
  "sheet": "./run-out/Character/sheet.png"
}
```

### <Name> --stats

Samples the rig without rendering. Needs `src/<Name>.rig.ts` (see `skac docs blind`). `fps` and `frames` are the composition's; `samples` counts the fixed 120 Hz grid the rules sample on (960 for 8 s), whatever the fps. Each channel has its range and `fastest_at_s`, `fastest_speed_per_ms`; each part has `x` and `y` ranges, `fastest_at_s` and `fastest_speed_pt_per_ms`.

```
skac Character --stats
```

```json
{
  "ok": true,
  "name": "Character",
  "fps": 60,
  "frames": 480,
  "samples": 960,
  "duration_s": 7.9917,
  "events": [{ "name": "tap", "at": 4 }],
  "beats": [{ "name": "crouch", "from_ms": 4000, "to_ms": 4200, "channel": "stretch" }],
  "channels": { "…": "one entry per channel" },
  "parts": { "…": "one entry per part" },
  "next": ["skac Character --story", "skac Character --check"]
}
```

### <Name> --story

Prints the motion as text in `lines`, derived from the rig: each stretch where a channel or part moves, with its time, change, duration and curve, and the beats beside what moved. With a spec file it adds the spec's beats and what each reached. Read it in place of a frame sheet.

```
skac Character --story
```

```json
{
  "ok": true,
  "name": "Character",
  "events": [{ "name": "tap", "at": 4 }],
  "lines": [
    "0.00–0.44 s `sy` 1→1.02 (442 ms, ease-out)",
    "0.40–0.51 s `lid` 0→1 (108 ms, ease-in-out)",
    "0.59–0.89 s part `body` (119.43, 384.59)→(114.63, 385.13) pt, peak 0.02 pt/ms at 0.75 s (300 ms, linear)"
  ]
}
```

### <Name> --probe=x,y --at=s

The colour at one or more points (`'x,y;x,y'`, quoted for the shell), in points from the top left, at `s` seconds (one time; default 0), as AARRGGBB, as rive's `--probe`. It renders one still. Use it to check a colour the task names. (The rig summary is `--stats`.)

```
skac Character --probe='195,475;30,30' --at=0
```

The reply is `{ok, name, at, frame, units: "pt", px_per_pt, probes: [{x, y, color}], next}`.

### <Name> --check

Runs every layer in one report, cheapest first: lint on the composition's file and its rig, the rig rules on the 120 Hz samples, the task's spec file, and, when a render of this name exists in `<out>`, the pixel facts from `compare`. All rules: `skac docs rules`. The loop: `skac docs blind`.

```
skac Character --check
```

Exit code 0 when `ok`, 1 otherwise. The reply:

| Field | Holds |
|---|---|
| `ok` | false when any finding has severity `error` |
| `failures[]` | the `error` findings |
| `warnings[]` | the `warn` findings; reported, never fail |
| `skipped[]` | rules or layers that did not run, each with `reason` (and `run` when a render would add it) |
| `spec` | `{file, beats}`; without a spec file `{file: null, beats: "self-declared", note}` |
| `views` | looks logged so far; with failures, a `hint` says check first, look once |
| `pixels` | after a render: `jerk`, `peak`, `motion`, `still_frames`, `blank_frames`, `spec_ok` |
| `next` | the commands to run next |

A finding is `{ruleId, severity, message, fix, docs, file?, line?, column?, at_s?, channel?, part?, value?, limit?}`. Rig-rule findings also carry `category` (`speed`, `timing`, `face`, `contact`, `framing`, `determinism`, `request`). Stacked peaks and jerk are judged on the render by compare's `peak` and `jerk`. Two engine errors cannot be turned off in `rules`: `skac/samples` (a channel or part came back NaN or missing; it names the channel and the first time) and `skac/no-rules` (no rule ran).

**The spec file.** `<Name>.spec.json` beside the composition is written by whoever sets the task. When it is there, `--check` judges against it; its shapes and colours win over the starter's.

```json
{
  "parts":  { "body": { "x": 118, "y": 388, "w": 154, "h": 174, "tol": 2 } },
  "points": [ { "name": "stem", "x": 195, "y": 376, "color": "FF3E8A57", "at": 0 } ],
  "open":   [ { "number": "hop height", "reading": "left to the builder" } ],
  "beats":  [
    { "name": "crouch", "channel": "stretch", "from_ms": 4000, "to_ms": 4200, "direction": "down" },
    { "name": "hop", "part": "body", "after": "crouch", "direction": "up", "reaches": { "channel": "lift", "min": 55 } }
  ]
}
```

- `parts`: rest-pose boxes in pt at t = 0, checked by `skac/rest-spec`; `tol` per box or `spec.tol`, default 2.
- `points`: a colour at a point; `at` is in seconds (default 0), `color` is `#RRGGBB` or AARRGGBB. Checked by `skac/spec-point`.
- `open`: numbers the author left open; not checked.
- `beats`: windows use `_ms`. A beat watches a `channel` or a `part`. Channel beats use `up` or `down`; part beats also take `left` or `right` (`up` means y falls). `reaches` names the value a channel must hit. An explicit `from_ms`/`to_ms` window wins over `after` and `overlaps`, which then go unjudged. An unmet beat is a `skac/spec-beat` error.
- Without a spec file, `--check` uses `meta.beats` and says the beats are self-declared: the rig is graded against itself.

### lint

Lints source files with the TypeScript compiler's parser and prints findings in ESLint's JSON shape (`ruleId`, `severity`, `message`, `line`, `column`, `fix`, `docs`). With no files it lints the project's compositions and rigs. TypeScript comes from the project, else from skac. `--fix` applies the fixable rules (`skac/no-random`) and lists the files it changed in `fixed`.

```
skac lint src/Character.tsx src/Character.rig.ts --fix
```

### update

Refreshes the project's `src/motion/` files and `AGENTS.md` and `CLAUDE.md` from the installed skac. A file the project never edited is replaced (`updated`, or `same` when nothing changed). A file you edited is kept and listed as `kept-edited`; `--force` replaces it. A file new in the template is `added`. "Edited" means the file differs from the hash recorded in `<project>/.skac-files.json` when the project got it; a project with no record treats files equal to the current template as `same` and the rest as `kept-edited`.

The reply has `version` (installed) and, when `npm view` answers within 5 s, `latest` and `upgrade` (`npm i -g skia-motion-agentic-cli@latest`). Offline is not an error: `latest` is left out.

```
skac update
skac update --force
```

### <Name> --screenshot --advance

One PNG at a single time, as rive's `--advance`.

```
skac Character --screenshot --advance=1
```

Exit code 0.

```json
{
  "ok": true,
  "name": "Character",
  "preview": "./run-out/Character/preview.mp4",
  "captures": [
    {
      "t": 1,
      "path": "./run-out/Character/1.png"
    }
  ]
}
```

### <Name> --commands (file)

A commands file, one per line: `event <name> <seconds>`, `advance <seconds>`, `screenshot` (capture at the current time), `#` comments. Here run.txt is `event tap 1.0`, `advance 0.5`, `screenshot`, `advance 1`, `screenshot`. Events become `--props '{"events":[...]}'`; `captures` lists every PNG. Inline `--commands "tap@4.0 correct@6.5"` is shorthand for `event` lines; inline text on its own means `--render`.

```
skac Character --commands run.txt
```

Exit code 0.

```json
{
  "ok": true,
  "name": "Character",
  "preview": "./run-out/Character/preview.mp4",
  "captures": [
    {
      "t": 0.5,
      "path": "./run-out/Character/0.5.png"
    },
    {
      "t": 1.5,
      "path": "./run-out/Character/1.5.png"
    }
  ]
}
```

### <Name> --render

`npx remotion render … --gl=<gl> --scale=<n>` to `<out>/<Name>/<Name>.mp4`, then compare. `--out` takes a file path, such as `--out=renders/pip.mp4`, not a folder. `--scale` defaults to 2, so a 390×867 pt composition renders at 780×1734 px. The expected size (pt × scale, odd sides rounded down to even for h264), fps and length come from the registration. compare splits before and after at `--event`, else the first `--commands` event, else 4.0 s. `ok` is false when compare fails.

The example below is a 30 fps render from before 60 became the default. A 60 fps render shows `fps: 60`, `frames: 480` and `measured_at_fps: 30`, and every compare reply now has `measured_at_fps` and `longest_still_s`.

```
skac Character --render --scale 2
```

Exit code 0.

```json
{
  "ok": true,
  "name": "Character",
  "path": "./run-out/Character/Character.mp4",
  "scale": 2,
  "compare": {
    "ok": true,
    "event_s": 4,
    "expect": "780x1734@30/8",
    "videos": [
      {
        "name": "Character",
        "path": "./run-out/Character/Character.mp4",
        "probe": {
          "width": 780,
          "height": 1734,
          "fps": 30,
          "duration": 8,
          "codec": "h264",
          "pix_fmt": "yuv420p"
        },
        "spec_ok": true,
        "frames": 240,
        "blank_frames": 0,
        "motion": {
          "before_event": 0.152,
          "after_event": 0.677
        },
        "still_frames": 73,
        "jerk": 0.179,
        "peak": {
          "ydif": 5.25,
          "at_s": 4.4
        }
      }
    ],
    "summary": {
      "smoothest_first": [
        "Character"
      ],
      "gentlest_peak_first": [
        "Character"
      ],
      "liveliest_after_event_first": [
        "Character"
      ],
      "failures": []
    }
  }
}
```

### compare

Measures renders with ffprobe and ffmpeg signalstats. `--expect` has one form, `--expect=WxH@fps/seconds` in video pixels, for example `--expect=780x1734@60/8` for a 390×867 pt composition at the default scale 2; it defaults to `none` (only h264 and yuv420p are required). `--render` builds it from the registration for you. `--event=<s>` defaults to 4.0.

What gates `ok`, and what is advice:

| Field | Meaning | Gates `ok`? |
|---|---|---|
| `spec_ok` | h264, yuv420p, and the probe matches `--expect` (size and fps exact, duration within 0.05 s) | yes |
| `blank_frames` | frames with mean luma above 200, counted on every frame; must be 0 | yes |
| `measured_at_fps` | the rate the motion numbers below were measured at: 30 for a 30, 60 or 120 fps render (measured on the 30 fps instants from frame 0, every 2nd or 4th frame, so the numbers equal a 30 fps render's; blank frames are still counted on every frame); a rate that is not a multiple of 30 is measured as it is | no, a fact |
| `motion.before_event`, `motion.after_event` | mean YDIF before and after `--event` | advice (before ≥ 0.25, after > before) |
| `still_frames` | frames with YDIF below 0.05 | advice |
| `longest_still_s` | the longest run of still frames, in seconds | advice (≤ 0.5 s) |
| `jerk` | mean absolute second difference of YDIF; lower is smoother | advice (≤ 0.25) |
| `peak` | largest single-frame change (`ydif`) and when (`at_s`) | advice (≤ 5.25) |

The marks come from `skac docs motion/checks`. Because the motion numbers are measured at 30 fps instants, the marks hold at 30, 60 and 120 fps. `ok` is false only when a video fails its spec or has blank frames; `--check` turns those two into the errors `skac/video-spec` and `skac/blank-frames`.

```
skac compare loose-a.mp4 loose-b.mp4 --event=4.0 --baseline=loose-a --expect=780x1734@30/8
```

These two renders are 30 fps, so this example names `@30`; it predates `measured_at_fps` and `longest_still_s`.

Exit code 0.

```json
{
  "ok": true,
  "event_s": 4,
  "expect": "780x1734@30/8.0",
  "videos": [
    {
      "name": "loose-rossark",
      "path": "./loose-rossark.mp4",
      "probe": {
        "width": 780,
        "height": 1734,
        "fps": 30,
        "duration": 8,
        "codec": "h264",
        "pix_fmt": "yuv420p"
      },
      "spec_ok": true,
      "frames": 240,
      "blank_frames": 0,
      "motion": {
        "before_event": 0.152,
        "after_event": 0.677
      },
      "still_frames": 73,
      "jerk": 0.179,
      "peak": {
        "ydif": 5.25,
        "at_s": 4.4
      },
      "vs_baseline": {
        "jerk": 1,
        "peak": 1
      }
    },
    {
      "name": "loose-huashu",
      "path": "./loose-huashu.mp4",
      "probe": {
        "width": 780,
        "height": 1734,
        "fps": 30,
        "duration": 8,
        "codec": "h264",
        "pix_fmt": "yuv420p"
      },
      "spec_ok": true,
      "frames": 240,
      "blank_frames": 0,
      "motion": {
        "before_event": 0.311,
        "after_event": 0.809
      },
      "still_frames": 56,
      "jerk": 0.424,
      "peak": {
        "ydif": 5.6,
        "at_s": 4.73
      },
      "vs_baseline": {
        "jerk": 2.37,
        "peak": 1.07
      }
    }
  ],
  "summary": {
    "smoothest_first": [
      "loose-rossark",
      "loose-huashu"
    ],
    "gentlest_peak_first": [
      "loose-rossark",
      "loose-huashu"
    ],
    "liveliest_after_event_first": [
      "loose-huashu",
      "loose-rossark"
    ],
    "failures": []
  }
}
```

### errors

Every failure is one document, exit code 1, nothing on stderr: `{ok:false, error, hint}` plus extras such as `did_you_mean` or `output_tail`.

```
skac NoSuchComposition
```

Exit code 1.

```json
{
  "ok": false,
  "error": "no composition \"NoSuchComposition\" in ./src/Root.tsx",
  "hint": "run `skac inspect` to list them, or `skac add <Name>`"
}
```

