/**
 * Clip analysis — converts a whole recorded take into drum events using
 * the context of the entire clip, with no training and no fixed
 * per-voice thresholds.
 *
 * 1. Onsets are detected over the full clip with thresholds derived from
 *    the clip itself (fractions of its peak envelope / novelty medians),
 *    so quiet and loud recordings behave identically.
 * 2. Every hit's spectral features are extracted, then the hits are
 *    CLUSTERED (k-means, k ≤ 3, z-scored within the clip): a person's
 *    kicks resemble each other far more than they resemble any fixed
 *    template. Similar clusters are merged, so two- or one-sound takes
 *    work naturally.
 * 3. Clusters get drum labels by majority vote of the generic rule tree
 *    over their members, with conflicts resolved by relative brightness
 *    ordering (darkest → kick, brightest → hat). One mispronounced hit
 *    is outvoted by its cluster siblings — that's the context doing the
 *    correcting.
 * 4. Velocity is relative to the clip's own loudest hit.
 *
 * Pure functions — unit-tested in Node against synthesized takes.
 */

import { analyzeHit, classifyHit, featureVector } from './classifier.js';

const FRAME = 128;               // envelope hop (~2.7 ms @ 48 kHz)
const ATTACK_SAMPLES = 1024;     // same window the live path classifies on
const MIN_SEP_SEC = 0.09;        // two hits can't be closer than this
const PEAK_WINDOW_SEC = 0.06;    // where a hit's peak (velocity) is measured
const LABEL_ORDER = ['kick', 'snare', 'hat']; // dark → bright

// Fixed per-feature scale for SEMANTIC distances (are two clusters the
// same instrument?). Measured on synthesized voices: variants of one
// instrument land ≤ ~0.9 apart, different instruments ≥ ~2.0.
const FEATURE_SCALE = [1500, 0.15, 0.25, 0.3, 0.25, 0.25, 3000];
const MERGE_DIST_FIXED = 1.3;

/**
 * @param {Float32Array} samples — the whole take, mono
 * @param {number} sampleRate
 * @returns {{t:number, type:'kick'|'snare'|'hat', velocity:number}[]}
 */
export function analyzeClip(samples, sampleRate) {
  const onsets = detectOnsets(samples, sampleRate);
  if (!onsets.length) return [];

  const hits = [];
  let clipPeak = 1e-6;
  for (const onset of onsets) {
    const attack = new Float32Array(ATTACK_SAMPLES);
    attack.set(samples.subarray(onset.index, Math.min(onset.index + ATTACK_SAMPLES, samples.length)));
    const features = analyzeHit(attack, sampleRate);
    if (!features) continue;
    if (onset.peak > clipPeak) clipPeak = onset.peak;
    hits.push({ t: onset.index / sampleRate, peak: onset.peak, features });
  }
  if (!hits.length) return [];

  const labels = labelHits(hits);
  return hits.map((h, i) => ({
    t: h.t,
    type: labels[i],
    velocity: Math.min(1, 0.35 + 0.65 * (h.peak / clipPeak)),
  }));
}

/* ---------- onset detection (context-adaptive) ---------- */

export function detectOnsets(samples, sampleRate) {
  const nFrames = Math.floor(samples.length / FRAME);
  if (nFrames < 4) return [];

  const env = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const base = f * FRAME;
    for (let i = 0; i < FRAME; i++) {
      const v = samples[base + i];
      sum += v * v;
    }
    env[f] = Math.sqrt(sum / FRAME);
  }

  // novelty = rectified energy rise vs the recent past
  const nov = new Float32Array(nFrames);
  let peakEnv = 0;
  for (let f = 2; f < nFrames; f++) {
    const past = Math.max(env[f - 1], env[f - 2]);
    nov[f] = Math.max(0, env[f] - past);
    if (env[f] > peakEnv) peakEnv = env[f];
  }
  if (peakEnv < 1e-4) return []; // effectively silence

  // thresholds from the clip's own statistics
  const positives = [];
  for (let f = 0; f < nFrames; f++) if (nov[f] > 0) positives.push(nov[f]);
  positives.sort((a, b) => a - b);
  const medianNov = positives.length ? positives[Math.floor(positives.length / 2)] : 0;
  const novThr = Math.max(medianNov * 3, peakEnv * 0.05);
  const envThr = Math.max(0.003, peakEnv * 0.07);

  const minSepFrames = Math.round((MIN_SEP_SEC * sampleRate) / FRAME);
  const peakWin = Math.round(PEAK_WINDOW_SEC * sampleRate);
  const onsets = [];
  for (let f = 2; f < nFrames; f++) {
    if (nov[f] < novThr) continue;
    // local novelty maximum
    if (nov[f] < nov[f - 1] || (f + 1 < nFrames && nov[f] < nov[f + 1])) continue;
    if (env[f] < envThr && (f + 1 >= nFrames || env[f + 1] < envThr)) continue;

    const index = Math.max(0, (f - 1) * FRAME);
    let peak = 0;
    for (let i = index; i < Math.min(index + peakWin, samples.length); i++) {
      const a = samples[i] < 0 ? -samples[i] : samples[i];
      if (a > peak) peak = a;
    }

    const prev = onsets[onsets.length - 1];
    if (prev && f - prev.frame < minSepFrames) {
      if (nov[f] > prev.nov) onsets[onsets.length - 1] = { frame: f, index, peak, nov: nov[f] };
      continue;
    }
    onsets.push({ frame: f, index, peak, nov: nov[f] });
  }
  return onsets;
}

/* ---------- clustering + labeling ---------- */

function labelHits(hits) {
  if (hits.length === 1) {
    return [classifyHit(hits[0].features) || 'snare'];
  }

  // Two spaces, two jobs:
  //  z-space (per-clip standardized) → clustering geometry that adapts to
  //    any voice, however compressed its feature range is;
  //  fixed scale → semantic "same instrument?" distances for merging.
  const vecs = hits.map((h) => featureVector(h.features));
  const fixed = vecs.map((v) => v.map((x, d) => x / FEATURE_SCALE[d]));
  const dims = vecs[0].length;
  const mean = new Array(dims).fill(0);
  const std = new Array(dims).fill(0);
  for (const v of vecs) for (let d = 0; d < dims; d++) mean[d] += v[d];
  for (let d = 0; d < dims; d++) mean[d] /= vecs.length;
  for (const v of vecs) for (let d = 0; d < dims; d++) std[d] += (v[d] - mean[d]) ** 2;
  for (let d = 0; d < dims; d++) std[d] = Math.max(Math.sqrt(std[d] / vecs.length), 1e-6);
  const z = vecs.map((v) => v.map((x, d) => (x - mean[d]) / std[d]));

  const k = Math.min(3, hits.length);
  let assignment = kmeans(z, k);
  assignment = mergeCloseClusters(fixed, assignment);

  // group members per cluster
  const clusterIds = [...new Set(assignment)];
  const clusters = clusterIds.map((id) => {
    const members = [];
    assignment.forEach((a, i) => { if (a === id) members.push(i); });
    return { id, members };
  });

  // majority rule-tree vote per cluster, mean features for brightness
  for (const c of clusters) {
    const votes = {};
    const meanF = { centroid: 0, zcr: 0, low: 0, mid: 0, high: 0, flatness: 0, rolloff: 0 };
    for (const i of c.members) {
      const f = hits[i].features;
      const lab = classifyHit(f);
      if (lab) votes[lab] = (votes[lab] || 0) + 1;
      for (const key of Object.keys(meanF)) meanF[key] += f[key] || 0;
    }
    for (const key of Object.keys(meanF)) meanF[key] /= c.members.length;
    c.meanF = meanF;
    c.vote = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0]
      || classifyHit(meanF) || 'snare';
    c.bright = meanF.centroid / 1000 + meanF.rolloff / 3000 + meanF.zcr * 8 - meanF.low * 6;
  }

  // Labels must ascend with brightness (a brighter cluster never gets a
  // darker drum than a darker cluster):
  //  3 clusters → forced kick/snare/hat by brightness;
  //  2 clusters → best rank-ascending pair, votes first;
  //  1 cluster → its vote.
  clusters.sort((a, b) => a.bright - b.bright);
  if (clusters.length === 3) {
    clusters.forEach((c, i) => { c.label = LABEL_ORDER[i]; });
  } else if (clusters.length === 2) {
    const pairs = [['kick', 'snare'], ['kick', 'hat'], ['snare', 'hat']];
    let best = pairs[0];
    let bestScore = -Infinity;
    for (const pair of pairs) {
      let score = 0;
      pair.forEach((label, i) => {
        if (label === clusters[i].vote) score += 10;
        score -= Math.abs(LABEL_ORDER.indexOf(label) - i);
      });
      if (score > bestScore) { bestScore = score; best = pair; }
    }
    clusters.forEach((c, i) => { c.label = best[i]; });
  } else {
    clusters[0].label = clusters[0].vote;
  }

  const byId = new Map(clusters.map((c) => [c.id, c.label]));
  return assignment.map((id) => byId.get(id));
}

/** Deterministic k-means (k-means++ init from seeded PRNG, best of 3 runs). */
export function kmeans(points, k, iters = 30) {
  if (k <= 1 || points.length <= k) {
    return points.length <= k ? points.map((_, i) => i) : points.map(() => 0);
  }
  let best = null;
  let bestInertia = Infinity;
  for (let seed = 1; seed <= 3; seed++) {
    const { assignment, inertia } = kmeansOnce(points, k, iters, mulberry32(seed));
    if (inertia < bestInertia) {
      bestInertia = inertia;
      best = assignment;
    }
  }
  return best;
}

function kmeansOnce(points, k, iters, rand) {
  const dims = points[0].length;
  const centers = [points[Math.floor(rand() * points.length)].slice()];
  while (centers.length < k) {
    // k-means++: pick far points with probability ∝ distance²
    const d2 = points.map((p) => Math.min(...centers.map((c) => dist2(p, c))));
    const total = d2.reduce((a, b) => a + b, 0);
    if (total < 1e-12) {
      centers.push(points[Math.floor(rand() * points.length)].slice());
      continue;
    }
    let r = rand() * total;
    let idx = 0;
    while (idx < points.length - 1 && (r -= d2[idx]) > 0) idx++;
    centers.push(points[idx].slice());
  }

  let assignment = new Array(points.length).fill(0);
  for (let it = 0; it < iters; it++) {
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = dist2(points[i], centers[c]);
        if (d < bestD) { bestD = d; bestC = c; }
      }
      if (assignment[i] !== bestC) { assignment[i] = bestC; changed = true; }
    }
    for (let c = 0; c < k; c++) {
      const members = points.filter((_, i) => assignment[i] === c);
      if (!members.length) continue;
      for (let d = 0; d < dims; d++) {
        centers[c][d] = members.reduce((s, m) => s + m[d], 0) / members.length;
      }
    }
    if (!changed) break;
  }
  let inertia = 0;
  for (let i = 0; i < points.length; i++) inertia += dist2(points[i], centers[assignment[i]]);
  return { assignment, inertia };
}

function mergeCloseClusters(fixedPoints, assignment) {
  const dims = fixedPoints[0].length;
  let merged = assignment.slice();
  for (;;) {
    const ids = [...new Set(merged)];
    if (ids.length <= 1) return merged;
    const centers = new Map(ids.map((id) => {
      const members = fixedPoints.filter((_, i) => merged[i] === id);
      const c = new Array(dims).fill(0);
      for (const m of members) for (let d = 0; d < dims; d++) c[d] += m[d];
      return [id, c.map((x) => x / members.length)];
    }));
    let closest = null;
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const d = Math.sqrt(dist2(centers.get(ids[a]), centers.get(ids[b])) / dims);
        if (!closest || d < closest.d) closest = { a: ids[a], b: ids[b], d };
      }
    }
    if (!closest || closest.d > MERGE_DIST_FIXED) return merged;
    merged = merged.map((id) => (id === closest.b ? closest.a : id));
  }
}

function dist2(a, b) {
  let s = 0;
  for (let d = 0; d < a.length; d++) s += (a[d] - b[d]) ** 2;
  return s;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
