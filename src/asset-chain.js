import { fail } from './util.js';

/** A caused beat starts within this many ms after its cause's contact. */
export const CHAIN_LEAD_MS = 80;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Read an artboard's authoring-only `register` and `chain`:
 *   "register": "earned",
 *   "chain": { "clip": "open", "beats": [{ "id": "shake", "channels": ["tilt"], "contacts": { "peak": 420 } },
 *                                        { "id": "lid", "channels": ["lidY"], "cause": "shake@peak" }] }
 * A contact is a time in the clip (ms) or "end", the beat's last change. Returns undefined when neither field is there.
 */
export function readChain(register, chain, at) {
  if (register === undefined && chain === undefined) return undefined;
  if (register !== undefined && register !== 'earned' && register !== 'chrome') {
    fail(`${at}register: expected "earned" or "chrome"`, 'an earned moment chains its beats; interface chrome does not');
  }
  if (chain === undefined) return { register, beats: [] };
  if (!record(chain) || !Array.isArray(chain.beats) || chain.beats.length > 64 || Object.keys(chain).some((key) => !['clip', 'beats'].includes(key))) {
    fail(`${at}chain: expected { clip?, beats: [...] }`, 'list one beat per line of the chain: { id, channels, cause?, contacts? }');
  }
  const ids = new Set();
  const beats = chain.beats.map((beat, i) => {
    const where = `${at}chain.beats[${i}]`;
    if (!record(beat) || Object.keys(beat).some((key) => !['id', 'channels', 'cause', 'contacts'].includes(key))) {
      fail(`${where}: expected { id, channels, cause?, contacts? }`, 'cause is "<beat>@<contact>"; contacts maps a name to a time in ms or "end"');
    }
    if (typeof beat.id !== 'string' || !IDENTIFIER.test(beat.id) || ids.has(beat.id)) fail(`${where}.id: expected a unique identifier`, 'name the beat');
    ids.add(beat.id);
    if (!Array.isArray(beat.channels) || !beat.channels.length || beat.channels.some((name) => typeof name !== 'string')) {
      fail(`${where}.channels: expected channel names`, 'list the channels this beat moves');
    }
    if (beat.cause !== undefined && (typeof beat.cause !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z_][A-Za-z0-9_-]*$/.test(beat.cause))) {
      fail(`${where}.cause: expected "<beat>@<contact>"`, 'name the beat that touches this one and the contact on it');
    }
    const contacts = beat.contacts ?? {};
    if (!record(contacts) || Object.entries(contacts).some(([name, time]) => !IDENTIFIER.test(name) || !(time === 'end' || (typeof time === 'number' && time >= 0)))) {
      fail(`${where}.contacts: expected { name: ms | "end" }`, 'a contact is the moment this beat touches the next');
    }
    return { id: beat.id, channels: beat.channels, cause: beat.cause, contacts, where };
  });
  return { register: register ?? 'earned', clip: chain.clip, beats };
}

/** When a track first leaves its value and last changes it, in clip ms; undefined for a track that never moves. */
function motion(keys) {
  let start;
  let end;
  for (let i = 1; i < keys.length; i++) {
    if (keys[i][1] === keys[i - 1][1]) continue;
    start ??= keys[i - 1][0];
    end = keys[i][0];
  }
  return start === undefined ? undefined : { start, end };
}

/**
 * skac/causal-chain. In an earned moment every beat but the first starts 0 to 80 ms after the contact that causes it, so each beat is set
 * off by the one before rather than by the clock. Two beats set off by the same contact at the same ms are layering, not chaining: a
 * warning. Without a chain, the clip's channels are listed by when they start, so the chain can be written from them.
 */
export function causalChain(asset, chain, severity = 'error') {
  const errors = [];
  const warnings = [];
  const clipName = chain.clip ?? Object.entries(asset.clips).sort(([, a], [, b]) => b.ms - a.ms)[0]?.[0];
  const clip = asset.clips[clipName];
  if (!clip) fail(`chain.clip: unknown clip ${JSON.stringify(chain.clip)}`, `use one of ${Object.keys(asset.clips).join(', ')}`);
  const moves = Object.fromEntries(Object.entries(clip.tracks).map(([name, keys]) => [name, motion(keys)]).filter(([, m]) => m));
  const starts = (names) => {
    const times = names.map((name) => moves[name]).filter(Boolean);
    return times.length ? { start: Math.min(...times.map((m) => m.start)), end: Math.max(...times.map((m) => m.end)) } : undefined;
  };
  const report = { clip: clipName, beats: [], unclaimed: [] };
  if (chain.register === 'chrome') return { errors, warnings, report };
  if (!chain.beats.length) {
    errors.push({ rule: 'skac/causal-chain', error: `an earned moment declares no chain: write one beat per line, each with the contact that causes it (clip "${clipName}")`, hint: 'see `asset guide chain`; `unclaimed` lists the clip\'s channels by when they start' });
  }
  const byId = new Map(chain.beats.map((beat) => [beat.id, beat]));
  const claimed = new Set();
  const timing = new Map();
  for (const beat of chain.beats) {
    for (const name of beat.channels) {
      if (!Object.hasOwn(asset.channels, name)) errors.push({ rule: 'skac/causal-chain', beat: beat.id, error: `${beat.where}: unknown channel "${name}"`, hint: 'list declared channels' });
      claimed.add(name);
    }
    const time = starts(beat.channels);
    if (!time) errors.push({ rule: 'skac/causal-chain', beat: beat.id, error: `beat ${beat.id} never moves in clip "${clipName}"`, hint: 'key its channels in the clip, or drop the beat' });
    timing.set(beat.id, time);
  }
  const contactAt = (beat, name) => {
    const value = beat.contacts[name];
    if (value === 'end') return timing.get(beat.id)?.end;
    return value;
  };
  const uncaused = chain.beats.filter((beat) => !beat.cause);
  if (chain.beats.length && uncaused.length !== 1) {
    errors.push({ rule: 'skac/causal-chain', error: uncaused.length
      ? `${uncaused.length} beats have no cause (${uncaused.map(({ id }) => id).join(', ')}); only the first beat, the trigger, may start on its own`
      : 'every beat has a cause, so the chain has no first beat', hint: 'give each later beat cause: "<beat>@<contact>"' });
  }
  const fired = new Map();
  for (const beat of chain.beats) {
    const time = timing.get(beat.id);
    report.beats.push({ id: beat.id, cause: beat.cause ?? null, start_ms: time?.start ?? null, end_ms: time?.end ?? null });
    if (!beat.cause || !time) continue;
    const [causeId, contact] = beat.cause.split('@');
    const cause = byId.get(causeId);
    if (!cause) {
      errors.push({ rule: 'skac/causal-chain', beat: beat.id, error: `beat ${beat.id}: its cause "${causeId}" is not a beat`, hint: 'name a beat in this chain' });
      continue;
    }
    if (cause === beat) {
      errors.push({ rule: 'skac/causal-chain', beat: beat.id, error: `beat ${beat.id} causes itself`, hint: 'name the beat that touches this one' });
      continue;
    }
    if (!Object.hasOwn(cause.contacts, contact)) {
      errors.push({ rule: 'skac/causal-chain', beat: beat.id, error: `beat ${beat.id}: ${causeId} has no contact "${contact}"`, hint: `declare it on ${causeId}: "contacts": { "${contact}": <ms> | "end" }` });
      continue;
    }
    const at = contactAt(cause, contact);
    if (at === undefined) continue;
    const gap = Math.round(time.start - at);
    if (gap < 0 || gap > CHAIN_LEAD_MS) {
      errors.push({ rule: 'skac/causal-chain', beat: beat.id, cause: beat.cause, gap_ms: gap,
        error: `beat ${beat.id} starts ${Math.abs(gap)} ms ${gap < 0 ? 'before' : 'after'} its cause ${beat.cause} (${at} ms); it must start 0 to ${CHAIN_LEAD_MS} ms after`,
        hint: gap < 0 ? 'a beat cannot move before what touches it: move its first key after the contact' : 'start the beat at the contact, or move the contact to the moment of touch' });
    }
    const key = `${beat.cause}|${time.start}`;
    if (!fired.has(key)) fired.set(key, []);
    fired.get(key).push(beat.id);
  }
  for (const [key, beats] of fired) {
    if (beats.length < 2) continue;
    const [cause, start] = key.split('|');
    warnings.push({ code: 'causal-chain-layered', rule: 'skac/causal-chain', beats,
      error: `${beats.join(', ')} all start at ${start} ms off ${cause}: that is layering, not chaining`,
      hint: 'let one of them touch the next (a contact on it), or stagger them as one beat' });
  }
  // Channels no beat claims, grouped by when they start: what the chain still has to say.
  const groups = new Map();
  for (const [name, { start }] of Object.entries(moves)) {
    if (claimed.has(name)) continue;
    if (!groups.has(start)) groups.set(start, []);
    groups.get(start).push(name);
  }
  report.unclaimed = [...groups].sort(([a], [b]) => a - b).map(([start_ms, channels]) => ({ start_ms, channels }));
  if (chain.beats.length && report.unclaimed.length) {
    warnings.push({ code: 'causal-chain-unclaimed', rule: 'skac/causal-chain',
      error: `${report.unclaimed.reduce((n, { channels }) => n + channels.length, 0)} moving channels belong to no beat (first at ${report.unclaimed[0].start_ms} ms: ${report.unclaimed[0].channels.slice(0, 4).join(', ')})`,
      hint: 'add them to the beat they belong to, so the chain covers everything that moves' });
  }
  if (severity === 'warn') return { errors: [], warnings: [...errors.map((e) => ({ ...e, code: 'causal-chain' })), ...warnings], report };
  return { errors, warnings, report };
}
