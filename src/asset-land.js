import { fail } from './util.js';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The node at an id path ("artboard.nodes[2].children[0]") and the groups above it, outermost first. */
function nodeChain(nodes, where, id) {
  if (where.includes('.pins.')) fail(`landing ${id}: a node on a mesh pin cannot be aimed`, 'aim the pin\'s parent, or key the end by hand');
  const chain = [];
  let list = nodes;
  for (const [, index] of where.matchAll(/\[(\d+)\]/g)) {
    const node = list[Number(index)];
    chain.push(node);
    list = node.children ?? [];
  }
  return chain;
}

/** The index where a track's final value starts holding: its last change. Undefined for a track that never moves. */
function landingKey(keys) {
  for (let i = keys.length - 1; i > 0; i--) if (keys[i][1] !== keys[i - 1][1]) return i;
  return undefined;
}

const centre = (box) => ({ x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2 });

/**
 * Write the end keys of every landing marked `aim: true`, so the flown node's centre comes to rest on its target's centre. The node's x and
 * y must be channels keyed in one clip; the groups above it may move and scale by fixed numbers, but not rotate or scale by a channel,
 * because the end key is solved in the node's own parent space. The pose is the clip's own at the node's last key, over the channel
 * defaults; skac/landing then judges the result in the full trace. `measure` gives the parsed asset as the check draws it (default font
 * applied) and its ink: text by laid-out lines, images by alpha. Returns the rewritten source text and one report per aimed landing.
 */
export function hasAims(boards) {
  return [...boards.values()].some((meta) => meta.landings.some(({ aim }) => aim));
}

export function aimLandings(runtime, text, boards, { visual = (asset) => asset, textExtent, imageInk, missing = [] } = {}) {
  const aims = [...boards.values()].flatMap((meta) => meta.landings.filter(({ aim }) => aim));
  if (!aims.length) return { text, aimed: [] };
  const data = JSON.parse(text);
  if (data.schema === 'skac.bundle/1') fail('aim: true is not supported in bundles yet', 'aim the landings in a single-artboard source, then bundle it');
  const meta = boards.get('');
  const aimed = [];
  for (const landing of meta.landings) {
    if (!landing.aim) continue;
    const asset = runtime.parseAssetSource(JSON.stringify(data));
    const nodeAt = meta.ids.get(landing.node);
    const targetAt = meta.ids.get(landing.target);
    const chain = nodeChain(asset.artboard.nodes, nodeAt, landing.node);
    const node = chain.at(-1);
    // A text in a host font slot with no face given would be aimed at its declared box, and pack would ship those keys: refuse instead.
    const inside = (where, at) => where === at || where.startsWith(`${at}.`);
    for (const { node: textNode, where } of runtime.assetTextNodes(asset.artboard.nodes)) {
      const slot = textNode.fonts?.find((name) => missing.includes(name));
      if (!slot || !(inside(where, nodeAt) || inside(where, targetAt))) continue;
      fail(`landing ${landing.node}: ${inside(where, targetAt) ? landing.target : landing.node} has text in font slot "${slot}", so its ink cannot be measured`,
        `pass --font=${slot}=<font file> to every command that reads this source (check, trace, frame, pack)`);
    }
    if (typeof node.x !== 'string' || typeof node.y !== 'string') {
      fail(`landing ${landing.node}: aim needs its x and y bound to channels`, `bind ${landing.node}'s x and y to channels keyed in its flight clip`);
    }
    let scaleX = 1;
    let scaleY = 1;
    for (const group of chain.slice(0, -1)) {
      if (group.rotation !== undefined && group.rotation !== 0) {
        fail(`landing ${landing.node}: a group above it rotates`, 'aim needs translate-only parents; move the rotation inside the node or key the end by hand');
      }
      if (typeof group.scaleX === 'string' || typeof group.scaleY === 'string') {
        fail(`landing ${landing.node}: a group above it scales by a channel`, 'aim needs fixed parent scales; key the end by hand');
      }
      scaleX *= group.scaleX ?? 1;
      scaleY *= group.scaleY ?? 1;
    }
    const clips = Object.entries(data.clips ?? {}).filter(([, clip]) => record(clip?.tracks) && (node.x in clip.tracks || node.y in clip.tracks));
    const named = landing.clip === undefined ? clips : clips.filter(([name]) => name === landing.clip);
    if (named.length !== 1) {
      fail(`landing ${landing.node}: ${named.length ? `${named.length} clips key its x or y (${named.map(([name]) => name).join(', ')})` : landing.clip ? `clip "${landing.clip}" does not key its x or y` : 'no clip keys its x or y'}`,
        'name the flight clip with "clip" on the landing');
    }
    const [clipName, clip] = named[0];
    const tracks = [[node.x, scaleX, 'x'], [node.y, scaleY, 'y']].map(([channel, scale, axis]) => {
      const keys = clip.tracks[channel];
      const from = keys && landingKey(keys);
      if (from === undefined) fail(`landing ${landing.node}: ${channel} never moves in clip "${clipName}"`, `key ${landing.node}'s ${axis} in its flight`);
      return { channel, scale, axis, keys, from };
    });
    const t_ms = Math.max(...tracks.map(({ keys, from }) => keys[from][0]));
    const measure = () => {
      const parsed = visual(runtime.parseAssetSource(JSON.stringify(data)));
      const pose = { ...parsed.channels, ...runtime.assetClips(parsed)[clipName].play(t_ms).channels };
      const values = Object.fromEntries(Object.entries(parsed.machine.values ?? {}).map(([name, value]) => [name, value.default]));
      const boxes = runtime.assetInkBoxes(parsed, pose, values, textExtent ?? ((textNode) => runtime.declaredText(textNode)), parsed.artboard, imageInk);
      const from = boxes.get(nodeAt)?.box;
      const to = boxes.get(targetAt)?.box;
      if (!from || !to) fail(`landing ${landing.node}: ${from ? landing.target : landing.node} draws nothing at ${t_ms} ms in clip "${clipName}"`, 'both must be on screen where the flight ends');
      return { node: centre(from), target: centre(to) };
    };
    // Twice: a clip or an ink fraction can make the centre move by other than the key's change, and the second pass takes up the rest.
    const moved = { x: 0, y: 0 };
    for (let pass = 0; pass < 2; pass++) {
      const { node: at, target } = measure();
      for (const track of tracks) {
        const change = (target[track.axis] - at[track.axis]) / track.scale;
        if (Math.abs(change) < 1e-6) continue;
        track.keys = track.keys.map((key, i) => (i >= track.from ? [key[0], Math.round((key[1] + change) * 1000) / 1000, ...key.slice(2)] : key));
        clip.tracks[track.channel] = track.keys;
        moved[track.axis] += change;
      }
    }
    const { node: at, target } = measure();
    aimed.push({
      node: landing.node, target: landing.target, clip: clipName, t_ms,
      moved: { x: Math.round(moved.x * 100) / 100, y: Math.round(moved.y * 100) / 100 },
      offset: Math.round(Math.hypot(target.x - at.x, target.y - at.y) * 100) / 100,
    });
  }
  return { text: JSON.stringify(data), aimed };
}
