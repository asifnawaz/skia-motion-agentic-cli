import { useCallback, useEffect, useRef } from 'react';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import type { LoadedMotionAsset } from './asset-load';
import { decodeBase64 } from './base64';
import type { MotionAudioCue } from './mobile';

const extensions: Record<string, string> = { mpeg: 'mp3', wav: 'wav', mp4: 'm4a', aac: 'aac' };
let sequence = 0;

type Prepared = {
  file: File;
  source: string;
  ready: Promise<AudioPlayer | undefined>;
  active: boolean;
  revision: number;
};

/** Prepare embedded cues and return the callback for MotionPlayer's onAudio prop. */
export function useExpoMotionAudio(
  asset: LoadedMotionAsset | null | undefined,
  { enabled = true, onError }: { enabled?: boolean; onError?: (error: unknown) => void } = {},
) {
  const sounds = useRef(new Map<string, Prepared>());
  const onErrorRef = useRef(onError);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  useEffect(() => {
    if (!enabled || !asset?.audio) return;
    const loaded = new Map<string, Prepared>();
    sounds.current = loaded;
    const id = `${Date.now()}-${sequence++}`;
    for (const [name, source] of Object.entries(asset.audio)) {
      const header = /^data:audio\/(mpeg|wav|mp4|aac);base64,/.exec(source);
      if (!header) continue;
      const file = new File(Paths.cache, `skac-${id}-${name}.${extensions[header[1]!]}`);
      const entry: Prepared = {
        file, source, active: true, revision: 0,
        ready: Promise.resolve().then(async () => {
          if (!entry.active) return undefined;
          await file.write(decodeBase64(source.slice(header[0].length)));
          return entry.active ? createAudioPlayer({ uri: file.uri }) : undefined;
        }).catch((error: unknown) => {
          if (entry.active) onErrorRef.current?.(error);
          return undefined;
        }),
      };
      loaded.set(name, entry);
    }
    return () => {
      sounds.current = new Map();
      for (const entry of loaded.values()) {
        entry.active = false;
        void entry.ready.then(async (player) => {
          player?.remove();
          if (entry.file.exists) await entry.file.delete();
        }).catch((error: unknown) => onErrorRef.current?.(error));
      }
    };
  }, [asset, enabled]);

  return useCallback(({ name, source }: MotionAudioCue) => {
    const entry = sounds.current.get(name);
    if (!entry || entry.source !== source) return;
    const revision = ++entry.revision;
    void entry.ready.then(async (player) => {
      if (!player || !entry.active || revision !== entry.revision) return;
      await player.seekTo(0);
      if (entry.active && revision === entry.revision) player.play();
    }).catch((error: unknown) => { if (entry.active) onErrorRef.current?.(error); });
  }, []);
}
