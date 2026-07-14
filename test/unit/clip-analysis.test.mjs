import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeClip, detectOnsets, kmeans } from '../../js/clip-analysis.js';
import { classifyHit, analyzeHit } from '../../js/classifier.js';

const SR = 48000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- hit generators (one synthetic "voice") ---------- */

function kickSig(rand, len = 3000) {
  const out = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 55 + 70 * Math.exp(-t * 80);
    phase += (2 * Math.PI * f) / SR;
    out[i] = 0.85 * Math.sin(phase) * Math.exp(-t * 14);
    if (i < 50) out[i] += 0.18 * (rand() * 2 - 1);
  }
  return out;
}

function bandSig(rand, f0, f1, step, decay, len = 2500) {
  const out = new Float32Array(len);
  const freqs = [];
  const phases = [];
  for (let f = f0; f <= f1; f += step) {
    freqs.push(f * (1 + (rand() - 0.5) * 0.05));
    phases.push(rand() * 2 * Math.PI);
  }
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += Math.sin(2 * Math.PI * freqs[k] * t + phases[k]);
    out[i] = (v / freqs.length) * Math.exp(-t * decay);
  }
  return out;
}

const snareSig = (rand) => bandSig(rand, 500, 3200, 150, 16);
// deliberately bright snare variant — the rule tree alone misreads these
const brightSnareSig = (rand) => bandSig(rand, 1400, 4600, 160, 16);
const hatSig = (rand) => bandSig(rand, 5500, 12000, 320, 26, 1600);
// same spectrum as a closed hat but ringing ~0.4 s — an open hat "tsss"
const openHatSig = (rand) => bandSig(rand, 5500, 12000, 320, 7, 20000);

/** Build a clip: silence + noise floor, hits placed at given times. */
function buildClip(placed, dur = 4, noise = 0.0015, gain = 1) {
  const clip = new Float32Array(Math.round(dur * SR));
  const rand = mulberry32(999);
  for (let i = 0; i < clip.length; i++) clip[i] = (rand() * 2 - 1) * noise;
  for (const [t, sig, amp = 1] of placed) {
    const start = Math.round(t * SR);
    for (let i = 0; i < sig.length && start + i < clip.length; i++) {
      clip[start + i] += sig[i] * amp * gain;
    }
  }
  return clip;
}

const seq = (types, spacing = 0.4, start = 0.5) =>
  types.map((sig, i) => [start + i * spacing, sig]);

/* ---------- tests ---------- */

test('a kick/snare/hat take converts with correct times and labels', () => {
  const r = (s) => mulberry32(s);
  const placed = seq([
    kickSig(r(1)), hatSig(r(2)), snareSig(r(3)), hatSig(r(4)),
    kickSig(r(5)), hatSig(r(6)), snareSig(r(7)), hatSig(r(8)),
  ]);
  const { events } = analyzeClip(buildClip(placed), SR);
  assert.equal(events.length, 8, `expected 8 hits, got ${events.length}`);
  const expected = ['kick', 'hat', 'snare', 'hat', 'kick', 'hat', 'snare', 'hat'];
  events.forEach((e, i) => {
    assert.equal(e.type, expected[i], `hit ${i}: ${e.type} ≠ ${expected[i]}`);
    assert.ok(Math.abs(e.t - (0.5 + i * 0.4)) < 0.02, `hit ${i} timing off: ${e.t}`);
    assert.ok(e.velocity > 0.3 && e.velocity <= 1);
  });
});

test('context adapts: a very quiet recording converts identically', () => {
  const r = (s) => mulberry32(s);
  const placed = seq([kickSig(r(1)), hatSig(r(2)), snareSig(r(3)), hatSig(r(4)), kickSig(r(5)), snareSig(r(6))]);
  const { events: loud } = analyzeClip(buildClip(placed, 4, 0.0015, 1), SR);
  const { events: quiet } = analyzeClip(buildClip(placed, 4, 0.00015, 0.1), SR);
  assert.equal(quiet.length, loud.length, 'quiet clip should detect the same hits');
  assert.deepEqual(quiet.map((e) => e.type), loud.map((e) => e.type));
});

test('THE context test: odd hits are corrected by their cluster siblings', () => {
  const r = (s) => mulberry32(s);
  // two of the six snares are bright variants that the per-hit rule tree
  // gets wrong on its own — verify that premise first
  const oddFeatures = analyzeHit(
    (() => { const a = new Float32Array(1024); a.set(brightSnareSig(r(60)).subarray(0, 1024)); return a; })(), SR);
  assert.notEqual(classifyHit(oddFeatures), 'snare', 'premise: rule tree alone misreads the bright snare');

  const placed = seq([
    kickSig(r(11)), snareSig(r(12)), kickSig(r(13)), brightSnareSig(r(14)),
    kickSig(r(15)), snareSig(r(16)), kickSig(r(17)), brightSnareSig(r(18)),
    kickSig(r(19)), snareSig(r(20)), kickSig(r(21)), snareSig(r(22)),
  ], 0.3);
  const { events } = analyzeClip(buildClip(placed, 5), SR);
  assert.equal(events.length, 12);
  const expected = ['kick', 'snare'];
  events.forEach((e, i) => {
    assert.equal(e.type, expected[i % 2], `hit ${i} (${i % 2 ? 'snare' : 'kick'} position): got ${e.type}`);
  });
});

test('a two-sound take labels both sounds sensibly', () => {
  const r = (s) => mulberry32(s);
  const placed = seq([kickSig(r(31)), hatSig(r(32)), kickSig(r(33)), hatSig(r(34)), kickSig(r(35)), hatSig(r(36))], 0.35);
  const { events } = analyzeClip(buildClip(placed), SR);
  assert.equal(events.length, 6);
  assert.deepEqual(events.map((e) => e.type), ['kick', 'hat', 'kick', 'hat', 'kick', 'hat']);
});

test('a one-sound take collapses to a single label', () => {
  const r = (s) => mulberry32(s);
  const placed = seq([kickSig(r(41)), kickSig(r(42)), kickSig(r(43)), kickSig(r(44))], 0.45);
  const { events } = analyzeClip(buildClip(placed), SR);
  assert.equal(events.length, 4);
  assert.ok(events.every((e) => e.type === 'kick'), JSON.stringify(events.map((e) => e.type)));
});

test('long ringing hat-family hits become OPEN hats; short ones stay closed', () => {
  const r = (s) => mulberry32(s);
  const placed = seq([
    kickSig(r(71)), hatSig(r(72)), openHatSig(r(73)), hatSig(r(74)),
    kickSig(r(75)), hatSig(r(76)), openHatSig(r(77)), hatSig(r(78)),
  ], 0.45);
  const { events } = analyzeClip(buildClip(placed, 5), SR);
  assert.equal(events.length, 8);
  const expected = ['kick', 'hat', 'openhat', 'hat', 'kick', 'hat', 'openhat', 'hat'];
  events.forEach((e, i) => assert.equal(e.type, expected[i], `hit ${i}: ${e.type} ≠ ${expected[i]}`));
  // kicks ring a while too, but only the hat family splits on duration
  assert.ok(events.every((e, i) => i % 4 !== 0 || e.type === 'kick'));
});

test('in a busy beat, a hat still ringing at the next hit is OPEN (ratio rule)', () => {
  const r = (s) => mulberry32(s);
  // gap 0.24 s; the "openish" hat rings ~0.12 s measured (below the
  // absolute 0.15 s rule) but through ~50% of the gap — context says open
  const openishHat = (rand) => bandSig(rand, 5500, 12000, 320, 14, 12000);
  const placed = seq([
    kickSig(r(101)), hatSig(r(102)), openishHat(r(103)), hatSig(r(104)),
    kickSig(r(105)), hatSig(r(106)), openishHat(r(107)), hatSig(r(108)),
  ], 0.24);
  const { events } = analyzeClip(buildClip(placed, 4), SR);
  assert.equal(events.length, 8);
  const expected = ['kick', 'hat', 'openhat', 'hat', 'kick', 'hat', 'openhat', 'hat'];
  events.forEach((e, i) => assert.equal(e.type, expected[i], `hit ${i}: ${e.type} ≠ ${expected[i]}`));
});

test('dynamics span a wide range: ghosts are quiet, accents are loud', () => {
  const r = (s) => mulberry32(s);
  const placed = [
    [0.5, kickSig(r(81)), 1.0],
    [1.0, kickSig(r(82)), 0.15], // ghost note
    [1.5, kickSig(r(83)), 1.0],
  ];
  const { events } = analyzeClip(buildClip(placed), SR);
  assert.equal(events.length, 3);
  assert.ok(events[0].velocity > 0.9, `accent should be near full: ${events[0].velocity}`);
  assert.ok(events[1].velocity < 0.45, `ghost should be quiet: ${events[1].velocity}`);
});

test('velocity follows relative loudness within the clip', () => {
  const r = (s) => mulberry32(s);
  const placed = [
    [0.5, kickSig(r(51)), 1.0],
    [1.0, kickSig(r(52)), 0.35],
    [1.5, kickSig(r(53)), 1.0],
  ];
  const { events } = analyzeClip(buildClip(placed), SR);
  assert.equal(events.length, 3);
  assert.ok(events[1].velocity < events[0].velocity - 0.15, `soft hit not softer: ${JSON.stringify(events.map((e) => e.velocity))}`);
});

test('silence and pure noise yield no events', () => {
  assert.deepEqual(analyzeClip(new Float32Array(SR * 2), SR), { events: [], sounds: 0 });
  const rand = mulberry32(77);
  const noise = new Float32Array(SR * 2);
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() * 2 - 1) * 0.002;
  assert.deepEqual(analyzeClip(noise, SR), { events: [], sounds: 0 });
});

/* ---------- simulated phone-mic voice (the field failure mode) ---------- */

function highpass(sig, fc = 200) {
  const out = new Float32Array(sig.length);
  const rc = 1 / (2 * Math.PI * fc);
  const dt = 1 / SR;
  const a = rc / (rc + dt);
  let y = 0;
  let xPrev = 0;
  for (let i = 0; i < sig.length; i++) {
    y = a * (y + sig[i] - xPrev);
    xPrev = sig[i];
    out[i] = y;
  }
  return out;
}

function addBreath(sig, rand, amt = 0.05) {
  const out = sig.slice();
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / SR;
    lp = lp * 0.7 + (rand() * 2 - 1) * 0.3;
    out[i] += lp * amt * Math.exp(-t * 10);
  }
  return out;
}

// phone kick: mid-heavy "b" — phone mics keep 200–500 Hz, not the sub
function phoneKickSig(rand, len = 4000) {
  const out = new Float32Array(len);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 120 + 260 * Math.exp(-t * 90);
    phase += (2 * Math.PI * f) / SR;
    out[i] = 0.8 * Math.sin(phase) * Math.exp(-t * 18);
    if (i < 90) out[i] += 0.3 * (rand() * 2 - 1);
  }
  return out;
}

const phonify = (sig, rand) => addBreath(highpass(sig), rand);

test('REGRESSION: a phone-mic-style take must NOT collapse into all hats', () => {
  const r = (s) => mulberry32(s);
  const ph = (sig, seed) => phonify(sig, mulberry32(seed + 500));
  const placed = seq([
    ph(phoneKickSig(r(91)), 91), ph(hatSig(r(92)), 92), ph(snareSig(r(93)), 93), ph(hatSig(r(94)), 94),
    ph(phoneKickSig(r(95)), 95), ph(hatSig(r(96)), 96), ph(snareSig(r(97)), 97), ph(hatSig(r(98)), 98),
  ], 0.35);
  const { events, sounds } = analyzeClip(buildClip(placed, 4), SR);
  assert.equal(events.length, 8);
  assert.equal(sounds, 3, `should hear 3 distinct sounds, heard ${sounds}`);
  const expected = ['kick', 'hat', 'snare', 'hat', 'kick', 'hat', 'snare', 'hat'];
  events.forEach((e, i) => assert.equal(e.type, expected[i], `hit ${i}: ${e.type} ≠ ${expected[i]}`));
});

test('detectOnsets enforces minimum separation', () => {
  const r = (s) => mulberry32(s);
  // two hits 50 ms apart → closer than the 90 ms minimum → one onset
  const clip = buildClip([[0.5, kickSig(r(61))], [0.55, kickSig(r(62))], [1.2, kickSig(r(63))]]);
  const onsets = detectOnsets(clip, SR);
  assert.equal(onsets.length, 2);
});

test('kmeans is deterministic and separates obvious clusters', () => {
  const pts = [
    [0, 0], [0.1, -0.1], [-0.1, 0.1],
    [5, 5], [5.1, 4.9], [4.9, 5.1],
  ];
  const a1 = kmeans(pts, 2);
  const a2 = kmeans(pts, 2);
  assert.deepEqual(a1, a2, 'kmeans must be deterministic');
  assert.equal(new Set(a1.slice(0, 3)).size, 1);
  assert.equal(new Set(a1.slice(3)).size, 1);
  assert.notEqual(a1[0], a1[3]);
});
