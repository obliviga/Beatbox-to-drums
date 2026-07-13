import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHit, classifyHit } from '../../js/classifier.js';

const SR = 48000;
const N = 1024;

// Deterministic PRNG so CI never flakes
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sum of random-phase sines between f0..f1 — band-limited "noise". */
function bandNoise(f0, f1, step, rand, decay = 20) {
  const out = new Float32Array(N);
  const phases = [];
  const freqs = [];
  for (let f = f0; f <= f1; f += step) {
    freqs.push(f);
    phases.push(rand() * 2 * Math.PI);
  }
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < freqs.length; k++) {
      v += Math.sin(2 * Math.PI * freqs[k] * t + phases[k]);
    }
    out[i] = (v / freqs.length) * Math.exp(-t * decay);
  }
  return out;
}

/** Beatbox-kick-like: low sine drop plus a tiny broadband click. */
function kickLike(rand) {
  const out = new Float32Array(N);
  let phase = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = 60 + 60 * Math.exp(-t * 90); // 120 Hz → 60 Hz
    phase += (2 * Math.PI * f) / SR;
    out[i] = 0.8 * Math.sin(phase) * Math.exp(-t * 18);
    if (i < 48) out[i] += 0.15 * (rand() * 2 - 1);
  }
  return out;
}

test('silence yields no classification', () => {
  assert.equal(analyzeHit(new Float32Array(N), SR), null);
  assert.equal(classifyHit(null), null);
});

test('spectral centroid of a pure 1 kHz tone is ~1 kHz', () => {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) buf[i] = Math.sin((2 * Math.PI * 1000 * i) / SR);
  const f = analyzeHit(buf, SR);
  assert.ok(Math.abs(f.centroid - 1000) < 100, `centroid ${f.centroid} not ~1000`);
});

test('low sine drop with click classifies as kick', () => {
  const f = analyzeHit(kickLike(mulberry32(1)), SR);
  assert.equal(classifyHit(f), 'kick', JSON.stringify(f));
});

test('broadband mid burst classifies as snare', () => {
  const f = analyzeHit(bandNoise(400, 2800, 100, mulberry32(2)), SR);
  assert.equal(classifyHit(f), 'snare', JSON.stringify(f));
});

test('bright sibilant burst classifies as hat', () => {
  const f = analyzeHit(bandNoise(5000, 11000, 250, mulberry32(3), 30), SR);
  assert.equal(classifyHit(f), 'hat', JSON.stringify(f));
});

test('band ratios sum to ~1', () => {
  const f = analyzeHit(bandNoise(200, 8000, 200, mulberry32(4)), SR);
  assert.ok(Math.abs(f.low + f.mid + f.high - 1) < 1e-6);
});
