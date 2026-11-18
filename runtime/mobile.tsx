import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { ForwardedRef, ReactElement, RefAttributes } from 'react';
import { AppState, Pressable, StyleSheet, View, type LayoutChangeEvent, type ViewProps } from 'react-native';
import { Canvas, Picture, Skia, createPicture, type SkCanvas } from 'react-native-skia';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { assetMarkerEvents, type AssetMarkerEvent, type AssetSemantic } from './asset';
import { drawAsset, type AssetImages, type DrawableAsset } from './asset-draw';
import { loadMotionAsset, type LoadedMotionAsset } from './asset-load';
import { fitAsset, type AssetLayoutOptions } from './asset-layout';
import { useMachine, type MachineHandle, type MachineInputs, type MachineValues } from './useMachine';
import type { Machine, Pose, StateEntry } from '../templates/motion/machine';

export { parseAsset, parseAssetFile, selectArtboard, type MotionAsset, type MotionAssetFile, type AssetMarkerEvent } from './asset';

export { loadMotionAsset, preloadMotionAsset, type LoadedMotionAsset, type MotionPrepareOptions } from './asset-load';
export { useMotionAsset, type MotionAssetOptions, type MotionAssetSource, type MotionAssetResult } from './useMotionAsset';
export type { AssetFit, AssetAnchor } from './asset-layout';

export type MotionBindings = { values: NonNullable<Machine['values']>; markers: string };
export type MotionAudioCue = { name: string; source: string; marker: AssetMarkerEvent };
export type MotionSharedNumbers = Readonly<Record<string, SharedValue<number>>>;
type BoundMachine<B extends MotionBindings> = Omit<Machine, 'values'> & { values: B['values'] };
type BoundValues<B extends MotionBindings> = MachineValues<BoundMachine<B>>;

export type MotionPlayerHandle<B extends MotionBindings = MotionBindings> = Pick<
  MachineHandle<BoundMachine<B>>, 'set' | 'setValues' | 'fire' | 'setOnUI' | 'readOnUI'
>;

export type MotionPlayerProps<B extends MotionBindings = MotionBindings> = Pick<ViewProps,
  'style' | 'testID' | 'accessible' | 'accessibilityRole' | 'accessibilityLabel' |
  'accessibilityHint' | 'accessibilityValue' | 'accessibilityState' |
  'accessibilityActions' | 'onAccessibilityAction'
> & AssetLayoutOptions & {
  source: string | LoadedMotionAsset;
  artboard?: string;
  width?: number;
  height?: number;
  live?: boolean;
  reduced?: boolean;
  /** Cap passive animation updates. Host writes still take effect on the next display frame. */
  frameRate?: number;
  /** Author-declared clocks in milliseconds. Layers use time since state entry. */
  clocks?: MotionSharedNumbers;
  /** Channel overrides sampled on the UI thread when drawing. */
  channels?: MotionSharedNumbers;
  initialValues?: MachineInputs<BoundMachine<B>>;
  observeValues?: readonly Extract<keyof BoundValues<B>, string>[];
  onValuesChange?: (values: BoundValues<B>) => void;
  onMarker?: (marker: AssetMarkerEvent & { name: B['markers'] }) => void;
  onAudio?: (cue: MotionAudioCue) => void;
  semantics?: boolean;
};

type LoadedProps = Omit<MotionPlayerProps, 'source'> & { loaded: LoadedMotionAsset; playerRef: ForwardedRef<MotionPlayerHandle> };

function readChannels(pose: Pose, channels?: MotionSharedNumbers) {
  'worklet';
  if (!channels) return pose.channels;
  const values = { ...pose.channels };
  for (const [name, shared] of Object.entries(channels)) {
    const value = shared.value;
    if (Number.isFinite(value)) values[name] = value;
  }
  return values;
}

function AssetPicture({ drawing, images, pose, snapshot, readOnUI, width, height, layout, channels }: {
  drawing: DrawableAsset;
  images: AssetImages;
  pose: SharedValue<Pose>;
  snapshot?: MachineHandle['snapshot'];
  readOnUI: MachineHandle['readOnUI'];
  width: number;
  height: number;
  layout: AssetLayoutOptions;
  channels?: MotionSharedNumbers;
}) {
  const picture = useDerivedValue(() => {
    // The mapper subscribes to captured shared values, and readOnUI hides its snapshot.
    void snapshot?.value;
    const values: Record<string, string> = {};
    for (const name of drawing.textBindings ?? []) {
      const value = readOnUI(name);
      if (typeof value === 'string') values[name] = value;
    }
    return createPicture(
      (canvas) => drawAsset(canvas, drawing, readChannels(pose.value, channels), width, height, images, values, layout),
      Skia.XYWHRect(0, 0, width, height),
    );
  });
  return <Picture picture={picture} />;
}

function LoadedPlayer({
  loaded, playerRef, width, height, live, reduced, frameRate, clocks, channels, fit, alignment, style, onMarker, onAudio,
  initialValues, observeValues, onValuesChange, semantics = true, ...viewProps
}: LoadedProps) {
  const { markers, drawing, images, clips } = loaded;
  for (const name of Object.keys(channels ?? {})) {
    if (!Object.hasOwn(drawing.channels, name)) throw new Error(`Unknown motion channel "${name}"`);
  }
  const layout = useMemo(() => ({ fit, alignment }), [fit, alignment]);
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
  const audioCallback = useRef(onAudio);
  useEffect(() => {
    markerCallback.current = onMarker;
    audioCallback.current = onAudio;
    return () => { markerCallback.current = audioCallback.current = undefined; };
  }, [onMarker, onAudio]);
  const onStateEntries = useCallback((entries: StateEntry[]) => {
    for (const marker of assetMarkerEvents(loaded, entries)) {
      if (marker.audio) {
        const source = loaded.audio?.[marker.audio];
        if (source) audioCallback.current?.({ name: marker.audio, source, marker });
      }
      markerCallback.current?.(marker);
    }
  }, [loaded]);
  const semanticNames = useMemo(() => {
    const names = new Set<string>();
    if (semantics) for (const entry of loaded.semantics ?? []) {
      if (typeof entry.label !== 'string') names.add(entry.label.value);
    }
    return names;
  }, [loaded, semantics]);
  const watched = useMemo(() => [...new Set([...(observeValues ?? []), ...semanticNames])], [observeValues, semanticNames]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const valuesCallback = useRef(onValuesChange);
  useEffect(() => {
    valuesCallback.current = onValuesChange;
    return () => { valuesCallback.current = undefined; };
  }, [onValuesChange]);
  const reportValues = useCallback((values: BoundValues<MotionBindings>) => {
    const labelChanges: Record<string, string> = {};
    const appChanges: BoundValues<MotionBindings> = {};
    for (const [name, value] of Object.entries(values)) {
      if (observeValues?.includes(name)) appChanges[name] = value;
      if (semanticNames.has(name) && typeof value === 'string') labelChanges[name] = value;
    }
    if (Object.keys(labelChanges).length) setLabels((previous) => ({ ...previous, ...labelChanges }));
    if (Object.keys(appChanges).length) valuesCallback.current?.(appChanges);
  }, [observeValues, semanticNames]);
  const machine = useMachine(loaded.machine, clips, {
    live: measured && foreground && (live ?? true),
    reduced,
    frameRate,
    clocks,
    onStateEntries: markers?.length && (onMarker || onAudio) ? onStateEntries : undefined,
    initialValues,
    observeValues: watched,
    onValuesChange: onValuesChange || semanticNames.size ? reportValues : undefined,
  });
  useImperativeHandle(playerRef, () => ({
    set: machine.set, setValues: machine.setValues, fire: machine.fire, setOnUI: machine.setOnUI, readOnUI: machine.readOnUI,
  }), [machine.set, machine.setValues, machine.fire, machine.setOnUI, machine.readOnUI]);
  const hostStyle = StyleSheet.flatten(style);
  const grows = (hostStyle?.flex ?? 0) > 0 || (hostStyle?.flexGrow ?? 0) > 0;
  const hasSize = (width ?? hostStyle?.width) != null || (height ?? hostStyle?.height) != null;
  const defaults: ViewProps['style'] = grows ? undefined : {
    aspectRatio: drawing.artboard.width / drawing.artboard.height,
    ...(hasSize ? {} : { width: '100%' }),
  };
  const explicitSize = {
    ...(width !== undefined && { width }),
    ...(height !== undefined && { height }),
  };
  const entries = measured && semantics ? loaded.semantics ?? [] : [];
  const regions = entries.map((entry) => {
    const input = typeof entry.label === 'string' ? undefined : entry.label.value;
    const value = input === undefined ? entry.label : labels[input] ?? initialValues?.[input] ?? loaded.machine.values?.[input]?.default;
    return <SemanticRegion key={entry.name} entry={entry} label={typeof value === 'string' ? value : ''}
      artboard={drawing.artboard} viewport={viewport} layout={layout} fire={machine.fire} />;
  });
  // Mount the native canvas while the regular View measures its first viewport.
  return (
    <View {...viewProps} style={[defaults, style, explicitSize]} onLayout={onLayout}>
      <Canvas style={StyleSheet.absoluteFill}>
        {measured && <AssetPicture drawing={drawing} images={images} pose={machine.pose} readOnUI={machine.readOnUI}
          snapshot={drawing.textBindings?.length ? machine.snapshot : undefined}
          width={viewport.width} height={viewport.height} layout={layout} channels={channels} />}
      </Canvas>
      {regions}
    </View>
  );
}

function SemanticRegion({ entry, label, artboard, viewport, layout, fire }: {
  entry: AssetSemantic; label: string; artboard: { width: number; height: number };
  viewport: { width: number; height: number }; layout: AssetLayoutOptions; fire: (name: string) => void;
}) {
  const { scale, offsetX, offsetY } = fitAsset(artboard, viewport.width, viewport.height, layout);
  const [x, y, width, height] = entry.bounds;
  const left = Math.max(0, (x + offsetX) * scale);
  const top = Math.max(0, (y + offsetY) * scale);
  const right = Math.min(viewport.width, (x + offsetX + width) * scale);
  const bottom = Math.min(viewport.height, (y + offsetY + height) * scale);
  if (right <= left || bottom <= top || !label) return null;
  const props = {
    accessible: true,
    accessibilityRole: entry.role,
    accessibilityLabel: label,
    style: { position: 'absolute' as const, left, top, width: right - left, height: bottom - top },
  };
  const trigger = entry.trigger;
  return trigger ? <Pressable {...props} onPress={() => fire(trigger)} /> : <View {...props} pointerEvents="none" />;
}

export const MotionPlayer = forwardRef<MotionPlayerHandle, MotionPlayerProps>(function MotionPlayer({ source, artboard, ...props }, ref) {
  // The inner hook owns one machine snapshot per loaded file. An updated file starts at t=0.
  const loaded = useMemo(() => typeof source === 'string' ? loadMotionAsset(source, { artboard }) : source, [source, artboard]);
  return <LoadedPlayer key={loaded.key} loaded={loaded} playerRef={ref} {...props} />;
}) as <B extends MotionBindings = MotionBindings>(props: MotionPlayerProps<B> & RefAttributes<MotionPlayerHandle<B>>) => ReactElement;

export type MotionClipOptions = AssetLayoutOptions & {
  width: number;
  height: number;
  reduced?: boolean;
  channels?: MotionSharedNumbers;
  text?: Readonly<Record<string, string>>;
};

/** Sample one named clip at absolute local time and paint into the supplied Skia canvas. */
export function drawMotionClip(
  canvas: SkCanvas, asset: LoadedMotionAsset, name: string, timeMs: number, options: MotionClipOptions,
): void {
  'worklet';
  if (!Object.hasOwn(asset.clips, name)) throw new Error(`Unknown motion clip "${name}"`);
  const clip = asset.clips[name]!;
  const time = options.reduced ? clip.reducedAt ?? clip.ms
    : Math.max(0, Math.min(clip.ms, Number.isFinite(timeMs) ? timeMs : 0));
  const text: Record<string, string> = {};
  for (const key of asset.drawing.textBindings ?? []) {
    const value = options.text?.[key] ?? asset.machine.values?.[key]?.default;
    if (typeof value === 'string') text[key] = value;
  }
  drawAsset(canvas, asset.drawing, readChannels(clip.play(time), options.channels),
    options.width, options.height, asset.images, text, options);
}

/** Compose a host-controlled clip inside an existing Skia Canvas. */
export function MotionPicture({ asset, clip, timeMs, ...options }: MotionClipOptions & {
  asset: LoadedMotionAsset;
  clip: string;
  timeMs: SharedValue<number>;
}) {
  if (!Object.hasOwn(asset.clips, clip)) throw new Error(`Unknown motion clip "${clip}"`);
  const picture = useDerivedValue(() => createPicture(
    (canvas) => drawMotionClip(canvas, asset, clip, timeMs.value, options),
    Skia.XYWHRect(0, 0, options.width, options.height),
  ));
  return <Picture picture={picture} />;
}
