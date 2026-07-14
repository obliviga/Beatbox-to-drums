import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHit, buildProfile, classifyWithProfile, featureVector } from '../../js/classifier.js';

/**
 * End-to-end test of the "Tune to my voice" learner: synthesize one
 * person's kick/snare/hat sounds (with per-take variation), train the
 * k-NN profile on a few examples, then classify unseen takes.
 */

const SR = 48000;
const N = 1024;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// This "voice" has an unusual kick (brighter than typical, the kind of
// sound the generic rule tree can get wrong) — the learner should adapt.
function kickTake(rand) {
  const out = new Float32Array(N);
  let phase = 0;
  const f0 = 150 + rand() * 40; // bright-ish lip pop
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const f = f0 * 0.5 + f0 * Math.exp(-t * (70 + rand() * 5));
    phase += (2 * Math.PI * f) / SR;
    out[i] = 0.8 * Math.sin(phase) * Math.exp(-t * (15 + rand() * 5));
    if (i < 60) out[i] += 0.2 * (rand() * 2 - 1);
  }
  return out;
}

function bandTake(f0, f1, step, rand, decay) {
  const out = new Float32Array(N);
  const freqs = [];
  const phases = [];
  for (let f = f0; f <= f1; f += step) {
    freqs.push(f * (1 + (rand() - 0.5) * 0.06));
    phases.push(rand() * 2 * Math.PI);
  }
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < freqs.length; k++) v += Math.sin(2 * Math.PI * freqs[k] * t + phases[k]);
    out[i] = (v / freqs.length) * Math.exp(-t * decay);
  }
  return out;
}

const snareTake = (rand) => bandTake(500, 3200, 150, rand, 18 + rand() * 6);
const hatTake = (rand) => bandTake(5200, 11500, 300, rand, 25 + rand() * 8);

function makeExamples(count, seedBase) {
  const examples = [];
  for (let i = 0; i < count; i++) {
    examples.push({ label: 'kick', features: analyzeHit(kickTake(mulberry32(seedBase + i)), SR) });
    examples.push({ label: 'snare', features: analyzeHit(snareTake(mulberry32(seedBase + 100 + i)), SR) });
    examples.push({ label: 'hat', features: analyzeHit(hatTake(mulberry32(seedBase + 200 + i)), SR) });
  }
  return examples;
}

test('profile trains on a voice and classifies unseen takes correctly', () => {
  const profile = buildProfile(makeExamples(4, 1));
  assert.ok(profile);
  assert.equal(profile.examples.length, 12);

  for (let i = 0; i < 3; i++) {
    const seed = 50 + i;
    assert.equal(classifyWithProfile(analyzeHit(kickTake(mulberry32(seed)), SR), profile), 'kick');
    assert.equal(classifyWithProfile(analyzeHit(snareTake(mulberry32(seed + 100)), SR), profile), 'snare');
    assert.equal(classifyWithProfile(analyzeHit(hatTake(mulberry32(seed + 200)), SR), profile), 'hat');
  }
});

test('profile requires enough examples and handles empty input', () => {
  assert.equal(buildProfile([]), null);
  assert.equal(buildProfile(makeExamples(4, 1).slice(0, 2)), null);
  assert.equal(classifyWithProfile(null, buildProfile(makeExamples(4, 1))), null);
  assert.equal(classifyWithProfile(analyzeHit(kickTake(mulberry32(9)), SR), null), null);
});

test('feature vector includes the extended spectral features', () => {
  const f = analyzeHit(hatTake(mulberry32(3)), SR);
  assert.ok(f.flatness > 0, 'flatness missing');
  assert.ok(f.rolloff > 3000, `hat rolloff should be high, got ${f.rolloff}`);
  assert.equal(featureVector(f).length, 7);
  const kf = analyzeHit(kickTake(mulberry32(3)), SR);
  assert.ok(kf.rolloff < f.rolloff, 'kick rolloff should sit below hat rolloff');
});

test('profile survives a JSON round-trip (localStorage persistence)', () => {
  const profile = buildProfile(makeExamples(4, 7));
  const revived = JSON.parse(JSON.stringify(profile));
  const f = analyzeHit(snareTake(mulberry32(300)), SR);
  assert.equal(classifyWithProfile(f, revived), 'snare');
});
