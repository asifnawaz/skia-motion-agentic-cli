import { LoadSkia } from '@shopify/react-native-skia/lib/module/web';
import { registerRoot } from 'remotion';

// Skia's wasm must be loaded before anything draws, so load it first, then register the root.
const start = async () => {
  await LoadSkia();
  const { Root } = await import('./Root');
  registerRoot(Root);
};
start();
