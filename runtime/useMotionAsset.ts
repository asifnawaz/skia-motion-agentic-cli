import { useEffect, useMemo, useState } from 'react';
import { preloadMotionAsset, type LoadedMotionAsset, type MotionPrepareOptions } from './asset-load';
import type { AssetImages } from './asset-draw';

export type MotionAssetSource = string | { uri: string } | {
  /** Stable identity for a custom loader. Change it when the source changes. */
  key: string;
  read: (signal: AbortSignal) => Promise<string>;
};
export type MotionAssetOptions = MotionPrepareOptions & { uploadImages?: boolean };
type Failure = { status: 'error'; asset: null; error: Error };
export type MotionAssetResult =
  | { status: 'idle' | 'loading'; asset: null; error: null }
  | { status: 'ready'; asset: LoadedMotionAsset; error: null }
  | Failure;

type CacheEntry = {
  promise: Promise<LoadedMotionAsset>;
  controller: AbortController;
  users: number;
};

// Cache prepared resources while subscribers own them. Each player creates its own machine snapshot.
const cache = new Map<string, CacheEntry>();
const imageIds = new WeakMap<object, number>();
let nextImageId = 0;
const idle = { status: 'idle', asset: null, error: null } as const;
const loading = { status: 'loading', asset: null, error: null } as const;

function slotKey(images: AssetImages | undefined) {
  return Object.keys(images ?? {}).sort().map((name) => {
    const image = images![name]!;
    let id = imageIds.get(image);
    if (id === undefined) {
      id = nextImageId++;
      imageIds.set(image, id);
    }
    return [name, id];
  });
}

async function readSource(source: MotionAssetSource, signal: AbortSignal) {
  if (typeof source === 'string') return source;
  if ('read' in source) return source.read(signal);
  const response = await fetch(source.uri, { signal });
  if (!response.ok) throw new Error(`Unable to load motion asset (HTTP ${response.status})`);
  return response.text();
}

function retain(key: string, source: MotionAssetSource, options: MotionAssetOptions) {
  let entry = cache.get(key);
  if (!entry) {
    const controller = new AbortController();
    const signal = controller.signal;
    const promise = Promise.resolve().then(async () => {
      if (signal.aborted) throw new Error('Motion asset load cancelled');
      const text = await readSource(source, signal);
      if (signal.aborted) throw new Error('Motion asset load cancelled');
      return preloadMotionAsset(text, options);
    });
    entry = { promise, controller, users: 0 };
    const created = entry;
    cache.set(key, created);
    promise.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
  }
  entry.users++;
  return entry;
}

/** Asynchronously load and share an asset. For Expo module IDs use the /expo entry point. */
export function useMotionAsset(source?: MotionAssetSource | null, options: MotionAssetOptions = {}): MotionAssetResult {
  const { uploadImages = false, artboard, imageSlots, palette } = options;
  const kind = source == null ? undefined : typeof source === 'string' ? 'text' : 'uri' in source ? 'uri' : 'custom';
  const id = typeof source === 'string' ? source : source == null ? undefined : 'uri' in source ? source.uri : source.key;
  const key = useMemo(() => kind === undefined ? undefined : JSON.stringify([
    kind, id, uploadImages, artboard, slotKey(imageSlots),
    Object.keys(palette ?? {}).sort().map((name) => [name, palette![name]]),
  ]), [kind, id, uploadImages, artboard, imageSlots, palette]);
  const [state, setState] = useState<{ key: string; result: MotionAssetResult }>();
  useEffect(() => {
    setState((previous) => previous?.key === key ? previous : undefined);
    if (key === undefined || source == null) return;
    const entry = retain(key, source, options);
    let active = true;
    entry.promise.then(
      (asset) => { if (active) setState({ key, result: { status: 'ready', asset, error: null } }); },
      (error: unknown) => {
        if (active) setState({ key, result: {
          status: 'error', asset: null, error: error instanceof Error ? error : new Error(String(error)),
        } });
      },
    );
    return () => {
      active = false;
      if (--entry.users === 0) {
        if (cache.get(key) === entry) cache.delete(key);
        entry.controller.abort();
      }
    };
    // The key includes the source identity and options. Custom loaders are retained for that identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (key === undefined) return idle;
  return state?.key === key ? state.result : loading;
}
