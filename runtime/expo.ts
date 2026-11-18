import { Asset } from 'expo-asset';
import { File } from 'expo-file-system';
import { useMotionAsset, type MotionAssetOptions } from './useMotionAsset';

/** Read a .skmotion from Expo's Metro asset registry in a development or release build. */
export function useExpoMotionAsset(moduleId: number | null | undefined, options?: MotionAssetOptions) {
  return useMotionAsset(moduleId == null ? null : {
    key: `expo-module:${moduleId}`,
    async read(signal) {
      const asset = await Asset.fromModule(moduleId).downloadAsync();
      if (signal.aborted) throw new Error('Motion asset load cancelled');
      if (!asset.localUri) throw new Error('Expo did not produce a local motion file');
      return new File(asset.localUri).text();
    },
  }, options);
}
