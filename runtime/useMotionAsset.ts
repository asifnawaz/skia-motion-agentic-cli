import { useEffect, useMemo, useState } from 'react';
import { preloadMotionAsset, type LoadedMotionAsset, type MotionPrepareOptions } from './asset-load';
import type { MotionAssetData } from './asset-binary';

export type MotionAssetSource = MotionAssetData | { uri: string } | {
  /** Stable identity for a custom loader. Change it when the source changes. */
  key: string;
  read: (signal: AbortSignal) => Promise<MotionAssetData>;
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
  /** Set once prepared, so a player mounted after a preload is ready on its first render. */
  asset?: LoadedMotionAsset;
};

// Cache prepared resources while subscribers own them. Each player creates its own machine snapshot.
const cache = new Map<string, CacheEntry>();
const slotIds = new WeakMap<object, number>();
const byteIds = new WeakMap<Uint8Array, number>();
let nextSlotId = 0;
let nextByteId = 0;
const idle = { status: 'idle', asset: null, error: null } as const;
const loading = { status: 'loading', asset: null, error: null } as const;

function slotKey(slots: Readonly<Record<string, object>> | undefined) {
  return Object.keys(slots ?? {}).sort().map((name) => {
    const resource = slots![name]!;
    let id = slotIds.get(resource);
    if (id === undefined) {
      id = nextSlotId++;
      slotIds.set(resource, id);
    }
    return [name, id];
  });
}

async function readSource(source: MotionAssetSource, signal: AbortSignal) {
  if (typeof source === 'string' || source instanceof Uint8Array) return source;
  if ('read' in source) return source.read(signal);
  const response = await fetch(source.uri, { signal });
  if (!response.ok) throw new Error(`Unable to load motion asset (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function byteId(bytes: Uint8Array) {
  let id = byteIds.get(bytes);
  if (id === undefined) {
    id = nextByteId++;
    byteIds.set(bytes, id);
  }
  return id;
}

function retain(key: string, source: MotionAssetSource, options: MotionAssetOptions) {
  let entry = cache.get(key);
  if (!entry) {
    const controller = new AbortController();
    const signal = controller.signal;
    const promise = Promise.resolve().then(async () => {
      if (signal.aborted) throw new Error('Motion asset load cancelled');
      const data = await readSource(source, signal);
      if (signal.aborted) throw new Error('Motion asset load cancelled');
      return preloadMotionAsset(data, options);
    });
    entry = { promise, controller, users: 0 };
    const created = entry;
    cache.set(key, created);
    promise.then((asset) => { created.asset = asset; }, () => {
      if (cache.get(key) === created) cache.delete(key);
    });
  }
  entry.users++;
  return entry;
}

function release(key: string, entry: CacheEntry) {
  if (--entry.users > 0) return;
  if (cache.get(key) === entry) cache.delete(key);
  entry.controller.abort();
}

function sourceKey(source: MotionAssetSource, options: MotionAssetOptions) {
  const { uploadImages = false, artboard, imageSlots, fontSlots, palette } = options;
  const kind = typeof source === 'string' ? 'text' : source instanceof Uint8Array ? 'bytes' : 'uri' in source ? 'uri' : 'custom';
  const id = typeof source === 'string' ? source
    : source instanceof Uint8Array ? byteId(source) : 'uri' in source ? source.uri : source.key;
  return JSON.stringify([
    kind, id, uploadImages, artboard, slotKey(imageSlots), slotKey(fontSlots),
    Object.keys(palette ?? {}).sort().map((name) => [name, palette![name]]),
  ]);
}

/**
 * Load and prepare files before the screen that plays them mounts. Each file stays in the shared cache
 * that useMotionAsset and useExpoMotionAsset read, under the same source and options, until the returned
 * release runs, so a player mounted meanwhile is ready on its first render. Release when the files are no
 * longer about to be shown: prepared images and textures stay in memory while retained.
 */
export function preloadMotionAssets(
  sources: readonly MotionAssetSource[], options: MotionAssetOptions = {},
): { ready: Promise<LoadedMotionAsset[]>; release: () => void } {
  const held = sources.map((source) => {
    const key = sourceKey(source, options);
    return { key, entry: retain(key, source, options) };
  });
  let released = false;
  return {
    ready: Promise.all(held.map(({ entry }) => entry.promise)),
    release() {
      if (released) return;
      released = true;
      for (const { key, entry } of held) release(key, entry);
    },
  };
}

/** Asynchronously load and share an asset. For Expo module IDs use the /expo entry point. */
export function useMotionAsset(source?: MotionAssetSource | null, options: MotionAssetOptions = {}): MotionAssetResult {
  const { uploadImages = false, artboard, imageSlots, fontSlots, palette } = options;
  const kind = source == null ? undefined : typeof source === 'string' ? 'text'
    : source instanceof Uint8Array ? 'bytes' : 'uri' in source ? 'uri' : 'custom';
  const id = source == null || typeof source === 'string' ? source
    : source instanceof Uint8Array ? byteId(source) : 'uri' in source ? source.uri : source.key;
  const key = useMemo(() => source == null ? undefined : sourceKey(source, options),
    // The key reads the source's kind and identity and these options.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, id, uploadImages, artboard, imageSlots, fontSlots, palette]);
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
      release(key, entry);
    };
    // The key includes the source identity and options. Custom loaders are retained for that identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (key === undefined) return idle;
  if (state?.key === key) return state.result;
  const prepared = cache.get(key)?.asset;
  return prepared ? { status: 'ready', asset: prepared, error: null } : loading;
}
