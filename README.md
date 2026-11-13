# skia-motion: motion for AI agents, drawn with Skia and rendered by Remotion

[![CI](https://github.com/asifnawaz/skia-motion/actions/workflows/ci.yml/badge.svg)](https://github.com/asifnawaz/skia-motion/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/skia-motion.svg)](https://www.npmjs.com/package/skia-motion)

Character and UI motion drawn with [`@shopify/react-native-skia`](https://shopify.github.io/react-native-skia/),
rendered headlessly by [Remotion](https://www.remotion.dev/), and driven by a command line built for agents.

It follows the agent loop of the `rive` CLI: scaffold, edit, check, render, measure. Every
command prints exactly one JSON document, so an agent never has to parse prose.

**No PNG needed.** The motion lives in a pure rig file, and `skac <Name> --check` tests it against
the motion rules and lints the source. Each failure names the part, the time and the fix.
`--stats` and `--story` print the motion as numbers and text, and `--probe=x,y --at=s` reads a colour.
Check first, then look once at the end with `--sheet`;
screenshots are an optional human check, counted but never banned. Start with `skac docs blind`.

## Install

Install once with `npm i -g skia-motion` and run `skac ...`, or skip the install and run `npx skia-motion ...`. The commands below are written as `skac`.

## Start in 60 seconds

```bash
npx skia-motion create my-motion && cd my-motion && npm install && npx skia-motion Character --render
```

That scaffolds a project with a sample character, installs it, and renders an mp4 with a
`compare` report, all as JSON. `create` has the alias `init`.

## Commands

| Command | Does |
|---|---|
| `doctor` | checks version, environment, project, and the headless browser and GL |
| `docs [topic [section]] [--search text]` | the agent docs, as JSON; a long topic lists its sections, read one with `docs <topic> <section>` |
| `create [dir]` | scaffold a project (alias `init`) |
| `add <Name>` | add a composition to a project |
| `samples [name] [dir]` | list example projects, or copy one |
| `inspect <Name>` | the resolved scene: size, fps, frames and the props it reads (`events`) |
| `schema [Name]` | a Skia drawing component's props, such as `schema Group` (not a composition's) |
| `<Name> --stats` / `--story` | per-channel range and fastest moment / the motion as text lines |
| `<Name> --check` | lint, rig rules, the task's `<Name>.spec.json` and pixel facts in one report; exit 1 on an error |
| `<Name> --probe=x,y --at=s` | the colour at a point in pt, as AARRGGBB |
| `lint [files] [--fix]` | lint compositions and rigs with the TypeScript parser |
| `update [--force]` | refresh engine files and instructions from the installed skac |
| `<Name> --verify` | render frame 0 and check it |
| `<Name> --screenshot --advance=1` | one PNG at 1.0 s (`--at=a,b --sheet` for several) |
| `<Name> --render [--scale=2] [--out=file.mp4]` | mp4 plus a `compare` report (scale defaults to 2) |
| `<Name> --commands "tap@4.0"` | pass events to the composition as the `events` prop |
| `compare <mp4...> [--event=4.0] [--expect=780x1734@60/8] [--baseline=name]` | measure blank frames, motion, jerk, peak, rankings |

New compositions run at 60 fps; 120 is allowed. Failures are `{"ok":false,"error":"...","hint":"..."}` with exit code 1. See
[docs/commands.md](docs/commands.md) for every flag.

## Config

`skia-motion.json` in the project root:

```json
{ "entry": "src/index.ts", "root": "src/Root.tsx", "out": "skia-motion-out", "docs": [], "gl": "angle-egl", "rules": {} }
```

`rules` sets a rule's severity (`error`, `warn`, `off`), for example `{ "skac/speed-cap": "error" }`. Rules are listed in `skac docs rules`.

`docs` lists extra topic files your project adds to `docs`. `gl` picks the GL backend; on a machine
without a GPU (CI) use `swangle`, or set `SKAC_GL=swangle`.

## Use it as an agent skill

```bash
npx skills add asifnawaz/skia-motion
```

Or copy `skills/skia-motion` into your agent's skills folder. The skill sends
the agent to `skac docs blind` first.

## Requirements

Node 18 or newer, and `ffmpeg` on your PATH. The first render downloads Remotion's headless browser.

## Releases

Releases are automatic from `main` through semantic-release. See [CHANGELOG.md](CHANGELOG.md)
and [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT.
