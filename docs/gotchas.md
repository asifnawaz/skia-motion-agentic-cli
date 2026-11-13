# Gotchas

Each of these builds clean and looks wrong, or fails without saying why.

## Colours look shifted

Skia's web canvas asks the browser for a display-p3 drawing buffer, and every colour
shifts. Put this block at the top of each composition file, before anything draws:

```ts
if (typeof window !== 'undefined') {
  for (const ctor of [window.WebGLRenderingContext, (window as any).WebGL2RenderingContext]) {
    if (ctor) Object.defineProperty(ctor.prototype, 'drawingBufferColorSpace', { configurable: true, get: () => 'srgb', set: () => undefined });
  }
}
```

`create` and `add` already write it. The block must run before the first Skia draw: if you use
`src/motion/clock.remotion.ts`, which carries the same block, make `import './motion/clock.remotion';`
the composition's first import. An import above it that draws runs first, and its colours shift.

## White frames

A lost GL context renders blank white frames, and the render still succeeds. The CLI
passes `--gl=angle-egl` by default to avoid it (set `gl` or `SKAC_GL`; `swangle` works without a GPU). `compare` counts them in `blank_frames`; anything
above 0 means the render failed. If you call Remotion yourself, pass the same flag.
`doctor` reports whether the headless browser and GL work.

## The `react-native` alias

Skia's web build imports `react-native`. `remotion.config.ts` aliases `react-native$` to
`react-native-web`. Without it the bundle fails to resolve. Keep the package and the alias.

## LoadSkia before registerRoot

Skia's wasm must load before anything draws. `src/index.ts` awaits `LoadSkia()`, then
imports the Root and calls `registerRoot`. Do not import compositions at the top of
`index.ts`; they would run before the wasm is ready.

## Stills come from one render

`--screenshot --at=...` renders all the times in one pass. Ask for every time you need at
once: one bundle, not one per still.

## Frames must be deterministic

Remotion renders frames in any order, on several workers.
- No `Date.now()` and no `Math.random()`. Derive everything from `useCurrentFrame()`.
- Springs and other stepped physics run from frame 0 every time, or use a closed form of
  time. A spring that remembers the last frame breaks when a worker starts at frame 90.
- Events arrive as the `events` prop, `[{name, at}]` with `at` in seconds. Compare `t` with
  `event.at`; keep no state. With no `--commands`, the starter's `Character` uses `meta.events`
  (a tap at 4.0 s), and so does a composition from `add`. `--check`, `--stats` and `--story` fall
  back to `meta.events` too, so the render and the checks see the same events.
