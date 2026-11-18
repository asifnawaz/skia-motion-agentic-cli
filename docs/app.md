# Shipping a scene to an app

The video and the generated app component run one `draw()`. `skac <Name> --export <dir>` writes the checked scene into the app as `<dir>/<Name>.tsx`. For a self-contained data asset loaded by the shared player, run `skac asset guide`.

## When

Use `add <Name> --draw` for any scene the app will play. A scene made without `--draw` (its drawing is JSX in `<Name>.tsx`) renders to video as before but cannot be exported.

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
