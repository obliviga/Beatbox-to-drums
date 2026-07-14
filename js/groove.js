/**
 * Groove analysis — turns a freely-recorded performance into a bar-locked,
 * quantized beat with no metronome required.
 *
 * detectGrid(): estimates the tempo from hit timing alone. Every candidate
 * pulse (tatum) is scored with circular statistics: map each hit time onto
 * a circle of circumference `step` — if the hits sit on a grid of that
 * step, their phase angles cluster and the resultant vector is long.
 * The best-scoring largest step wins, is treated as a sixteenth note, and
 * the tempo is octave-folded into a musical range.
 *
 * buildGroove(): snaps hits to the detected grid, anchors the bar so the
 * first kick lands on beat 1 (hits before it wrap to the loop's end as a
 * pickup), rounds the loop to whole bars, and derives the style ladder:
 *   raw   — exactly as performed (re-anchored only)
 *   tight — snapped to the 1/16 grid, every hit kept
 *   clean — snapped + same-slot duplicate hits merged
 *   full  — clean + generated hi-hats on 8ths, backbeat snares, bar-1 kicks
 *
 * Pure functions, no Web Audio — unit-testable in Node.
 */

export const STYLE_LEVELS = ['raw', 'faithful', 'tight', 'clean', 'full'];
export const SLOTS_PER_BAR = 16; // 1/16 notes in 4/4

// Gate thresholds tuned by Monte-Carlo simulation (400 trials/scenario):
// false positives on 12 random hits ≈5% (16 hits ≈0.5%) while accepting
// ≥99.5% of patterns with ±20–30 ms human jitter and dropped beats.
const MIN_EVENTS_FOR_DETECT = 4;
const TATUM_MIN = 0.08; // s — caps detected tempo at 187 BPM
const TATUM_MAX = 0.8;
const CONFIDENCE_MIN = 0.7; // resultant length gate
const INLIER_WIN = 0.2;     // hits must sit within ±20% of a slot…
const INLIER_MIN = 0.75;    // …for at least 75% of hits
const IOI_WIN = 0.18;       // successive intervals within ±18% of a whole
const IOI_MIN = 0.7;        //   number of slots, for at least 70% of them
const BPM_FOLD_MIN = 65;    // fold tempo upward into [65, ~188)

/**
 * Estimate a 1/16 grid from hit times.
 * @param {{t:number,type:string,velocity:number}[]} events — chronological
 * @param {{bpm?:number}} [opts] — pass bpm to skip detection and just fit
 *   the grid phase at that tempo (manual override / re-grid).
 * @returns {{bpm:number, sixteenth:number, offset:number, confidence:number, anchorT:number}|null}
 */
export function detectGrid(events, { bpm = null } = {}) {
  if (!events || events.length < (bpm ? 1 : MIN_EVENTS_FOR_DETECT)) return null;
  const anchorT = events[0].t;
  const ts = events.map((e) => e.t - anchorT);
  const ws = events.map((e) => Math.max(0.2, e.velocity || 0.8));

  const fitPhase = (step) => {
    let re = 0;
    let im = 0;
    let wSum = 0;
    for (let i = 0; i < ts.length; i++) {
      const theta = (2 * Math.PI * ts[i]) / step;
      re += ws[i] * Math.cos(theta);
      im += ws[i] * Math.sin(theta);
      wSum += ws[i];
    }
    const confidence = Math.hypot(re, im) / wSum;
    let offset = (Math.atan2(im, re) / (2 * Math.PI)) * step;
    if (offset < 0) offset += step;
    return { confidence, offset };
  };

  const inlierFrac = (step, offset) => {
    let n = 0;
    for (const t of ts) {
      const m = (((t - offset) % step) + step) % step;
      if (Math.min(m, step - m) <= INLIER_WIN * step) n++;
    }
    return n / ts.length;
  };

  // Real rhythms space their hits near whole multiples of the pulse;
  // random timing doesn't. This is the strongest anti-false-grid gate.
  const ioiFrac = (step) => {
    let n = 0;
    let total = 0;
    for (let i = 1; i < ts.length; i++) {
      const ratio = (ts[i] - ts[i - 1]) / step;
      if (ratio < 0.5) continue; // same-slot double-trigger, ignore
      total++;
      if (Math.abs(ratio - Math.round(ratio)) <= IOI_WIN) n++;
    }
    return total ? n / total : 0;
  };

  if (bpm) {
    const clamped = Math.min(240, Math.max(40, Math.round(bpm)));
    const sixteenth = 15 / clamped;
    const { confidence, offset } = fitPhase(sixteenth);
    return { bpm: clamped, sixteenth, offset, confidence, anchorT };
  }

  // Sweep tatum candidates (geometric steps ≈1% apart)
  const candidates = [];
  let maxConf = 0;
  for (let s = TATUM_MIN; s <= TATUM_MAX; s *= 1.01) {
    const { confidence, offset } = fitPhase(s);
    candidates.push({ s, confidence, offset });
    if (confidence > maxConf) maxConf = confidence;
  }
  if (maxConf < CONFIDENCE_MIN) return null;

  // Among near-best candidates prefer the LARGEST step: a fine grid that a
  // coarse one explains equally well is the wrong octave (e.g. hearing
  // straight quarters as sixteenths).
  const good = candidates.filter((c) => c.confidence >= Math.max(CONFIDENCE_MIN, 0.97 * maxConf));
  let best = good[good.length - 1];

  // Local refinement around the chosen step
  for (let m = 0.97; m <= 1.031; m += 0.002) {
    const s = best.s * m;
    const { confidence, offset } = fitPhase(s);
    if (confidence > best.confidence) best = { s, confidence, offset };
  }
  if (best.confidence < CONFIDENCE_MIN) return null;
  if (inlierFrac(best.s, best.offset) < INLIER_MIN) return null;
  if (ioiFrac(best.s) < IOI_MIN) return null;

  // Treat the tatum as a sixteenth and fold the tempo up into range.
  // Folding up halves the sixteenth — a finer grid keeps every hit aligned.
  let tempo = 15 / best.s;
  while (tempo < BPM_FOLD_MIN) tempo *= 2;
  tempo = Math.round(tempo);
  const sixteenth = 15 / tempo;
  const { confidence, offset } = fitPhase(sixteenth);
  return { bpm: tempo, sixteenth, offset, confidence: Math.max(confidence, best.confidence), anchorT };
}

/**
 * Snap a performance to a grid and derive all style levels.
 * @param {{t:number,type:string,velocity:number}[]} events — chronological
 * @param {{bpm:number, sixteenth:number, offset:number, anchorT?:number}} grid
 * @param {{anchor?:'auto'|'none', bars?:number|null}} [opts]
 *   anchor 'auto' re-anchors bar 1 on the first kick (fallback: first hit);
 *   'none' trusts t=0 as the downbeat (metronome recordings).
 *   bars forces the loop length (metronome recordings know it already).
 * @returns {{bpm:number, sixteenth:number, loopDur:number, bars:number,
 *            styles:Record<'raw'|'tight'|'clean'|'full', object[]>}|null}
 */
export function buildGroove(events, grid, { anchor = 'auto', bars = null } = {}) {
  if (!events || !events.length || !grid) return null;
  const { sixteenth, bpm } = grid;
  const anchorT = grid.anchorT || 0;
  const offset = grid.offset || 0;

  const slotted = events.map((e) => ({
    t: e.t,
    type: e.type,
    velocity: e.velocity,
    duration: e.duration,
    slot: Math.round((e.t - anchorT - offset) / sixteenth),
  }));

  // Grid styles anchor bar 1 on the first kick (musical bar phase);
  // raw/faithful anchor on the FIRST HIT so the performance's order can
  // never be scrambled by a pickup wrapping to the loop end.
  let anchorSlot = 0;
  if (anchor === 'auto') {
    const a = slotted.find((e) => e.type === 'kick') || slotted[0];
    anchorSlot = a.slot;
  }
  for (const e of slotted) e.slot -= anchorSlot;
  const firstRawT = anchor === 'none' ? 0 : Math.min(...slotted.map((e) => e.t));

  const posSlots = slotted.filter((e) => e.slot >= 0).map((e) => e.slot);
  const maxSlot = posSlots.length ? Math.max(...posSlots) : 0;
  const rawSpan = Math.max(...slotted.map((e) => e.t)) - firstRawT;
  const barDur = SLOTS_PER_BAR * sixteenth;
  const barCount = bars || Math.max(
    1,
    Math.ceil((maxSlot + 1) / SLOTS_PER_BAR),
    Math.ceil((rawSpan + sixteenth) / barDur),
  );
  const totalSlots = barCount * SLOTS_PER_BAR;
  const loopDur = totalSlots * sixteenth;

  // Pickup hits (before the anchor) and overshoot wrap into the loop
  for (const e of slotted) e.slot = ((e.slot % totalSlots) + totalSlots) % totalSlots;

  const byT = (a, b) => a.t - b.t;

  const raw = slotted
    .map((e) => ({
      t: (((e.t - firstRawT) % loopDur) + loopDur) % loopDur,
      type: e.type,
      velocity: e.velocity,
      duration: e.duration,
    }))
    .sort(byT);

  // faithful: the performance exactly as played — original micro-timing,
  // dynamics, and open hats — with only accidental double-triggers merged
  const faithful = [];
  for (const e of raw) {
    const prev = faithful[faithful.length - 1];
    if (prev && prev.type === e.type && e.t - prev.t < 0.06) {
      if (e.velocity > prev.velocity) faithful[faithful.length - 1] = { ...e };
    } else {
      faithful.push({ ...e });
    }
  }

  const tight = slotted
    .map((e) => ({ t: e.slot * sixteenth, slot: e.slot, type: e.type, velocity: e.velocity }))
    .sort(byT);

  // clean: merge same-drum hits that landed in the same slot
  const merged = new Map();
  for (const e of tight) {
    const key = `${e.type}:${e.slot}`;
    const prev = merged.get(key);
    if (!prev || e.velocity > prev.velocity) merged.set(key, { ...e });
  }
  const clean = [...merged.values()].sort(byT);

  const full = embellish(clean, { sixteenth, barCount, totalSlots }).sort(byT);

  return { bpm, sixteenth, loopDur, bars: barCount, styles: { raw, faithful, tight, clean, full } };
}

/** clean + generated kicks on 1, backbeat snares on 2 & 4, hats on 8ths. */
function embellish(clean, { sixteenth, barCount, totalSlots }) {
  const out = clean.map((e) => ({ ...e }));
  const occupied = new Set(out.map((e) => `${e.type}:${e.slot}`));
  const has = (type, slot) => occupied.has(`${type}:${slot}`);
  const add = (type, slot, velocity) => {
    out.push({ t: slot * sixteenth, slot, type, velocity });
    occupied.add(`${type}:${slot}`);
  };

  const kickVel = median(out.filter((e) => e.type === 'kick').map((e) => e.velocity)) || 0.85;
  const snareVel = median(out.filter((e) => e.type === 'snare').map((e) => e.velocity)) || 0.7;
  const hatVel = median(out.filter((e) => e.type === 'hat').map((e) => e.velocity)) || 0.5;

  // deterministic per-slot velocity wobble so filled hats breathe like a
  // played pattern instead of a machine
  const wobble = (slot) => ((((slot + 7) * 2654435761) >>> 16) & 0xff) / 255 - 0.5;

  for (let b = 0; b < barCount; b++) {
    const base = b * SLOTS_PER_BAR;
    if (!has('kick', base)) add('kick', base, kickVel * 0.95);
    for (const beat of [4, 12]) {
      if (!has('snare', base + beat)) add('snare', base + beat, snareVel * 0.9);
    }
    for (let s = 0; s < SLOTS_PER_BAR; s += 2) {
      const slot = base + s;
      if (slot >= totalSlots) break;
      // leave backbeat slots uncluttered, and never stack a closed hat on
      // an open one (it would instantly choke the performer's open hat)
      if (!has('hat', slot) && !has('snare', slot) && !has('openhat', slot)) {
        const accent = s % 4 === 0 ? 1 : 0.72;
        add('hat', slot, Math.min(1, hatVel * accent * (1 + 0.14 * wobble(slot))));
      }
    }
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
