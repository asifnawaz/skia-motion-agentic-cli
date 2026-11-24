# Skia Motion Runtime

Play interactive `.skmotion` assets in React Native and Expo. A file can contain artwork, animation timelines, state machines, and inputs for game HUDs, characters, rewards, and other app interactions.

## Install

```sh
npm install skia-motion-runtime
```

The app supplies React 19+, React Native 0.79+, `react-native-skia` 3+, Reanimated 4+, and `react-native-worklets` 0.7+. In Expo, use a development build that includes Skia v3.

## React Native

Read a JSON `.skmotion` as UTF-8 text or pass a binary `.skmotion` as a `Uint8Array`. By default the player uses the available width and derives its height from the artboard. Supply `style`, `width`, or `height` to fit a specific layout.

```tsx
import { MotionPlayer, type MotionAssetData } from 'skia-motion-runtime';

export function LessonReward({ source }: { source: MotionAssetData }) {
  return <MotionPlayer source={source} />;
}
```

## Expo

Install the Expo asset loader dependencies in your app.

```sh
npx expo install expo-asset expo-file-system
```

Add `skmotion` to Metro's asset extensions in `metro.config.js`.

```js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('skmotion');
module.exports = config;
```

Load the bundled file with `useExpoMotionAsset` and render the player when it is ready.

```tsx
import { Text } from 'react-native';
import { MotionPlayer } from 'skia-motion-runtime';
import { useExpoMotionAsset } from 'skia-motion-runtime/expo';

export function LessonReward() {
  const result = useExpoMotionAsset(require('./lesson-reward.skmotion'));
  if (result.status === 'error') {
    return <Text accessibilityRole="alert">{result.error.message}</Text>;
  }
  if (result.status !== 'ready') return null;
  return <MotionPlayer source={result.asset} />;
}
```

## Control playback

- Attach a `MotionPlayerHandle` ref to call `set(name, value)`, `setValues(values)`, or `fire(name)` using the asset's named inputs. Handle asset cues with `onMarker` and `onAudio`.
- Call the mounted handle's `setOnUI(name, value)` from a Reanimated worklet. A host-formatted string can update the digits in a bound text node during a count-up.
- For a rolling count, give the text node `roll: { progress, from }`: set the old and new strings with `setValues`, then `fire` the trigger whose clip runs `progress` from 0 to 1. Each digit place turns in its own column.
- Use `live={false}` to pause a mounted player. The player uses system reduced motion by default and accepts a `reduced` override.
- Select a board by name with the `artboard` option when loading a multi-artboard file.
- Prepare a shared file with `loadMotionAsset(text)` or `await preloadMotionAsset(text)`. Each player keeps its own state while sharing prepared artwork and image handles.
- Use `MotionPicture` for a named clip in an existing Skia Canvas at a shared `timeMs`. Provide `width` and `height` to draw without a separate player layout pass. Use `MotionPlayer` when the asset owns transitions and markers.

The text schema supports 1–16 lines and optional OpenType features such as `tnum` for fonts
with tabular digits. Skia can ellipsize overflow. Check representative labels with the CLI's
`asset check --text-layout` before shipping. The entire packed file has a 1 MiB budget
for motion data and embedded resources, including fonts.

For an asset that declares host font slots, supply the app’s loaded Skia typefaces during
preparation, for example `loadMotionAsset(bytes, { fontSlots: { Counter: counterTypeface } })`.
The same options work with `useMotionAsset` and `useExpoMotionAsset`. Keep borrowed faces
available while the prepared file is in use. An embedded fallback is optional and a missing
required slot produces a load error. Run `skac asset guide font-slots` for the authoring recipe.

[Project and examples](https://github.com/asifnawaz/skia-motion-agentic-cli) · [Release notes](https://github.com/asifnawaz/skia-motion-agentic-cli/releases)
