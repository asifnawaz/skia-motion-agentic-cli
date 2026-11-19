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
    promise.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
  }
  entry.users++;
  return entry;
}

/** Asynchronously load and share an asset. For Expo module IDs use the /expo entry point. */
export function useMotionAsset(source?: MotionAssetSource | null, options: MotionAssetOptions = {}): MotionAssetResult {
  const { uploadImages = false, artboard, imageSlots, fontSlots, palette } = options;
  const kind = source == null ? undefined : typeof source === 'string' ? 'text'
    : source instanceof Uint8Array ? 'bytes' : 'uri' in source ? 'uri' : 'custom';
  const id = source == null || typeof source === 'string' ? source
    : source instanceof Uint8Array ? byteId(source) : 'uri' in source ? source.uri : source.key;
  const key = useMemo(() => kind === undefined ? undefined : JSON.stringify([
    kind, id, uploadImages, artboard, slotKey(imageSlots), slotKey(fontSlots),
    Object.keys(palette ?? {}).sort().map((name) => [name, palette![name]]),
  ]), [kind, id, uploadImages, artboard, imageSlots, fontSlots, palette]);
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
