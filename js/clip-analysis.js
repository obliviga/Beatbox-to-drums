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
// Feature window: 43 ms of BODY, not just the attack. Through a phone mic
// the first 20 ms of every mouth sound is broadband pop/hiss — a kick only
// reveals itself once its body develops. Offline analysis can afford this.
const BODY_SAMPLES = 2048;
const LOW_WINDOW_SEC = 0.08;     // bass-ratio measurement window (80 ms)
const MIN_SEP_SEC = 0.09;        // two hits can't be closer than this
const PEAK_WINDOW_SEC = 0.06;    // where a hit's peak/energy (velocity) is measured
// Open-hat rules (context-aware): a hat is open if it rings a while in
// absolute terms, OR if it's still ringing when the next hit arrives —
// in a busy beat the next hit always cuts the measurement short, so the
// ratio is the signal, not the absolute length.
const OPEN_HAT_SEC = 0.15;
const OPEN_HAT_GAP_FRAC = 0.45;  // ringing through 45%+ of the gap to the next hit
const OPEN_HAT_MIN_GAP = 0.18;   // …but never for rapid closed-hat runs

// Fixed per-feature scale for SEMANTIC distances (are two clusters the
// same instrument?). Re-measured with the body-window + bass-ratio
// features on clean AND simulated phone-mic voices: variants of one
// instrument land ≤ ~0.8 apart, different instruments ≥ ~1.9 — including
// the high-passed, breathy phone case that used to collapse.
// Dims: [centroid, zcr, low, mid, high, flatness, rolloff, low80,
//        lowPitch, duration]
// lowPitch = low-band zero-crossing rate (amplitude-gated, bass-gated) —
// the fundamental that separates kicks (~60–90 Hz) from toms (~150–250 Hz).
// duration separates short clicks (rimshots) from ringing sounds.
const FEATURE_SCALE = [1500, 0.15, 0.25, 0.3, 0.25, 0.25, 3000, 0.25, 0.0015, 0.05];
const MERGE_DIST_FIXED = 1.3; // mean scaled distance to merge two clusters
// Categorical cues where a hard single-dimension difference means a
// DIFFERENT drum even when the spectra agree: low pitch (kick vs tom)
// and ring length (rimshot vs snare). Spectral dims are exempt because
// variants of one instrument legitimately vary there.
const MERGE_VETO_DIMS = [8, 9];
const MERGE_VETO_LIMIT = 1.2;

// How many distinct sounds the clustering may discover. The actual count
// is chosen by the data (silhouette score), not fixed.
const MAX_SOUNDS = 6;
const MIN_SILHOUETTE = 0.3; // below this, the take is one repeated sound

const CRASH_SEC = 0.45; // hat-family hits ringing this long are crashes

/**
 * @param {Float32Array} samples — the whole take, mono
 * @param {number} sampleRate
 * @returns {{events: {t:number, type:string, velocity:number, duration:number}[],
 *            sounds: number}} — sounds = distinct sound groups heard
 */
export function analyzeClip(samples, sampleRate) {
  const onsets = detectOnsets(samples, sampleRate);
  if (!onsets.length) return { events: [], sounds: 0 };

  const hits = [];
  let clipPeak = 1e-6;
  let clipRms = 1e-6;
  for (const onset of onsets) {
    const body = new Float32Array(BODY_SAMPLES);
    body.set(samples.subarray(onset.index, Math.min(onset.index + BODY_SAMPLES, samples.length)));
    const features = analyzeHit(body, sampleRate);
    if (!features) continue;
    if (onset.peak > clipPeak) clipPeak = onset.peak;
    if (onset.rms > clipRms) clipRms = onset.rms;
    const lowFeats = lowBandFeatures(samples, onset.index, sampleRate);
    hits.push({
      t: onset.index / sampleRate,
      peak: onset.peak,
      rms: onset.rms,
      duration: onset.duration,
      features,
      low80: lowFeats.ratio,
      lowZcr: lowFeats.zcr,
    });
  }
  if (!hits.length) return { events: [], sounds: 0 };

  const { labels, sounds } = labelHits(hits);
  const events = hits.map((h, i) => {
    // Dynamics relative to the take itself, from both peak (attack snap)
    // and energy (body): ghost notes come out genuinely quiet, accents
    // genuinely loud, instead of everything landing mid-strength.
    const loud = 0.55 * (h.peak / clipPeak) + 0.45 * Math.sqrt(h.rms / clipRms);
    // Hat-family articulation from ring length: a very long ring is a
    // CRASH; a hit still sounding when the next arrives is an OPEN hat.
    const gap = i + 1 < hits.length ? hits[i + 1].t - h.t : Infinity;
    const rings = h.duration >= OPEN_HAT_SEC
      || (gap >= OPEN_HAT_MIN_GAP && h.duration >= OPEN_HAT_GAP_FRAC * Math.min(gap, 0.5));
    let type = labels[i];
    if (type === 'hat') {
      if (h.duration >= CRASH_SEC) type = 'crash';
      else if (rings) type = 'openhat';
    }
    return {
      t: h.t,
      type,
      velocity: Math.min(1, Math.max(0.1, 0.1 + 0.9 * loud)),
      duration: h.duration,
    };
  });
  return { events, sounds };
}

/**
 * Low-band features over the hit's first 80 ms, from a one-pole ~250 Hz
 * lowpass: `ratio` = low energy / total (kick vs everything, even through
 * phone mics), and `zcr` = zero-crossing rate of the lowpassed signal —
 * effectively the PITCH of the low band, which separates kicks (~60–90 Hz)
 * from toms (~150–250 Hz).
 */
export function lowBandFeatures(samples, index, sampleRate) {
  const n = Math.min(Math.round(LOW_WINDOW_SEC * sampleRate), samples.length - index);
  if (n <= 0) return { ratio: 0, zcr: 0 };
  const a = 1 - Math.exp((-2 * Math.PI * 250) / sampleRate);
  // pass 1: lowpass, energies, and the low-band peak for the gate
  const low = new Float32Array(n);
  let y = 0;
  let lowE = 0;
  let totE = 0;
  let lowPeak = 0;
  for (let i = 0; i < n; i++) {
    y += a * (samples[index + i] - y);
    low[i] = y;
    lowE += y * y;
    totE += samples[index + i] * samples[index + i];
    const ay = y < 0 ? -y : y;
    if (ay > lowPeak) lowPeak = ay;
  }
  // pass 2: crossings counted only while the low band is actually
  // sounding — after the attack (click/pop) and while the local ENVELOPE
  // is above the gate (instantaneous amplitude is ~0 at every crossing,
  // so gating on it would skip exactly the samples we're counting)
  const skip = Math.min(Math.round(0.008 * sampleRate), n - 1);
  const gate = lowPeak * 0.15;
  const envA = 1 - Math.exp(-1 / (0.005 * sampleRate));
  let envY = 0;
  let crossings = 0;
  let counted = 0;
  for (let i = 1; i < n; i++) {
    const ay = low[i] < 0 ? -low[i] : low[i];
    envY += envA * (ay - envY);
    if (i <= skip || envY < gate) continue;
    counted++;
    if ((low[i - 1] < 0) !== (low[i] < 0)) crossings++;
  }
  return {
    ratio: totE > 1e-12 ? lowE / totE : 0,
    zcr: counted > 0 ? crossings / counted : 0,
  };
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
  // slightly hair-triggered so ghost notes make it into the beat — the
  // clustering downstream is tolerant of the occasional soft extra
  const novThr = Math.max(medianNov * 3, peakEnv * 0.04);
  const envThr = Math.max(0.003, peakEnv * 0.055);

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
    let energy = 0;
    const end = Math.min(index + peakWin, samples.length);
    for (let i = index; i < end; i++) {
      const a = samples[i] < 0 ? -samples[i] : samples[i];
      if (a > peak) peak = a;
      energy += samples[i] * samples[i];
    }
    const rms = Math.sqrt(energy / Math.max(1, end - index));

    const prev = onsets[onsets.length - 1];
    if (prev && f - prev.frame < minSepFrames) {
      if (nov[f] > prev.nov) onsets[onsets.length - 1] = { frame: f, index, peak, rms, nov: nov[f] };
      continue;
    }
    onsets.push({ frame: f, index, peak, rms, nov: nov[f] });
  }

  // Decay duration per hit — how long it keeps ringing (open vs closed
  // hats live here). Measured until the envelope falls well below the
  // hit's own peak, or the next hit starts.
  for (let i = 0; i < onsets.length; i++) {
    const startF = onsets[i].frame;
    const endF = i + 1 < onsets.length ? onsets[i + 1].frame : nFrames;
    let hitPeakEnv = 0;
    for (let f = startF; f < Math.min(startF + 6, endF); f++) {
      if (env[f] > hitPeakEnv) hitPeakEnv = env[f];
    }
    // breathy open-hat tails are quiet — use a low floor so audible
    // sustain still counts as ringing
    const floor = Math.max(envThr * 0.7, hitPeakEnv * 0.1);
    let f = startF;
    while (f < endF && env[f] >= floor) f++;
    onsets[i].duration = ((f - startF) * FRAME) / sampleRate;
  }
  return onsets;
}

/* ---------- clustering + labeling ---------- */

function labelHits(hits) {
  if (hits.length === 1) {
    return { labels: [classifyHit(hits[0].features) || 'snare'], sounds: 1 };
  }

  // Two spaces, two jobs:
  //  z-space (per-clip standardized) → clustering geometry that adapts to
  //    any voice, however compressed its feature range is;
  //  fixed scale → semantic "same instrument?" distances for merging.
  // The vector is the spectral profile of the hit's BODY plus the 80 ms
  // bass ratio — evidence that survives phone-mic bass rolloff.
  // lowPitch only exists for genuinely bass-carrying sounds; for
  // everything else it's 0 so it can neither split nor block merging
  const lowPitch = (h) => ((h.low80 || 0) >= 0.2 ? h.lowZcr || 0 : 0);
  const vecs = hits.map((h) => [
    ...featureVector(h.features), h.low80 || 0, lowPitch(h), h.duration || 0,
  ]);
  const fixed = vecs.map((v) => v.map((x, d) => x / FEATURE_SCALE[d]));
  const dims = vecs[0].length;
  const mean = new Array(dims).fill(0);
  const std = new Array(dims).fill(0);
  for (const v of vecs) for (let d = 0; d < dims; d++) mean[d] += v[d];
  for (let d = 0; d < dims; d++) mean[d] /= vecs.length;
  for (const v of vecs) for (let d = 0; d < dims; d++) std[d] += (v[d] - mean[d]) ** 2;
  for (let d = 0; d < dims; d++) std[d] = Math.max(Math.sqrt(std[d] / vecs.length), 1e-6);
  const z = vecs.map((v) => v.map((x, d) => (x - mean[d]) / std[d]));

  // How many distinct sounds did this person actually make? Try every
  // cluster count and let the silhouette score decide — a beatboxer using
  // five different mouth sounds gets five clusters, not a forced three.
  const maxK = Math.min(MAX_SOUNDS, hits.length - 1);
  let assignment = hits.map(() => 0);
  let bestSil = -1;
  for (let k = 2; k <= maxK; k++) {
    const cand = kmeans(z, k);
    const sil = silhouette(z, cand);
    if (sil > bestSil + 1e-9) {
      bestSil = sil;
      assignment = cand;
    }
  }
  if (bestSil < MIN_SILHOUETTE) assignment = hits.map(() => 0); // one repeated sound
  assignment = mergeCloseClusters(fixed, assignment);

  // group members per cluster
  const clusterIds = [...new Set(assignment)];
  const clusters = clusterIds.map((id) => {
    const members = [];
    assignment.forEach((a, i) => { if (a === id) members.push(i); });
    return { id, members };
  });

  // per-cluster profile: rule-tree votes, mean features, bass, ring, click
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
    c.low80 = c.members.reduce((s, i) => s + (hits[i].low80 || 0), 0) / c.members.length;
    c.lowZcr = c.members.reduce((s, i) => s + (hits[i].lowZcr || 0), 0) / c.members.length;
    c.durMean = c.members.reduce((s, i) => s + (hits[i].duration || 0), 0) / c.members.length;
    c.vote = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0]
      || classifyHit(meanF) || 'snare';
    c.bright = meanF.centroid / 1000 + meanF.rolloff / 3000 + meanF.zcr * 8
      - meanF.low * 6 - c.low80 * 8;
  }

  assignLabels(clusters);

  const byId = new Map(clusters.map((c) => [c.id, c.label]));
  return { labels: assignment.map((id) => byId.get(id)), sounds: clusters.length };
}

/**
 * Map sound clusters to the kit. Decisions are relative-first (this
 * take's darkest bass sound is the kick, its brightest noise is the
 * hats), with instrument character deciding the middle ground:
 * tonal & low → toms, short clicky → rimshot, broadband → snare.
 */
function assignLabels(clusters) {
  clusters.sort((a, b) => a.bright - b.bright);
  const n = clusters.length;
  if (n === 1) {
    clusters[0].label = clusters[0].vote;
    return;
  }

  // brightest = the hat family (per-hit ring splits closed/open/crash) —
  // but only if it's genuinely bright/noisy; a kick+tom take has no hats
  const top = clusters[n - 1];
  if (top.meanF.centroid >= 2500 || top.meanF.zcr >= 0.18 || top.vote === 'hat') {
    top.label = 'hat';
  }

  // darkest = kick, if it's genuinely bass-heavy — absolutely, or clearly
  // relative to everything else (phone mics kill absolute bass)
  const dark = clusters[0];
  const otherLow = clusters.slice(1).map((c) => c.low80).sort((a, b) => a - b);
  const medianOtherLow = otherLow[Math.floor(otherLow.length / 2)] || 0;
  if (!dark.label
    && (dark.low80 >= 0.3 || dark.meanF.centroid < 800 || dark.low80 >= 2.5 * medianOtherLow + 0.05)) {
    dark.label = 'kick';
  }

  // middles: instrument character decides
  const toms = [];
  for (const c of clusters) {
    if (c.label) continue;
    const tonal = c.meanF.flatness < 0.22;
    if (tonal && c.meanF.centroid < 1100 && c.low80 >= 0.12) {
      toms.push(c); // low & tonal → tom family (floor vs rack decided below)
    } else if (c.meanF.centroid >= 3200 || c.meanF.zcr >= 0.25) {
      c.label = 'hat'; // a second bright sibilant sound is still a hat
    } else if (c.durMean < 0.06 && c.meanF.centroid >= 900 && c.meanF.centroid < 4200) {
      c.label = 'rimshot'; // short clicky "k"
    } else {
      c.label = 'snare';
    }
  }
  toms.forEach((c, i) => {
    c.label = toms.length >= 2 && i === 0 ? 'tomfloor' : 'tom';
  });
}

/** Mean silhouette score of a clustering (z-space). Higher = better fit. */
export function silhouette(points, assignment) {
  const ids = [...new Set(assignment)];
  if (ids.length < 2) return 0;
  const byCluster = new Map(ids.map((id) => [id, []]));
  assignment.forEach((id, i) => byCluster.get(id).push(i));
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const own = byCluster.get(assignment[i]);
    if (own.length <= 1) continue; // singleton contributes 0
    let a = 0;
    for (const j of own) if (j !== i) a += Math.sqrt(dist2(points[i], points[j]));
    a /= own.length - 1;
    let b = Infinity;
    for (const id of ids) {
      if (id === assignment[i]) continue;
      const other = byCluster.get(id);
      let d = 0;
      for (const j of other) d += Math.sqrt(dist2(points[i], points[j]));
      d /= other.length;
      if (d < b) b = d;
    }
    total += (b - a) / Math.max(a, b, 1e-12);
  }
  return total / points.length;
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
        const ca = centers.get(ids[a]);
        const cb = centers.get(ids[b]);
        const d = Math.sqrt(dist2(ca, cb) / dims);
        let veto = 0;
        for (const dd of MERGE_VETO_DIMS) {
          const diff = Math.abs(ca[dd] - cb[dd]);
          if (diff > veto) veto = diff;
        }
        if (!closest || d < closest.d) closest = { a: ids[a], b: ids[b], d, veto };
      }
    }
    // merge when close on average, unless a categorical cue (low pitch,
    // ring length) says these are different drums with similar spectra
    if (!closest || closest.d > MERGE_DIST_FIXED || closest.veto > MERGE_VETO_LIMIT) return merged;
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
