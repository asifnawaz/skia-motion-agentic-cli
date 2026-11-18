---
name: skia-motion-agentic-cli
description: Author, validate, preview, and play portable .skmotion assets in React Native and Expo with Skia v3. Use skac for interactive game HUDs, characters, rewards, onboarding, or QA of existing .skmotion files.
---

# skia-motion-agentic-cli

For app motion, start with an editable `.motion.json` scene, ship a packed `.skmotion` file, and play it with `MotionPlayer` from `skia-motion-runtime`. When given a `.skmotion` file, check and preview that file directly. Use the TypeScript workflow below only for requested video work or a custom Skia drawing.

## Packed motion for mobile apps

1. Read `skac asset guide workflow` and `skac asset guide format`. For new artwork, start from `skac asset sample versus-hud` or `skac asset sample sprout` and edit the resulting `.motion.json`. Define app inputs and test their normal, interrupted, and repeated transitions with `skac asset trace`.
2. After editing, run `skac asset check scene.motion.json` and `skac asset pack scene.motion.json`. For both new and supplied assets, run `skac asset check scene.skmotion` on the packed file. Skac returns JSON. Read `ok`, and inspect `error` and `hint` on failure.
3. Run `skac asset preview scene.skmotion` and open the returned HTML. Try the inputs, time scrubber, narrow viewport, and reduced motion. When regenerating the same file, use `--force`. On older CLI builds, `skac asset` lists available commands. Use `skac asset frame scene.skmotion --trace=250` for a scripted SVG still if browser preview is unavailable.
4. Load the same file in React Native or an Expo development build with `skia-motion-runtime` and `react-native-skia` 3. Pass UTF-8 text or the result of `loadMotionAsset` to `MotionPlayer`. For Expo, add `skmotion` to Metro's `resolver.assetExts` and use `useExpoMotionAsset(require('./scene.skmotion'))` from `skia-motion-runtime/expo`. Pass the ready result's `asset` to the player. Keep app state and user actions in the host. Smoke-test on a device when native visuals or frame timing matter.
5. Run `skac asset guide images` for embedded art and image slots. Run `skac asset guide playback` for shared-value controls and clips inside an existing Canvas. For bundles, pass `--artboard` when checking or previewing a named board.

## Custom Skia drawings and video

Use `skac docs workflow` for rig authoring and `skac docs motion/skill` for motion and drawing guidance. Define the beats in the rig and honor any supplied scene spec. Use `--story`, `--stats`, and `--check` to verify the beats and diagnose failures. For video, render via Remotion with `skac <Name> --render` and inspect key frames with `--screenshot`. For a custom app component, scaffold with `skac add <Name> --draw` and export the checked component with `skac <Name> --export <app-dir>`. See `skac docs app` for Skia v3 setup.
