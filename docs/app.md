# Shipping a scene to an app

The video and the app run one `draw()`. `skac <Name> --export <dir>` writes the checked rig and drawing into the app as a component. No binary or data format: the TypeScript files are the asset.

## When

Use `add <Name> --draw` for any scene the app will play. A scene made without `--draw` (its drawing is JSX in `<Name>.tsx`) renders to video as before but cannot be exported.

## Steps

```bash
skac add Pip --draw          # src/Pip.rig.ts, src/Pip.draw.ts, src/Pip.tsx (the Remotion composition)
skac Pip --check             # until ok
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

`--export` refuses with a hint if `src/<Name>.draw.ts` is missing, if any top-level function in the rig or draw file (`rig()`, `draw()` and their helpers) does not start with `'worklet'`, or if those files or the engine files they import bring in React, Reanimated or Remotion. Functions inside the engine files are not checked; the shipped `motion.ts` and `face.ts` carry the directive where the rig calls them. It then runs `--check` and refuses with its failures if not ok. Imports are read with TypeScript's parser; a relative `import()` or `require()` is refused. It writes `<dir>/<Name>/`: `<Name>.rig.ts`, `<Name>.draw.ts`, `index.tsx`, and the `motion/` engine files the two import (`motion.ts`, `face.ts`), with the import paths rewritten to `./motion/<file>`. Every file starts with a `// skac export:` header naming its source; a later export overwrites only files with that header, and `--force` overwrites others. Edit the project's source, never the copy.

## In the app (three lines)

The import, the ref, the component and the trigger, here inside a pressable:

```tsx
import { useRef } from 'react';
import { Pressable } from 'react-native';
import { Pip, type PipHandle } from './motion/Pip';

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
- Needs `@shopify/react-native-skia` 2 and `react-native-reanimated` 4 (with its peer `react-native-worklets`) in the app.

## Not covered yet

Images and text inside `draw()`. Scenes whose drawing is JSX only (no codegen from JSX). Playing a scene from a given time (it always starts at 0).
