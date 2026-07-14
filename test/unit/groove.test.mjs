import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGrid, buildGroove, STYLE_LEVELS, SLOTS_PER_BAR } from '../../js/groove.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ev = (t, type = 'kick', velocity = 0.9) => ({ t, type, velocity });

/** kick-hat-snare-hat pattern with hits every `spacing` seconds. */
function pattern(spacing, count, { jitter = 0, rand = null, start = 0.4 } = {}) {
  const types = ['kick', 'hat', 'snare', 'hat'];
  return Array.from({ length: count }, (_, i) =>
    ev(start + i * spacing + (rand ? (rand() * 2 - 1) * jitter : 0), types[i % 4]));
}

/* ---------- detectGrid ---------- */

test('perfect 8th notes at 120 BPM detect as 120', () => {
  const grid = detectGrid(pattern(0.25, 16)); // 0.25 s = 8th at 120
  assert.ok(grid, 'no grid detected');
  assert.ok(Math.abs(grid.bpm - 120) <= 2, `bpm ${grid.bpm}`);
});

test('human jitter (±20 ms) still lands near the true tempo', () => {
  const grid = detectGrid(pattern(0.25, 16, { jitter: 0.02, rand: mulberry32(7) }));
  assert.ok(grid, 'no grid detected');
  assert.ok(Math.abs(grid.bpm - 120) <= 5, `bpm ${grid.bpm}`);
});

test('sparse quarter-note kicks at 100 BPM fold up to 100', () => {
  const events = Array.from({ length: 8 }, (_, i) => ev(0.2 + i * 0.6));
  const grid = detectGrid(events);
  assert.ok(grid, 'no grid detected');
  assert.ok(Math.abs(grid.bpm - 100) <= 3, `bpm ${grid.bpm}`);
});

test('random timing is almost always rejected (no fake grid)', () => {
  // The gates are statistical (tuning sims measured ~5% false positives on
  // 12 random hits). This is a regression guard against the gates
  // collapsing — without the IOI gate the rate would be ~85%.
  let rejected = 0;
  const total = 50;
  for (let seed = 0; seed < total; seed++) {
    const rand = mulberry32(100 + seed);
    const events = Array.from({ length: 12 }, () => ev(rand() * 4)).sort((a, b) => a.t - b.t);
    if (detectGrid(events) === null) rejected++;
  }
  assert.ok(rejected >= 42, `only ${rejected}/${total} random sets rejected`);
});

test('too few hits are rejected', () => {
  assert.equal(detectGrid([ev(0), ev(0.5), ev(1.0)]), null);
});

test('forced bpm skips detection and always grids', () => {
  const rand = mulberry32(3);
  const events = Array.from({ length: 6 }, () => ev(rand() * 3)).sort((a, b) => a.t - b.t);
  const grid = detectGrid(events, { bpm: 95 });
  assert.ok(grid);
  assert.equal(grid.bpm, 95);
  assert.ok(Math.abs(grid.sixteenth - 15 / 95) < 1e-12);
});

/* ---------- buildGroove ---------- */

test('grooves snap, anchor on the first kick, and lock to whole bars', () => {
  const grid = detectGrid(pattern(0.25, 16, { jitter: 0.015, rand: mulberry32(5) }));
  const groove = buildGroove(pattern(0.25, 16, { jitter: 0.015, rand: mulberry32(5) }), grid);
  assert.ok(groove);
  assert.equal(groove.bars, 2); // 16 hits × 8ths = 2 bars
  assert.ok(Math.abs(groove.loopDur - groove.bars * 16 * groove.sixteenth) < 1e-9);
  for (const level of STYLE_LEVELS) assert.ok(Array.isArray(groove.styles[level]), level);
  // tight events sit exactly on the grid; the anchor kick is at 0
  assert.equal(groove.styles.tight[0].t, 0);
  for (const e of groove.styles.tight) {
    const slots = e.t / groove.sixteenth;
    assert.ok(Math.abs(slots - Math.round(slots)) < 1e-9, `off-grid t=${e.t}`);
  }
  // raw preserves performed (jittered) timing, re-anchored
  const rawTs = groove.styles.raw.map((e) => e.t);
  assert.ok(rawTs.some((t) => Math.abs(t / groove.sixteenth - Math.round(t / groove.sixteenth)) > 1e-6),
    'raw should keep human timing');
});

test('faithful preserves the performance exactly: timing, order, no additions', () => {
  const events = [
    ev(0.31, 'hat', 0.6),          // pickup BEFORE the first kick
    ev(0.4, 'kick', 1),
    ev(0.663, 'snare', 0.8),       // deliberately off-grid (swing)
    ev(0.91, 'openhat', 0.7),
    ev(1.15, 'kick', 0.9),
  ];
  const grid = detectGrid(events, { bpm: 100 });
  const groove = buildGroove(events, grid);
  const faithful = groove.styles.faithful;

  assert.equal(faithful.length, events.length, 'nothing added or removed');
  // anchored on the FIRST HIT — the pickup stays first, nothing wraps
  assert.equal(faithful[0].type, 'hat');
  assert.ok(Math.abs(faithful[0].t) < 1e-9);
  // exact micro-timing offsets survive
  for (let i = 1; i < events.length; i++) {
    assert.ok(Math.abs(faithful[i].t - (events[i].t - events[0].t)) < 1e-9, `hit ${i} moved`);
    assert.equal(faithful[i].type, events[i].type, `hit ${i} type changed`);
  }
  // and the loop is long enough to hold the whole take
  const last = faithful[faithful.length - 1];
  assert.ok(groove.loopDur >= last.t, 'loop must cover the performance');
});

test('faithful merges only accidental double-triggers', () => {
  const events = [
    ev(0.4, 'kick', 0.7), ev(0.42, 'kick', 0.95), // 20 ms double-trigger
    ev(0.8, 'hat', 0.6), ev(0.85, 'hat', 0.6),    // 50 ms apart — fast playing, keep both
  ];
  const grid = detectGrid(events, { bpm: 100 });
  const faithful = buildGroove(events, grid).styles.faithful;
  assert.equal(faithful.filter((e) => e.type === 'kick').length, 1);
  assert.equal(faithful.find((e) => e.type === 'kick').velocity, 0.95, 'louder double kept');
  assert.equal(faithful.filter((e) => e.type === 'hat').length, 2, 'fast playing survives');
});

test('faithful never dedupes roll strokes', () => {
  const events = [
    ev(0.4, 'kick', 0.9),
    { ...ev(0.8, 'snare', 0.8), roll: true },
    { ...ev(0.831, 'snare', 0.75), roll: true },
    { ...ev(0.862, 'snare', 0.7), roll: true },
    { ...ev(0.893, 'snare', 0.72), roll: true },
  ];
  const grid = detectGrid(events, { bpm: 100 });
  const faithful = buildGroove(events, grid).styles.faithful;
  assert.equal(faithful.filter((e) => e.type === 'snare').length, 4, 'all roll strokes kept');
});

test('a pickup hit before the first kick wraps to the loop end', () => {
  // hat pickup 0.25 s before the kick pattern starts
  const events = [ev(0.15, 'hat', 0.6), ...pattern(0.25, 12, { start: 0.4 })];
  const grid = detectGrid(events);
  const groove = buildGroove(events, grid);
  assert.ok(groove);
  const tight = groove.styles.tight;
  assert.equal(tight.find((e) => e.t === 0).type, 'kick', 'bar 1 must start on the kick');
  const lastSlot = Math.max(...tight.map((e) => e.slot));
  const wrapped = tight.filter((e) => e.type === 'hat' && e.slot === lastSlot);
  assert.ok(wrapped.length, 'pickup hat should wrap to the end of the loop');
});

test('clean merges same-slot duplicates keeping the stronger hit', () => {
  const grid = { bpm: 120, sixteenth: 0.125, offset: 0, anchorT: 0 };
  const events = [
    ev(0, 'kick', 0.5), ev(0.01, 'kick', 0.9), // double-trigger
    ev(0.5, 'snare', 0.8),
    ev(1.0, 'kick', 0.7), ev(1.5, 'snare', 0.8),
  ];
  const groove = buildGroove(events, grid, { anchor: 'none', bars: 1 });
  assert.equal(groove.styles.tight.length, 5);
  assert.equal(groove.styles.clean.length, 4);
  const mergedKick = groove.styles.clean.find((e) => e.type === 'kick' && e.slot === 0);
  assert.equal(mergedKick.velocity, 0.9);
});

test('full adds backbeat snares, bar-start kicks, and 8th hats', () => {
  const grid = { bpm: 120, sixteenth: 0.125, offset: 0, anchorT: 0 };
  const events = [ev(0, 'kick'), ev(1.0, 'kick')]; // kicks on beats 1 and 3 only
  const groove = buildGroove(events, grid, { anchor: 'none', bars: 1 });
  const full = groove.styles.full;
  const at = (type, slot) => full.filter((e) => e.type === type && e.slot === slot);

  assert.equal(at('snare', 4).length, 1, 'backbeat on 2');
  assert.equal(at('snare', 12).length, 1, 'backbeat on 4');
  assert.equal(at('kick', 0).length, 1, 'kick on 1 kept, not duplicated');
  // hats on every 8th slot except the backbeat slots
  const hatSlots = full.filter((e) => e.type === 'hat').map((e) => e.slot).sort((a, b) => a - b);
  assert.deepEqual(hatSlots, [0, 2, 6, 8, 10, 14]);
  // and it stays within one bar
  assert.ok(full.every((e) => e.slot < SLOTS_PER_BAR));
});

test('full never stacks a closed hat on the performer\'s open hat', () => {
  const grid = { bpm: 120, sixteenth: 0.125, offset: 0, anchorT: 0 };
  const events = [ev(0, 'kick'), ev(0.75, 'openhat', 0.8), ev(1.0, 'snare')];
  const groove = buildGroove(events, grid, { anchor: 'none', bars: 1 });
  const full = groove.styles.full;
  assert.ok(full.some((e) => e.type === 'openhat' && e.slot === 6), 'open hat preserved');
  assert.ok(!full.some((e) => e.type === 'hat' && e.slot === 6), 'no closed hat stacked on slot 6');
});

test('full uses the performer\'s own velocities for generated hits', () => {
  const grid = { bpm: 120, sixteenth: 0.125, offset: 0, anchorT: 0 };
  const events = [ev(0, 'kick', 1), ev(0.5, 'snare', 0.6), ev(0.25, 'hat', 0.4)];
  const groove = buildGroove(events, grid, { anchor: 'none', bars: 1 });
  const genSnare = groove.styles.full.find((e) => e.type === 'snare' && e.slot === 12);
  assert.ok(Math.abs(genSnare.velocity - 0.6 * 0.9) < 1e-9);
});
