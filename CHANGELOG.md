# [2.1.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v2.0.0...v2.1.0) (2026-11-18)


### Features

* animate painted character meshes and pins in motion assets ([a9862af](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/a9862af9782c5bc54493388d01e481563559218b))

# [2.0.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v1.3.0...v2.0.0) (2026-11-18)


### Features

* ship single-file Skia Motion assets for React Native and Expo ([1136d7b](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/1136d7b05dd9f4fc6829ffe381260fd7458568ce))


### BREAKING CHANGES

* Mobile playback and generated app components require
`react-native-skia` 3.0.0 or later. Upgrade Skia in the host app, rebuild
the native app or Expo development client, and regenerate existing
components with `skac <Name> --export <dir>`. Pin Skia Motion to `1.3.0`
if the app still needs Skia v2. Offline Remotion renders keep using
the CLI's pinned renderer.

# [1.3.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v1.2.0...v1.3.0) (2026-11-18)


### Features

* interface motion, a one-file --export behind a draft gate, and project libs ([89c8c62](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/89c8c62b066af0e0ff4464650782447203436fe8))
* state machines for interface motion (M1), exported as one Name.tsx that imports the runtime ([ba7be25](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/ba7be2538b5cc52693093456b1cf56813f1ef124))

# [1.2.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v1.1.2...v1.2.0) (2026-11-13)


### Features

* skac <Name> --export writes the checked rig and draw into an app ([374ffe1](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/374ffe12a173e7f113a0bb5cd902107584240d4a))

## [1.1.2](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v1.1.1...v1.1.2) (2026-11-13)


### Bug Fixes

* **skill:** agents find the skill for app motion and read the docs first ([96b6977](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/96b69774729fa03c8834216e7a12d3bb2ad190d3))

## [1.1.1](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v1.1.0...v1.1.1) (2026-11-13)


### Bug Fixes

* skac --version prints the version ([3d0c881](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/3d0c881a23eeb8af39031e8cba0bb9de51ede31e))

# [1.1.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v1.0.0...v1.1.0) (2026-11-13)


### Features

* --probe-box, and one answer from --check, --stats and --probe ([bc459f1](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/bc459f1a48e959003d3afa095c8bfc313a2eef02))

# 1.0.0 (2026-11-13)


### Features

* skac, a JSON-only motion CLI for agents ([2bcadac](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/2bcadac95918125e33f65c0c482e1dff21cf7f48))
