import type { SkImage } from 'react-native-skia';
import { assetClips, bindAssetPalette, parseDrawableAsset, type MotionAsset } from './asset';
import { resourceDataUri, type MotionAssetData, type ResourceBytes } from './asset-binary';
import { decodeAssetImages, prepareAssetDrawing, rebindAssetMeshShaders, type AssetFontSlots, type AssetImages, type DrawableAsset } from './asset-draw';

let nextAssetKey = 0;

export type LoadedMotionAsset = Readonly<{
  key: number;
  machine: MotionAsset['machine'];
  markers: MotionAsset['markers'];
  drawing: DrawableAsset;
  images: AssetImages;
  clips: ReturnType<typeof assetClips>;
  semantics?: MotionAsset['semantics'];
  audio?: MotionAsset['audio'];
}>;

/** Prepare one file for reuse by independent player instances. Keep the result while those players are mounted. */
export type MotionPrepareOptions = {
  artboard?: string;
  imageSlots?: AssetImages;
  /** Already-loaded Skia typefaces, borrowed for the life of the prepared drawing. */
  fontSlots?: AssetFontSlots;
  palette?: Readonly<Record<string, string>>;
};

export function loadMotionAsset(source: MotionAssetData, { artboard, imageSlots, fontSlots, palette }: MotionPrepareOptions = {}): LoadedMotionAsset {
  const asset = bindAssetPalette(parseDrawableAsset(source, artboard), palette);
  const images = decodeAssetImages(asset, imageSlots);
  let audio: LoadedMotionAsset['audio'];
  if (asset.audio) {
    const uris = new Map<ResourceBytes, string>();
    audio = Object.fromEntries(Object.entries(asset.audio).map(([name, resource]) => [name, resourceDataUri(resource, uris)]));
  }
  return {
    key: nextAssetKey++,
    machine: asset.machine,
    markers: asset.markers,
    drawing: prepareAssetDrawing(asset, images, fontSlots),
    images,
    clips: assetClips(asset),
    semantics: asset.semantics,
    audio,
  };
}

/**
 * Prepare a file before mounting it. Skia versions with asynchronous raster decoding perform
 * that work off the JS thread. Upload is opt-in and can retain textures until the file is released.
 */
export async function preloadMotionAsset(
  source: MotionAssetData | LoadedMotionAsset,
  { uploadImages = false, ...options }: MotionPrepareOptions & { uploadImages?: boolean } = {},
): Promise<LoadedMotionAsset> {
  const loaded = typeof source === 'string' || source instanceof Uint8Array ? loadMotionAsset(source, options) : source;
  const warmed = new Map<SkImage, SkImage>();
  const images: [string, SkImage][] = [];
  let changed = false;
  for (const [name, image] of Object.entries(loaded.images)) {
    let ready = warmed.get(image);
    if (!ready) {
      // Neither method is available at the 3.0 peer dependency floor.
      const preloadable = image as SkImage & { makeRasterImage?: () => Promise<SkImage> };
      ready = await preloadable.makeRasterImage?.() ?? image;
      if (uploadImages) {
        // Uploaded with mip levels: the draw samples them, and a texture made without them (react-native-skia's default) is
        // sampled at full size, so art drawn small aliases. Older versions take no options and ignore it.
        const uploadable = ready as SkImage & { makeTextureImage?: (options?: { mipmapped?: boolean }) => SkImage };
        try {
          ready = uploadable.makeTextureImage?.({ mipmapped: true }) ?? ready;
        } catch {
          // A reduced or unsupported backend can still upload the raster image when drawn.
        }
      }
      warmed.set(image, ready);
    }
    images.push([name, ready]);
    changed ||= ready !== image;
  }
  if (!warmed.size) return loaded;
  const ready = Object.fromEntries(images);
  return { ...loaded, images: ready, drawing: changed ? rebindAssetMeshShaders(loaded.drawing, ready) : loaded.drawing };
}
