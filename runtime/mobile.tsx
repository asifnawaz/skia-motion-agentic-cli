import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ForwardedRef } from 'react';
import { AppState, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import { Canvas, Picture, Skia, createPicture, type SkImage } from 'react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { assetClips, assetMarkerEvents, parseAsset, type MotionAsset, type AssetMarkerEvent } from './asset';
import { decodeAssetImages, drawAsset, prepareAssetDrawing, type AssetImages, type DrawableAsset } from './asset-draw';
import { useMachine, type MachineHandle } from './useMachine';
import type { Pose, StateEntry } from '../templates/motion/machine';

export { parseAsset, type MotionAsset, type AssetMarkerEvent } from './asset';

let nextAssetKey = 0;

export type LoadedMotionAsset = Readonly<{
  key: number;
  machine: MotionAsset['machine'];
  markers: MotionAsset['markers'];
  drawing: DrawableAsset;
  images: AssetImages;
  clips: ReturnType<typeof assetClips>;
}>;

/** Prepare one file for reuse by independent player instances. Keep the result while those players are mounted. */
export function loadMotionAsset(source: string): LoadedMotionAsset {
  const asset = parseAsset(source);
  return {
    key: nextAssetKey++,
    machine: asset.machine,
    markers: asset.markers,
    drawing: prepareAssetDrawing(asset),
    images: decodeAssetImages(asset),
    clips: assetClips(asset),
  };
}

/**
 * Prepare a file before mounting it. Skia versions with asynchronous raster decoding perform
 * that work off the JS thread. Upload is opt-in and can retain textures until the file is released.
 */
export async function preloadMotionAsset(
  source: string | LoadedMotionAsset,
  { uploadImages = false }: { uploadImages?: boolean } = {},
): Promise<LoadedMotionAsset> {
  const loaded = typeof source === 'string' ? loadMotionAsset(source) : source;
  const warmed = new Map<SkImage, SkImage>();
  const images: [string, SkImage][] = [];
  for (const [name, image] of Object.entries(loaded.images)) {
    let ready = warmed.get(image);
    if (!ready) {
      // Neither method is available at the 3.0 peer dependency floor.
      const preloadable = image as SkImage & { makeRasterImage?: () => Promise<SkImage> };
      ready = await preloadable.makeRasterImage?.() ?? image;
      if (uploadImages) {
        const uploadable = ready as SkImage & { makeTextureImage?: () => SkImage };
        try {
          ready = uploadable.makeTextureImage?.() ?? ready;
        } catch {
          // A reduced or unsupported backend can still upload the raster image when drawn.
        }
      }
      warmed.set(image, ready);
    }
    images.push([name, ready]);
  }
  return warmed.size ? { ...loaded, images: Object.fromEntries(images) } : loaded;
}

export type MotionPlayerHandle = Pick<MachineHandle, 'set' | 'fire' | 'setOnUI' | 'readOnUI'>;

export type MotionPlayerProps = {
  source: string | LoadedMotionAsset;
  width?: number;
  height?: number;
  live?: boolean;
  reduced?: boolean;
  style?: StyleProp<ViewStyle>;
  onMarker?: (marker: AssetMarkerEvent) => void;
};

type LoadedProps = Omit<MotionPlayerProps, 'source'> & { loaded: LoadedMotionAsset; playerRef: ForwardedRef<MotionPlayerHandle> };

function AssetPicture({ drawing, images, pose, width, height }: {
  drawing: DrawableAsset;
  images: AssetImages;
  pose: SharedValue<Pose>;
  width: number;
  height: number;
}) {
  const picture = useDerivedValue(() => createPicture(
    (canvas) => drawAsset(canvas, drawing, pose.value.channels, width, height, images),
    Skia.XYWHRect(0, 0, width, height),
  ), [drawing, images, pose, width, height]);
  return <Picture picture={picture} />;
}

function LoadedPlayer({ loaded, playerRef, width, height, live, reduced, style, onMarker }: LoadedProps) {
  const { markers, drawing, images, clips } = loaded;
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const onLayout = useCallback(({ nativeEvent }: LayoutChangeEvent) => {
    const { width, height } = nativeEvent.layout;
    setViewport((current) => current.width === width && current.height === height ? current : { width, height });
  }, []);
  const measured = viewport.width > 0 && viewport.height > 0;
  const [foreground, setForeground] = useState(() => !AppState.currentState || AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  const markerCallback = useRef(onMarker);
  useEffect(() => {
    markerCallback.current = onMarker;
    return () => { markerCallback.current = undefined; };
  }, [onMarker]);
  const onStateEntries = useCallback((entries: StateEntry[]) => {
    for (const marker of assetMarkerEvents(loaded, entries)) markerCallback.current?.(marker);
  }, [loaded]);
  const machine = useMachine(loaded.machine, clips, {
    live: measured && foreground && (live ?? true),
    reduced,
    onStateEntries: markers?.length && onMarker ? onStateEntries : undefined,
  });
  useImperativeHandle(playerRef, () => ({
    set: machine.set, fire: machine.fire, setOnUI: machine.setOnUI, readOnUI: machine.readOnUI,
  }), [machine.set, machine.fire, machine.setOnUI, machine.readOnUI]);
  const hostStyle = StyleSheet.flatten(style);
  const grows = (hostStyle?.flex ?? 0) > 0 || (hostStyle?.flexGrow ?? 0) > 0;
  const hasSize = (width ?? hostStyle?.width) != null || (height ?? hostStyle?.height) != null;
  const defaults: ViewStyle | undefined = grows ? undefined : {
    aspectRatio: drawing.artboard.width / drawing.artboard.height,
    ...(hasSize ? {} : { width: '100%' }),
  };
  const explicitSize = {
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
  };
  // Measure a regular View. Early Skia v3 releases don't report Canvas onLayout on native.
  return (
    <View style={[defaults, style, explicitSize]} onLayout={onLayout}>
      {measured && (
        <Canvas style={StyleSheet.absoluteFill}>
          <AssetPicture drawing={drawing} images={images} pose={machine.pose} width={viewport.width} height={viewport.height} />
        </Canvas>
      )}
    </View>
  );
}

export const MotionPlayer = forwardRef<MotionPlayerHandle, MotionPlayerProps>(function MotionPlayer({ source, ...props }, ref) {
  // The inner hook owns one machine snapshot per loaded file. An updated file starts at t=0.
  const loaded = useMemo(() => typeof source === 'string' ? loadMotionAsset(source) : source, [source]);
  return <LoadedPlayer key={loaded.key} loaded={loaded} playerRef={ref} {...props} />;
});
