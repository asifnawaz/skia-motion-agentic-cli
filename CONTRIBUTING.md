# Contributing

## Commits

Use conventional commits. The prefix decides the next version:

| Prefix | Release |
|---|---|
| `fix: ...` | patch |
| `feat: ...` | minor |
| `docs:`, `chore:`, `test:`, `ci:` | none |
| any type with `BREAKING CHANGE:` in the body, or `feat!:` | major |

A `feat`, `fix` or `perf` commit that touches `runtime/`, `src/asset*` or `templates/motion/machine.ts` ends with a
footer line that says what it means for the .skmotion files apps already ship. CI checks it on pull requests
(`node scripts/files-footer.js <base> <head>`), and the release notes gather the lines under "Existing .skmotion files":

```
Files: no change.
Files: optional. skac asset migrate adds <what>; files without it play as before.
Files: required. <why>; run skac asset migrate <file> before upgrading the runtime.
```

"required" goes with a new format major (`skac.asset/2`), a registered migration step and `BREAKING CHANGE:`.

On every push to `main`, once CI passes, semantic-release reads the commits since the last
tag, picks the version, updates CHANGELOG.md, tags, publishes to npm and creates the GitHub release.

## Tests

```bash
npm run test:unit           # fast, no browser
npm run typecheck:runtime   # strict tsc over the packed runtime, as an Expo app compiles it
npm run test:e2e            # creates a project, installs it and renders
```

The runtime ships TypeScript sources, so every app that installs it compiles them with its own settings.
The unit tests bundle the runtime with esbuild, which strips types without checking them. A change under
`runtime/` or `templates/motion/` is not done until `npm run typecheck:runtime` passes. The check
installs pinned host packages (`test/typecheck/package.json`) and runs `tsc` with `strict` and
`noUncheckedIndexedAccess` over every entry point. CI runs it on every pull request. Raise the pins
when the Expo SDK the runtime targets moves.

For a change to drawing performance, run `node bin/skac.js asset cost <file>` on the samples and a real app file before and after the change. Report `objectsPerFrame` and the frame-time percentiles, and pixel-diff `asset frame --out=x.png` renders to show the output is unchanged. `test/unit/asset-cost.test.js` keeps the samples at 2 or fewer Skia objects per frame.

The e2e suite needs `ffmpeg`. It runs `create` and `npm install` itself, which takes minutes.
To reuse a project you already installed, set `SKIA_MOTION_E2E_PROJECT=/path/to/project`.

`runtime/asset-unicode.ts` is generated: the letter and digit tables the worklet-safe text rules read in place
of regular expressions. Regenerate it with `npm run unicode:tables` on a Node whose Unicode version is at least
the one named in the file's first line; the unit test checks it byte for byte on a Node with that version.
