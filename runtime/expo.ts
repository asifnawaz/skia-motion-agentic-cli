import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { MAX_ASSET_BYTES } from './asset';
import { preloadMotionAssets, useMotionAsset, type MotionAssetOptions, type MotionAssetSource } from './useMotionAsset';

function expoSource(moduleId: number): MotionAssetSource {
  return {
    key: `expo-module:${moduleId}`,
    async read(signal) {
      const asset = await Asset.fromModule(moduleId).downloadAsync();
      if (signal.aborted) throw new Error('Motion asset load cancelled');
      if (!asset.localUri) throw new Error('Expo did not produce a local motion file');
      const file = new File(asset.localUri);
      if (file.size > MAX_ASSET_BYTES) throw new Error('Motion asset exceeds 1 MiB');
      return file.bytes();
    },
  };
}

/** Read a .skmotion from Expo's Metro asset registry in a development or release build. */
export function useExpoMotionAsset(moduleId: number | null | undefined, options?: MotionAssetOptions) {
  return useMotionAsset(moduleId == null ? null : expoSource(moduleId), options);
}

/**
 * Prepare bundled .skmotion files before their screen mounts, e.g.
 * `const { release } = preloadExpoMotionAssets([require('./reward.skmotion')])`.
 * useExpoMotionAsset with the same module and options is then ready on its first render.
 * Call release when the files are no longer about to be shown.
 */
export function preloadExpoMotionAssets(moduleIds: readonly number[], options?: MotionAssetOptions) {
  return preloadMotionAssets(moduleIds.map(expoSource), options);
}
