# Running it: Remotion and the app

The same motion code runs in two places. Only the clock differs. (the header of `templates/motion/motion.ts`)

## In Remotion (videos, reels, motion tests)

1. **The sRGB fix comes first.** Skia on the web asks WebGL for a `display-p3` drawing buffer; the video is sRGB, so colours shift. Put this block at the very top of the composition file, before the imports (or import `clock.remotion.ts` first, which carries it):

   ```ts
   if (typeof window !== 'undefined') {
     for (const ctor of [window.WebGLRenderingContext, (window as any).WebGL2RenderingContext]) {
       if (ctor) Object.defineProperty(ctor.prototype, 'drawingBufferColorSpace', { configurable: true, get: () => 'srgb', set: () => undefined });
     }
   }
   ```

2. **Time from the frame:** `const t = useCurrentFrame() / fps * 1000`, or `useClockMs()`. Compute every value during render from `t`. No state between frames.
3. **Draw** inside `<SkiaCanvas width={W} height={H}>` from `@remotion/skia`, inside an `<AbsoluteFill style={{ backgroundColor }}>`, so the page behind the canvas matches.
4. **Register** the composition in `Root.tsx`: `<Composition id="Name" component={Name} width={390} height={867} fps={30} durationInFrames={240} />`. Build at 1× points and render at `--scale=2`.
5. **Render** with skac from the project folder (it runs `remotion render` with `--gl=angle-egl`, which gives headless WebGL, and then `compare`):

   ```bash
   skac <Name> --render --scale 2
   ```

   The mp4 lands in `<out>/<Name>/<Name>.mp4`. For a quick still use `skac <Name> --verify`, and for chosen moments `skac <Name> --screenshot --at=...`.

6. **Check** with `skac compare` (checks). A lost GL context renders white frames; `blank_frames` catches it.

**Copy the templates into the project** from the package's `templates/motion/` (for example into `src/motion/`). Importing them by relative path from outside the project fails: webpack resolves `@shopify/react-native-skia` from the template's own folder, which has no `node_modules`.

Skia notes for Remotion:
- `rotate` is in radians; multiply degrees by `DEG`.
- `Group origin={vec(x, y)}` sets the pivot for its transform.
- `Path path` takes an SVG path string; `Group clip` takes a rect, an rrect or a path.
- `BlurMask blur={2-4}` softens cheeks and shadows; keep it off moving outlines.

## In the app (Reanimated + Skia)

1. **Clock:** `useLoopClock(period, live)` or `useOneShotClock(duration, play, reduced)` from `clock.app.ts`; `live` = visible and not reduced motion (`useLive(visible)`).
2. **Derive, do not re-render:** `const lid = useDerivedValue(() => eyeGeometry(EYE, faceAt(clock.value, CHOREO), -1).lidPath)` and pass `lid` straight to `<Path path={lid} />`. Skia reads shared values on the UI thread.
3. **Worklets:** every function in `motion.ts` and the geometry functions in `liveFace.tsx` carry `'worklet'`. Curves sit at the top of the module.
4. **Pause** when off screen or in the background; with reduced motion the loop sits at frame 0 and one-shots at their final frame.
5. **One Canvas per scene.** Many items in one Canvas; never a Canvas per part.

To ship a scene to an app, use `skac <Name> --export <app-dir>`: it writes the component, `skac docs app`. What is proven: the Remotion path by a rendered composition, and the exported folder by the unit tests (header, file list, import rewrite) and a typecheck against the app's own Skia and Reanimated types. Running it on a device is not proven.
