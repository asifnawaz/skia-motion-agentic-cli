---
name: skia-motion-agentic-cli
description: Author, validate, preview, and play portable .skmotion assets in React Native and Expo with Skia v3. Use skac for interactive game HUDs, characters, rewards, onboarding, or QA of existing .skmotion files.
---

# skia-motion-agentic-cli

For app motion, start with an editable `.motion.json` scene, ship a packed `.skmotion` file, and play it with `MotionPlayer` from `skia-motion-runtime`. When given a `.skmotion` file, check and preview that file directly. Use the TypeScript workflow below only for requested video work or a custom Skia drawing.

Check `skac --version`, `skac asset`, `skac asset guide` and the app's installed `skia-motion-runtime` version before judging feature availability. A local build can have commands absent from the npm release. Read the guide returned by the installed CLI and test the packed file.

## Packed motion for mobile apps

1. Read `skac asset guide workflow` and `skac asset guide format`. For new artwork, start from `skac asset sample versus-hud` or `skac asset sample sprout` and edit the resulting `.motion.json`. Define app inputs and test their normal, interrupted, and repeated transitions with `skac asset trace`.
2. After editing, run `skac asset check scene.motion.json` and `skac asset pack scene.motion.json`. For both new and supplied assets, run `skac asset check scene.skmotion` on the packed file. Skac returns JSON. Read `ok`, and inspect `error` and `hint` on failure.
3. Run `skac asset preview scene.skmotion` and open the returned HTML. Try the inputs, time scrubber, narrow viewport, and reduced motion. When regenerating the same file, use `--force`. On older CLI builds, `skac asset` lists available commands. Use `skac asset frame scene.skmotion --trace=250` for a scripted SVG still if browser preview is unavailable.
4. Use the standalone runtime with `react-native-skia` 3. For Expo, register `skmotion` in Metro and use `useExpoMotionAsset(require('./scene.skmotion'))` from `skia-motion-runtime/expo`. Pass the ready result's `asset` to `MotionPlayer` for state machines. Use `MotionPicture` for a named clip in an existing Skia Canvas at known dimensions and shared time. It draws without waiting for a separate player view to measure. Read `skac asset guide playback` and `skac docs app`.
5. Run `skac asset guide images` for embedded art and image slots. Run `skac asset guide playback` for shared-value controls and clips inside an existing Canvas. For bundles, pass `--artboard` when checking or previewing a named board.

6. For counters, bind a text node to a string machine value. Format the integer in app code and call the mounted handle's `setOnUI` from a worklet when it changes. Start from `asset sample reward-counter` when listed. For text QA, read `asset guide text` when listed. Use `asset check scene.skmotion --text-layout` on builds that list the flag. Supply representative strings with `--commands` and `--trace`. Read both `text-overflow` and `text-layout-unavailable` in the warnings. Allo supports tabular digits when the runtime accepts `fontFeatures: [{ "name": "tnum", "value": 1 }]`. Test system font fallback and host scaling on device.
7. When upgrading existing packed files, follow `skac asset guide migrate` if listed. Use `skac asset guide binary` and `asset unpack` on builds that list them. Upgrade the app runtime before sending it binary packs.
8. When the app already owns its fonts, read `skac asset guide font-slots` if listed. Declare slots, set each custom text node’s `fonts` to the slot names, and pass already-loaded `SkTypeface` instances to the runtime’s `fontSlots` option. Pack with `--fonts=host` to omit embedded fallbacks. Use repeatable `--font=slot=path.ttf` for offline preview and `asset check --text-layout`. Read `sizeBreakdown.fonts` in the pack result. For edits to a packed asset, unpack it to `.motion.json`, edit, and pack a new output. Keep host font files in the app.
9. On device, the player pauses only when the app goes to the background (iOS 'inactive' sheets keep it playing, as Android does); pass `live` to pause it yourself. A stalled frame delays motion instead of skipping it. Export each painting at its largest drawn size times device density: art drawn smaller is mip-filtered, so one export serves every screen and the app needs no per-file pixel caps. Bound text, rows and rolling numbers are laid out once per distinct string, so a value that changes every frame (a millisecond timer) costs a layout every frame. Read `skac asset guide playback` and `skac asset guide images`.
10. Before shipping a file, run `skac asset cost <file>` and read `objectsPerFrame` (aim for 1 to 3), `byKind`, `firstFrameMs` and `images.withMipsBytes`. Compare a changed file with its last version on the same machine. The times come from a CPU rasteriser: compare them between files and versions, never against a phone's frame budget. Read `skac asset guide performance`.

## Custom Skia drawings and video

Use `skac docs workflow` for rig authoring and `skac docs motion/skill` for motion and drawing guidance. Define the beats in the rig and honor any supplied scene spec. Use `--story`, `--stats`, and `--check` to verify the beats and diagnose failures. For video, render via Remotion with `skac <Name> --render` and inspect key frames with `--screenshot`. For a custom app component, scaffold with `skac add <Name> --draw` and export the checked component with `skac <Name> --export <app-dir>`. See `skac docs app` for Skia v3 setup.
