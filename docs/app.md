# Shipping motion to a React Native or Expo app

## Packed motion and Skia Canvas

For a self-contained HUD, reward, gesture response or character, author `.motion.json` and
ship the packed `.skmotion`. Check the actual tool version and available commands before deciding
that a capability is missing.

```sh
skac --version
skac asset
skac asset guide format
skac asset guide playback
npm ls skia-motion-runtime --depth=0
```

| Runtime entry point | Use it when |
| --- | --- |
| `MotionPlayer` | The asset's state machine owns transitions, markers, audio cues and semantic tap regions. The player fits a measured React Native view. |
| `MotionPicture` | Your app already owns a Skia `Canvas` and wants a named clip at a specific time. Provide `width`, `height` and a shared `timeMs`. Drawing starts without a separate player view's layout pass. Supply optional text overrides with `text={{ xpLabel: label }}`. |
| `drawMotionClip` | Your worklet already owns the `SkCanvas` and needs to draw the named clip at an exact time or draw order. |

In Expo, add `skmotion` to Metro's `resolver.assetExts`. Load the bundled asset via
`useExpoMotionAsset(require('./reward-counter.skmotion'))` from `skia-motion-runtime/expo`
and use the result when its status is `ready`. For a legacy JSON pack loaded by another
React Native asset loader, pass UTF-8 text. When `skac asset` lists `--format=binary`, a matching
runtime can load the file as bytes. See `skac asset guide binary`.

### Count up with real text

```sh
skac asset sample reward-counter
skac asset pack reward-counter.motion.json
skac asset preview reward-counter.skmotion
```

The sample binds its text node to the `xpLabel` string and pulses when the `land` trigger fires.
Format the count in the host and send it to the same text node. A Reanimated reaction can
call `setOnUI` from the UI thread each time the rounded integer changes.

```tsx
import { useState } from 'react';
import { Button } from 'react-native';
import { useAnimatedReaction, useSharedValue, withTiming } from 'react-native-reanimated';
import { MotionPlayer, type MotionPlayerHandle } from 'skia-motion-runtime';

export function RewardCounter({ source }: { source: string }) {
  const [player, setPlayer] = useState<MotionPlayerHandle | null>(null);
  const points = useSharedValue(0);
  const write = player?.setOnUI;

  useAnimatedReaction(
    () => Math.round(points.value),
    (current, previous) => {
      if (current !== previous) write?.('xpLabel', `+${current} XP`);
    },
    [write],
  );

  return (
    <>
      <MotionPlayer ref={setPlayer} source={source} />
      <Button
        title="Count XP"
        disabled={player === null}
        onPress={() => {
          points.value = 0;
          points.value = withTiming(42, { duration: 600 }, (finished) => {
            if (finished) write?.('land', true);
          });
        }}
      />
    </>
  );
}
```

For a skip button, cancel the host animation, set the final label with `setValues`, and
fire `land`. Generate typed bindings with `skac asset types reward-counter.skmotion`.

### Text limits and fallback

- `fontSize` is 1–512 artboard points. `maxLines` is 1–16 and defaults to one.
- Add `"fontFeatures": [{ "name": "tnum", "value": 1 }]` to a text node for equal digit
  advances in a supporting font such as Allo Regular. The list accepts up to 16 distinct
  four-letter or digit tags with integer values from 0 to 65,535. Install a runtime that supports
  the field before shipping assets that use it.
- A text node with `"roll": { "progress": "<channel>", "from": "<string value>" }` rolls its
  number from the `from` value to its own value as the channel runs from 0 to 1: each digit
  place turns in its own clipped column, rightmost fastest, in the value's own digits (Latin,
  Arabic-Indic, Extended Arabic-Indic and others). Set both strings, then fire the trigger whose
  clip runs the channel. The value eases out unless `"ease": "linear"`, and a place turning faster
  than 30 times a second draws as a vertical blur (`ImageFilter.MakeBlur` in a layer). `skac asset
  guide roll` has the details. Install a runtime that knows `roll` before shipping assets that use it.
- A group with `"row": { "gap": 4, "align": "center", "plate": { ... } }` places its texts and
  images side by side by their ink, each on the row's optical centre line, over a plate sized for
  the widest value (`skac asset guide row`). Rows need a runtime that knows `row`. The runtime
  measures the text with `SkParagraph.extendedVisit` (react-native-skia 3.10.2 or later); on older
  react-native-skia and on React Native Web it falls back to the text's advances and cap height,
  which places the row a few points from what `asset check` measures (it warns `row-approx`).
- The 1 MiB packed budget covers the entire file, including images, audio, fonts and data.
  `asset resource` accepts up to 786,400 raw bytes per font or audio input. Base64 expands
  raw bytes by roughly one third in JSON packs. The default Allo Regular is 96,216 raw bytes.
  Embed a family with the glyphs you need for each script.

When `skac asset` lists `--text-layout`, use it to shape sample values with the packed fonts
and find paragraphs that exceed `maxLines`. Include the longest labels and representative
localized values in the command trace.

```sh
skac asset check reward-counter.skmotion --text-layout --size=360x640 --trace=0,420 \
  --commands 'xpLabel="+1,250 XP gained today"@0.42'
```

Read `textLayout` and `warnings` even when `ok` is true. Each `text-overflow` warning identifies
the node, value, first sample time, authored width, and line count. `text-layout-unavailable`
reports platform fonts or missing glyph coverage. The viewport is recorded for the replay.
Text width and font size stay in artboard units as the whole asset scales. The check covers
paragraph layout for the sampled strings. Verify masks, platform font fallback, and host-applied
layout or text scaling in the app.

## Reuse the app’s fonts

Declare a named slot such as `"fontSlots": { "Counter": {} }` on the asset. A text node
selects it with `"fonts": ["Counter"]`. If you declare a slot on a bundle, individual artboards
can use it or provide their own slot declarations. An optional `{"fallback":"EmbeddedName"}`
uses that entry from the asset’s `fonts` map when the host supplies no binding. A slot with
neither draws in the platform’s default face, and the runtime warns once in development naming it;
a motion asset never takes a screen down over a font.

```sh
skac asset pack scoreboard.motion.json --format=binary --fonts=host
skac asset check scoreboard.skmotion --text-layout --font=Counter=./fonts/Counter.ttf
skac asset preview scoreboard.skmotion --font=Counter=./fonts/Counter.ttf
```

Load each Skia typeface in your app’s shared font setup and pass it to asset preparation once
it is ready. The loader borrows the face. Keep it available while prepared motions use it.
The same typeface can serve any number of assets. Use `loadMotionAsset`, `preloadMotionAsset`,
or `useMotionAsset` for the same options outside the Expo adapter.

```tsx
import type { SkTypeface } from 'react-native-skia';
import { MotionPlayer } from 'skia-motion-runtime';
import { useExpoMotionAsset } from 'skia-motion-runtime/expo';

export function Scoreboard({ counter }: { counter: SkTypeface | null }) {
  const motion = useExpoMotionAsset(
    counter ? require('./scoreboard.skmotion') : null,
    counter ? { fontSlots: { Counter: counter } } : undefined,
  );
  return motion.status === 'ready' ? <MotionPlayer source={motion.asset} /> : null;
}
```

For host-only packs, give every text node an explicit slot or the platform font with
`fonts: []`. Normal packing preserves embedded fallbacks. The pack result reports
`sizeBreakdown` for scene data, images, fonts, and audio. Pass the app’s actual font files to
preview or text QA so glyph coverage, tabular digits, and line fit match the app’s choices.
The offline HTML contains its preview fonts separately from the original packed asset.

To edit an existing asset, run `skac asset unpack scoreboard.skmotion --out=scoreboard.edit.motion.json`,
edit the scene, and pack the recovered source to a new output. Host fonts remain app assets.
Use a CLI and runtime that support font slots before shipping the new declaration.

## Export a custom Skia drawing as TypeScript

The video and the generated app component run one `draw()`. `skac <Name> --export <dir>`
writes the checked scene into the app as `<dir>/<Name>.tsx`.

## When

Use `add <Name> --draw` for the TypeScript export workflow. The exporter requires a draw file and a worklet-compatible rig.

## Steps

```bash
skac add Pip --draw          # src/Pip.rig.ts, src/Pip.draw.ts, src/Pip.tsx (the Remotion composition)
skac Pip --check             # the first check is a draft: improve the two weakest beats it names, then check again
skac Pip --render
skac Pip --export ../app/src/motion
```

The rig exports `type Channels = ReturnType<typeof rig>['channels']` and starts with `'worklet'`. The drawing is imperative Skia and reads only `ch` and `size`:

```ts
export function draw(canvas: SkCanvas, ch: Channels, size: { width: number; height: number }) {
  'worklet';
  const p = Skia.Paint(); p.setColor(Skia.Color('#F6C453'));
  canvas.drawCircle(size.width / 2, size.height / 2 + ch.bob, 70, p);
}
```

Neither file imports Reanimated, React or Remotion.

`--export` refuses with a hint if `src/<Name>.draw.ts` is missing, if any top-level function in the rig or draw file (`rig()`, `draw()` and their helpers) does not start with `'worklet'`, or if those files or the engine files they import bring in React, Reanimated or Remotion. The same check applies to the exported functions of the engine files it takes from (`motion.ts`, `face.ts`, `moves.ts`, `points.ts`, `paths.ts`, a lib's `.worklet.ts`); a non-exported helper in an engine file is not checked. It refuses a scene whose last `--check` was only the draft, or came before the latest change, then runs `--check` and refuses with its failures if not ok. Imports are read with TypeScript's parser; a relative `import()` or `require()` is refused.

**One file.** It writes exactly `<dir>/<Name>.tsx`: the component (`templates/app/component.tsx.tmpl`), the rig, the draw, and only the top-level declarations of the engine files the scene reaches, found by following identifiers through the import graph. A scene that uses `bell` from `motion.ts` carries `bell` and what `bell` uses, not the rest of the file. A top-level name two files share is renamed `<name>_<file>` (for example `clamp_motion`) and its references are rewritten; the scene's own names keep theirs. A library's code (onetake's `.worklet.ts`) keeps its header and `Required Notice:` line above it, and the file then starts with `// @ts-nocheck` because that code is generated from untyped JavaScript. After bundling, the worklet check runs again on the bundled file. The first line is a `// skac export:` header naming the sources; a later export overwrites only a file with that header, and `--force` overwrites others. An engine file may hold only declarations and imports (a top-level statement that runs code is refused). Edit the project's source, never the copy.

## In the app (three lines)

The import, the ref, the component and the trigger, here inside a pressable:

```tsx
import { useRef } from 'react';
import { Pressable } from 'react-native';
import { Pip, type PipHandle } from './motion/Pip'; // ../app/src/motion/Pip.tsx, the one exported file

export function PipButton({ motionAllowed }: { motionAllowed: boolean }) {
  const pip = useRef<PipHandle>(null);
  return (
    <Pressable onPress={() => pip.current?.fire('tap')}>
      <Pip ref={pip} width={200} height={200} live={motionAllowed} />
    </Pressable>
  );
}
```

- `fire(name)` adds `{ name, at }` to the rig's events on the UI thread, at that frame's time; the last 8 are kept. Name them as in `meta.events`.
- `live` (default true) advances time, and changing it pauses or resumes at any point. When false the drawing freezes where it was: pass your own reduced-motion and off-screen gate. The component never reads reduced motion itself.
- One `<Canvas>` per component. Loops need nothing special: `rig()` is a function of absolute time.
- The app needs `react-native-skia` 3 or later, React 19, Reanimated 4, and Worklets 0.7 or later.
- The Skia version check follows direct ESM Skia imports and npm aliases. Other wrappers export with a warning.

## Not covered yet

Images and text inside `draw()`. Scenes whose drawing is JSX only (no codegen from JSX). Playing a scene from a given time (it always starts at 0).
