# [3.4.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v3.3.1...v3.4.0) (2026-11-24)


### Bug Fixes

* **runtime:** a missing font slot draws in the default face, never throws ([d8fbec8](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/d8fbec8d8ecb8105c4d3906b71783c6928a883eb))


### Features

* **asset:** CanvasKit PNG frames ([c73ea77](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/c73ea77505ef8e3d9e867e1c13c46319e2eadca3))
* **asset:** causal-chain check ([79b6ba3](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/79b6ba30cf2b836c001d1957baebcbf168d9b5ee))
* **asset:** landing aim ([27f4734](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/27f4734e4ab5874d472364c24a7b3050fa9f338c))
* **asset:** landings and text-clear checks ([78be856](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/78be856944e4d58092afe9c58a5934d39fc7679c))
* **asset:** text-in-plate check ([83f5b86](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/83f5b86195b91c5231eea903afa5e902cb78e0df))
* **runtime:** rolling counts ([f2f3ede](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/f2f3ede965dfe21bf445a327950c31a0bb2485b6))
* **runtime:** row and plate auto, with the older-Skia fallback ([878959b](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/878959b8bc7e4a93688bac67a7928e3958842b25))

## [3.3.1](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v3.3.0...v3.3.1) (2026-11-24)


### Bug Fixes

* **docs:** earned moments get a wild register and drawn motion ships as an asset ([40f02ea](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/40f02ea7ba87ea2cdc05000da4517ecfc6e7088d))

# [3.3.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v3.2.0...v3.3.0) (2026-11-19)


### Features

* reuse app fonts in packed motion assets ([2283c7f](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/2283c7f0152c5a51d46cba45b1b517aa2a2ee1f6))

# [3.2.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v3.1.1...v3.2.0) (2026-11-19)


### Features

* add binary .skmotion packs for Skia Canvas ([2bf68ed](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/2bf68edfa273e8434e97daedd64de45380a6b8b9))
* add OpenType features and sampled text layout checks ([d97dbb0](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/d97dbb0adb32525f268cfff3d38067dd0ab7999b))

## [3.1.1](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v3.1.0...v3.1.1) (2026-11-18)


### Bug Fixes

* preserve smooth asset playback and guide upgrades ([86e9421](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/86e9421ae0464e15f5165783c6fc316d880724be))

# [3.1.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v3.0.0...v3.1.0) (2026-11-18)


### Features

* add interactive motion previews and native asset bindings ([9040642](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/904064252a133ffb26ebe7ad8333c7331d333744))

# [3.0.0](https://github.com/asifnawaz/skia-motion-agentic-cli/compare/v2.1.0...v3.0.0) (2026-11-18)


### Features

* ship a standalone React Native and Expo runtime ([c365786](https://github.com/asifnawaz/skia-motion-agentic-cli/commit/c36578626ee4018333ca7bbc2d9697eab391b7a1))


### BREAKING CHANGES

* New machine exports import
`skia-motion-runtime/machine`. Install the matching app runtime release
before regenerating machine components. Existing `.skmotion` files
work with the standalone player.

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
