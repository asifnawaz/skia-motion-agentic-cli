// Interface.rig.ts: every moving value of the Interface scene, as a pure function of time in ms.
// Interface.draw.ts draws from rig(ms).channels and nothing else, so `skac Interface --check` tests the numbers that are drawn.
// An interface scene (meta.kind 'interface', `skac docs motion/interface`): continuity in change, stillness at rest.
// 1. Welcome: the boot seal travels and grows into the medallion (word-quran WelcomeScreen.tsx: 600 ms, inOut cubic), and the
//    title rises once the seal has passed its place. 2. The seal carries on into a header badge while the list arrives.
// Then a list card carried into a detail frame, a button pressed and morphed into a sheet, a check that draws on, a count
// that rolls and a word whose points morph into a numeral. Every move takes LINEAR progress (prog) and eases inside;
// opacity finishes within 250 ms (enter, exit) while scale and travel carry the rest, and every swap has a part that travels.

import { EASE_IN_OUT } from './motion/motion';
import { MOVE, carry, enter, exit, morphBox, press, roll } from './motion/moves';

export type RigEvent = { name: string; at: number }; // at: seconds

/** Each moment's window in ms: [from, to]. */
export const BEAT = {
  seal: [0, 600], // Welcome's CARRY_MS 600
  title: [330, 710], // Welcome's TITLE_AT 330, then MOVE.entrance 380
  badge: [1000, 1560], // the seal carries on into the header badge: MOVE.handover 560
  list: [1160, 1540], // the list arrives as the seal leaves its place: MOVE.entrance
  card: [1800, 2360], // carry: MOVE.handover
  detail: [1960, 2340], // the detail's rows arrive behind the card: MOVE.entrance
  press: [2500, 2730], // touch-down at 2500, release at 2600, back over MOVE.press 130
  sheet: [2600, 3160], // morphBox from the release: MOVE.handover
  check: [3300, 3680], // drawOn: MOVE.entrance
  count: [3900, 4460], // roll: MOVE.handover
  word: [4700, 5260], // morphPoints: MOVE.handover
} as const;

export const meta = {
  fps: 60,
  frames: 360, // 6 s: the last move settles at 5.26 s and the screen rests, still, after it
  width: 390, // px; points = px / scale
  height: 867,
  scale: 1,
  kind: 'interface' as const,
  events: [] as RigEvent[],
  // Beats that share `change` are one change: skac/dead-hold warns when what they move stalls over 250 ms inside it.
  beats: [
    { name: 'seal-carry', from_ms: BEAT.seal[0], to_ms: BEAT.seal[1], channel: 'seal', change: 'welcome' },
    { name: 'title-rise', from_ms: BEAT.title[0], to_ms: BEAT.title[1], channel: 'titleY', change: 'welcome' },
    { name: 'seal-to-badge', from_ms: BEAT.badge[0], to_ms: BEAT.badge[1], channel: 'seal', change: 'to-list' },
    { name: 'list-arrives', from_ms: BEAT.list[0], to_ms: BEAT.list[1], channel: 'listY', change: 'to-list' },
    { name: 'card-carry', from_ms: BEAT.card[0], to_ms: BEAT.card[1], channel: 'card', change: 'open-card' },
    { name: 'detail-arrives', from_ms: BEAT.detail[0], to_ms: BEAT.detail[1], channel: 'detailY', change: 'open-card' },
    { name: 'button-press', from_ms: BEAT.press[0], to_ms: BEAT.press[1], channel: 'btnScale', change: 'open-sheet' },
    { name: 'button-to-sheet', from_ms: BEAT.sheet[0], to_ms: BEAT.sheet[1], channel: 'button', change: 'open-sheet' },
    { name: 'check-draws-on', from_ms: BEAT.check[0], to_ms: BEAT.check[1], channel: 'check' },
    { name: 'count-rolls', from_ms: BEAT.count[0], to_ms: BEAT.count[1], channel: 'count' },
    { name: 'word-to-numeral', from_ms: BEAT.word[0], to_ms: BEAT.word[1], channel: 'wordP' },
  ],
  // Each opacity channel and the channels that carry the same element (skac/long-fade reads it); skac/crossfade
  // looks for a part that travels across each swap (here the seal, then the card).
  opacity: {
    titleOpacity: ['titleScale', 'titleY'],
    listOpacity: ['listScale', 'listY'],
    cardOpacity: ['card'], // the card arrives with the list, unseen at its start: skac/abrupt does not judge it there
    detailOpacity: ['detailScale', 'detailY'],
    sheetTextOpacity: ['sheetTextScale', 'sheetTextY'],
  },
  loop: false,
};

export type Channels = ReturnType<typeof rig>['channels'];

// Boxes in pt on the 390 x 867 frame.
export const BOOT_SEAL = { x: 135, y: 373, w: 120, h: 120 }; // the boot screen's seal, centred
export const MEDALLION = { x: 65, y: 120, w: 260, h: 260 }; // Welcome's medallion: higher and larger
export const BADGE = { x: 24, y: 44, w: 48, h: 48 }; // the list screen's header badge
export const TITLE = { x: 75, y: 412, w: 240, h: 34 }; // the title's line (in the app the words are native text)
export const LIST_CARD = { x: 28, y: 250, w: 334, h: 96 };
export const LIST_ROWS = [130, 366, 486]; // the other rows' y
export const DETAIL_CARD = { x: 28, y: 140, w: 334, h: 200 };
export const BUTTON = { x: 95, y: 740, w: 200, h: 56, r: 28 };
export const SHEET = { x: 20, y: 580, w: 350, h: 250, r: 28 };
export const COUNT = { from: 98, to: 107 };

/** Linear progress 0..1 of a window; the moves in moves.ts apply their own curve. */
const prog = (ms: number, w: readonly [number, number]) => {
  'worklet';
  return Math.min(1, Math.max(0, (ms - w[0]) / (w[1] - w[0])));
};

export function rig(ms: number, events: RigEvent[] = meta.events) {
  'worklet';
  // 1. Welcome: one box from the boot seal to the medallion (arc 0: Welcome's straight line), then on into the badge.
  const seal = ms >= BEAT.badge[0]
    ? carry(MEDALLION, BADGE, prog(ms, BEAT.badge))
    : carry(BOOT_SEAL, MEDALLION, prog(ms, BEAT.seal), { arc: 0 });
  // The title rises once the seal has passed its place, and leaves as the seal moves on.
  const titleIn = enter(prog(ms, BEAT.title));
  const titleOut = exit(prog(ms, [BEAT.badge[0], BEAT.badge[0] + MOVE.exitMs]));

  // 2. The list arrives as the seal leaves the middle; later its other rows leave as the card is carried.
  const listIn = enter(prog(ms, BEAT.list), 24);
  const rowsOut = exit(prog(ms, [BEAT.card[0], BEAT.card[0] + MOVE.exitMs]));
  const c = carry(LIST_CARD, DETAIL_CARD, prog(ms, BEAT.card), { reshape: true });
  const detail = enter(prog(ms, BEAT.detail));
  const card = ms < BEAT.card[0] ? { ...LIST_CARD, y: LIST_CARD.y + listIn.y } : c;

  // 3. The button is pressed, then becomes the sheet: one rounded box, position, size and radius together.
  const btnScale = press(ms - BEAT.press[0], ms - (BEAT.press[0] + 100));
  const b = morphBox(BUTTON, SHEET, prog(ms, BEAT.sheet));
  const text = enter(prog(ms, [BEAT.sheet[0] + 260, BEAT.sheet[0] + 260 + MOVE.entrance]));

  // 4. The check draws on: Interface.draw.ts trims its path to [0, check].
  const check = EASE_IN_OUT(prog(ms, BEAT.check));

  // 5. The count rolls; the draw side reads each digit place from roll(...) at countP.
  const countP = prog(ms, BEAT.count);
  const count = roll(COUNT.from, COUNT.to, countP).value;

  // 6. The word's points morph into a numeral: wordP is the morph's linear progress; morphPoints runs in the draw.
  const wordP = prog(ms, BEAT.word);

  return {
    channels: {
      sealX: seal.x,
      sealY: seal.y,
      sealSide: seal.w,
      titleOpacity: titleIn.opacity * titleOut.opacity,
      titleScale: titleIn.scale * titleOut.scale,
      titleY: titleIn.y + titleOut.y,
      listOpacity: listIn.opacity * rowsOut.opacity,
      listScale: listIn.scale * rowsOut.scale,
      listY: listIn.y + rowsOut.y,
      cardOpacity: listIn.opacity,
      cardX: card.x,
      cardY: card.y,
      cardW: card.w,
      cardH: card.h,
      detailOpacity: detail.opacity,
      detailScale: detail.scale,
      detailY: detail.y,
      btnX: b.x,
      btnY: b.y,
      btnW: b.w,
      btnH: b.h,
      btnR: b.r,
      btnScale,
      sheetTextOpacity: text.opacity,
      sheetTextScale: text.scale,
      sheetTextY: text.y,
      check,
      countP,
      count,
      wordP,
    },
    parts: {
      seal: { x: seal.x, y: seal.y, w: seal.w, h: seal.h },
      card: { x: card.x, y: card.y, w: card.w, h: card.h },
      button: { x: b.x, y: b.y, w: b.w, h: b.h },
    },
  };
}
