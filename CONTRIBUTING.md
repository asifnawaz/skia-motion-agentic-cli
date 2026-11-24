# Contributing

## Commits

Use conventional commits. The prefix decides the next version:

| Prefix | Release |
|---|---|
| `fix: ...` | patch |
| `feat: ...` | minor |
| `docs:`, `chore:`, `test:`, `ci:` | none |
| any type with `BREAKING CHANGE:` in the body, or `feat!:` | major |

On every push to `main`, once CI passes, semantic-release reads the commits since the last
tag, picks the version, updates CHANGELOG.md, tags, publishes to npm and creates the GitHub release.

## Tests

```bash
npm run test:unit   # fast, no browser
npm run test:e2e    # creates a project, installs it and renders
```

The e2e suite needs `ffmpeg`. It runs `create` and `npm install` itself, which takes minutes.
To reuse a project you already installed, set `SKIA_MOTION_E2E_PROJECT=/path/to/project`.

`runtime/asset-unicode.ts` is generated: the letter and digit tables the worklet-safe text rules read in place
of regular expressions. Regenerate it with `npm run unicode:tables` on a Node whose Unicode version is at least
the one named in the file's first line; the unit test checks it byte for byte on a Node with that version.
