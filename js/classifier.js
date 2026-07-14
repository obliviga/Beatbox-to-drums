/**
 * Hit classifier — turns a captured attack window (raw samples from the
 * onset worklet) into a drum label: 'kick' | 'snare' | 'hat'.
 *
 * Typical beatbox sounds, close-mic'd:
 *   kick  “B”/“Puh”  — lip plosive: energy below ~250 Hz, dark centroid, low ZCR
 *   snare “Pss”/“Ka” — broadband burst: mid centroid (~1–3 kHz)
 *   hat   “Ts”/“T”   — sibilant: bright centroid (>3 kHz), high zero-crossing rate
 *
 * The thresholds below encode those shapes. They're deliberately a readable
 * rule tree (not a trained model) so they're easy to tune — see README.
 */

const FFT_SIZE = 2048;

// Band edges (Hz) and decision thresholds
const LOW_BAND_HZ = 250;
const HIGH_BAND_HZ = 3000;
const HAT_CENTROID_HZ = 3000;
const HAT_ZCR = 0.22;      // fraction of sample pairs that cross zero
const HAT_HIGH_RATIO = 0.5;
const KICK_LOW_RATIO_STRONG = 0.5;
const KICK_CENTROID_HZ = 1100;
const KICK_LOW_RATIO = 0.2;

/**
 * Extract spectral/temporal features from an attack window.
 * @param {Float32Array} samples — captured attack (≤ FFT_SIZE samples)
 * @param {number} sampleRate
 * @returns {{centroid:number, zcr:number, low:number, mid:number, high:number}|null}
 */
export function analyzeHit(samples, sampleRate) {
  // Zero-crossing rate (cheap noisiness measure; sibilants score high)
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] < 0) !== (samples[i] < 0)) crossings++;
  }
  const zcr = crossings / samples.length;

  // Hann-windowed, zero-padded FFT
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const n = Math.min(samples.length, FFT_SIZE);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = samples[i] * w;
  }
  fft(re, im);

  const binHz = sampleRate / FFT_SIZE;
  const bins = FFT_SIZE / 2;
  let total = 0;
  let weighted = 0;
  let low = 0;
  let mid = 0;
  let high = 0;
  let logSum = 0;
  for (let k = 1; k < bins; k++) {
    const power = re[k] * re[k] + im[k] * im[k];
    const freq = k * binHz;
    total += power;
    weighted += freq * power;
    logSum += Math.log(power + 1e-12);
    if (freq < LOW_BAND_HZ) low += power;
    else if (freq < HIGH_BAND_HZ) mid += power;
    else high += power;
  }
  if (total < 1e-10) return null;

  // spectral flatness: geometric / arithmetic mean (1 = noise, ~0 = tonal)
  const flatness = Math.exp(logSum / (bins - 1)) / (total / (bins - 1) + 1e-12);

  // 85% rolloff: frequency below which most of the energy sits
  let cum = 0;
  let rolloff = binHz * (bins - 1);
  for (let k = 1; k < bins; k++) {
    cum += re[k] * re[k] + im[k] * im[k];
    if (cum >= 0.85 * total) {
      rolloff = k * binHz;
      break;
    }
  }

  return {
    centroid: weighted / total,
    zcr,
    low: low / total,
    mid: mid / total,
    high: high / total,
    flatness,
    rolloff,
  };
}

/**
 * Map features to a drum. Order matters:
 * dominant bass wins first, then brightness/noisiness, then dark-ish
 * bass-leaning hits; everything else lands on the snare.
 * @returns {'kick'|'snare'|'hat'|null}
 */
export function classifyHit(features) {
  if (!features) return null;
  const { centroid, zcr, low, high } = features;
  if (low >= KICK_LOW_RATIO_STRONG) return 'kick';
  if (centroid >= HAT_CENTROID_HZ || zcr >= HAT_ZCR || high >= HAT_HIGH_RATIO) return 'hat';
  if (centroid <= KICK_CENTROID_HZ && low >= KICK_LOW_RATIO) return 'kick';
  return 'snare';
}

/* ---------- personal voice profile (on-device learning) ----------
 *
 * The rule tree above encodes a *typical* voice. Everyone's "B"/"Pss"/"Ts"
 * differs, so the app can learn yours: a few labelled examples per drum
 * become a z-score-normalized k-nearest-neighbor model — trained in
 * microseconds, stored locally, and far more accurate than fixed
 * thresholds because it's fitted to the person actually beatboxing.
 */

/** Feature vector used by the learned classifier. */
export function featureVector(f) {
  return [f.centroid, f.zcr, f.low, f.mid, f.high, f.flatness || 0, f.rolloff || 0];
}

/**
 * Build a profile from labelled examples.
 * @param {{label:'kick'|'snare'|'hat', features:object}[]} examples
 * @returns {{mean:number[], std:number[], examples:{label:string, vec:number[]}[]}|null}
 */
export function buildProfile(examples) {
  if (!examples || examples.length < 3) return null;
  const vecs = examples.map((e) => featureVector(e.features));
  const dims = vecs[0].length;
  const mean = new Array(dims).fill(0);
  const std = new Array(dims).fill(0);
  for (const v of vecs) for (let d = 0; d < dims; d++) mean[d] += v[d];
  for (let d = 0; d < dims; d++) mean[d] /= vecs.length;
  for (const v of vecs) for (let d = 0; d < dims; d++) std[d] += (v[d] - mean[d]) ** 2;
  for (let d = 0; d < dims; d++) std[d] = Math.max(Math.sqrt(std[d] / vecs.length), 1e-6);
  const norm = (v) => v.map((x, d) => (x - mean[d]) / std[d]);
  return {
    mean,
    std,
    examples: examples.map((e, i) => ({ label: e.label, vec: norm(vecs[i]) })),
  };
}

/**
 * Distance-weighted k-NN against a profile.
 * @returns {'kick'|'snare'|'hat'|null}
 */
export function classifyWithProfile(features, profile, k = 3) {
  if (!features || !profile || !profile.examples || !profile.examples.length) return null;
  const vec = featureVector(features).map((x, d) => (x - profile.mean[d]) / profile.std[d]);
  const scored = profile.examples
    .map((e) => {
      let dist = 0;
      for (let d = 0; d < vec.length; d++) dist += (vec[d] - e.vec[d]) ** 2;
      return { label: e.label, dist: Math.sqrt(dist) };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, Math.min(k, profile.examples.length));
  const votes = {};
  for (const s of scored) votes[s.label] = (votes[s.label] || 0) + 1 / (s.dist + 1e-3);
  let best = null;
  let bestScore = -1;
  for (const [label, score] of Object.entries(votes)) {
    if (score > bestScore) { best = label; bestScore = score; }
  }
  return best;
}

/** In-place iterative radix-2 Cooley–Tukey FFT. Lengths must be powers of 2. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}
