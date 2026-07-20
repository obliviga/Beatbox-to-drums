/**
 * The ✨ AI engines. Two live in this file:
 *
 * 1. AUDIO GENERATOR (active in the UI) — generateAudio() sends the
 *    rendered drum conversion to Stability's Stable Audio 2.5
 *    (audio-to-audio, 44.1 kHz stereo) and returns one fully
 *    AI-generated, high-fidelity WAV that follows the user's performed
 *    rhythm. Browsers can't call api.stability.ai directly (no CORS),
 *    so requests go through the user's own tiny relay
 *    (worker/relay.js — a copy-paste Cloudflare Worker).
 *
 * 2. COMPOSER (dormant, kept unit-tested) — composeBeat() asks the
 *    Claude API to write a brand-new pattern as JSON for the sampled
 *    kit to perform. No audio leaves the device on this path.
 *
 * Privacy: the audio generator uploads the rendered drum loop (never
 * the raw voice recording), only when the user taps Generate, using
 * the user's own API key. Settings live in localStorage.
 */

const CONFIG_KEY = 'b2d-neural-v3';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const AUDIO_API_PATH = '/v2beta/audio/stable-audio-2/audio-to-audio';

export const AUDIO_MODEL = 'stable-audio-2.5'; // highest-fidelity tier
export const DEFAULT_STRENGTH = 0.65; // how far the AI may stray from the input
export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_PROMPT =
  'punchy studio drum break, acoustic kit, tight low end, crisp hi-hats, produced, high fidelity, no melody';

export const DRUM_TYPES = ['kick', 'snare', 'hat', 'openhat', 'tom', 'tomfloor', 'rimshot', 'crash'];

/** JSON schema the model's reply must match (structured outputs). */
export const BEAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['bpm', 'bars', 'events'],
  properties: {
    bpm: { type: 'number', description: 'Tempo in beats per minute' },
    bars: { type: 'integer', description: 'Length of the loop in 4/4 bars (1-8)' },
    events: {
      type: 'array',
      description: 'Every drum hit in the loop',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['t', 'type', 'velocity', 'roll'],
        properties: {
          t: { type: 'number', description: 'Time in beats from loop start (0 = downbeat of bar 1; 0.5 = an 8th later)' },
          type: { type: 'string', enum: DRUM_TYPES },
          velocity: { type: 'number', description: 'How hard the hit is, 0.05 (ghost) to 1 (accent)' },
          roll: { type: 'boolean', description: 'true only for a buzz/press roll on a snare-family drum' },
        },
      },
    },
  },
};

export function loadNeuralConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    return {
      relayUrl: typeof c.relayUrl === 'string' ? c.relayUrl : '',
      apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
      prompt: typeof c.prompt === 'string' && c.prompt.trim() ? c.prompt : DEFAULT_PROMPT,
      model: typeof c.model === 'string' && c.model.trim() ? c.model : DEFAULT_MODEL,
    };
  } catch {
    return { relayUrl: '', apiKey: '', prompt: DEFAULT_PROMPT, model: DEFAULT_MODEL };
  }
}

export function saveNeuralConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch { /* private mode — settings just won't persist */ }
}

/** The audio generator needs the relay; the key may live in the worker. */
export function isConfigured(config) {
  return !!(config.relayUrl && config.relayUrl.trim());
}

/** Normalize the relay/base URL and append the audio API path. */
export function buildEndpoint(relayUrl) {
  const base = (relayUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  const withProto = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return withProto + AUDIO_API_PATH;
}

/**
 * Generate one high-fidelity AI track from the rendered beat.
 * @param {object} opts
 * @param {ArrayBuffer} opts.wav — the beat, rendered as WAV
 * @param {string} opts.prompt
 * @param {number} opts.strength — 0..1, how far from the input to stray
 * @param {number} opts.durationSec — requested output length
 * @param {string} opts.relayUrl
 * @param {string} [opts.apiKey] — forwarded if the relay has no stored key
 * @param {typeof fetch} [opts.fetchImpl] — injectable for tests
 * @returns {Promise<{blob: Blob, type: string}>}
 */
export async function generateAudio({
  wav, prompt, strength, durationSec, relayUrl, apiKey = '', fetchImpl = fetch,
}) {
  const endpoint = buildEndpoint(relayUrl);
  if (!endpoint) throw new Error('No relay URL configured.');

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'beat.wav');
  form.append('model', AUDIO_MODEL);
  form.append('strength', String(Math.min(1, Math.max(0.05, strength))));
  form.append('duration', String(Math.min(47, Math.max(6, Math.round(durationSec)))));
  form.append('output_format', 'wav'); // full fidelity — no lossy step

  const headers = { Accept: 'audio/*' };
  if (apiKey && apiKey.trim()) headers['x-api-key'] = apiKey.trim();

  let res;
  try {
    res = await fetchImpl(endpoint, { method: 'POST', headers, body: form });
  } catch (err) {
    throw new Error(`Couldn’t reach the relay (${(err && err.message) || 'network error'}). Check the relay URL.`);
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* opaque */ }
    if (res.status === 401 || res.status === 403) {
      throw new Error('The API key was rejected — check it (and your relay setup).');
    }
    if (res.status === 402) {
      throw new Error('Out of API credits — top up at platform.stability.ai.');
    }
    throw new Error(`Generation failed (HTTP ${res.status}). ${detail}`);
  }
  const type = res.headers.get('content-type') || 'audio/wav';
  const blob = await res.blob();
  if (!blob.size) throw new Error('The model returned empty audio — try again.');
  return { blob, type };
}

/**
 * Turn the recorded take into a text score the model can read.
 * Times are in beats when a tempo was detected, seconds otherwise.
 */
export function buildScore({ events, bpm, loopDur }) {
  const beat = bpm ? 60 / bpm : null;
  const lines = events.map((e) => {
    const t = beat ? (e.t / beat).toFixed(2) : e.t.toFixed(3);
    const vel = Math.round((e.velocity ?? 0.8) * 100) / 100;
    return `${t} ${e.type} v${vel}${e.roll ? ' roll' : ''}`;
  });
  const header = bpm
    ? `Detected tempo: ${Math.round(bpm)} BPM. Times are in beats (quarter notes) from the start.`
    : `No steady tempo was detected. Times are in seconds. The take is ${loopDur ? loopDur.toFixed(2) : '?'}s long.`;
  return `${header}\n${lines.join('\n')}`;
}

const SYSTEM_PROMPT = `You are a world-class session drummer and beat producer.
The user beatboxed a beat into their phone; you receive a transcription of what they performed.
Compose ONE new drum beat inspired by it: keep its tempo feel and rhythmic identity, but make the beat yours — a produced, musical groove that has never been heard before. Use the full kit where it serves the beat (ghost notes, open hi-hats, toms, one fill or crash where natural), with human dynamics.
2 or 4 bars of 4/4. Times are in beats from the loop start; the loop cycles, so make bar 1 land naturally after the last bar.`;

/**
 * Ask Claude to compose one beat from the user's performance.
 * @param {object} opts
 * @param {Array}  opts.events — recorded hits [{t, type, velocity, roll?}]
 * @param {number} [opts.bpm] — detected tempo, if any
 * @param {number} [opts.loopDur] — take length in seconds
 * @param {string} opts.prompt — user's style prompt
 * @param {string} opts.apiKey
 * @param {string} [opts.model]
 * @param {typeof fetch} [opts.fetchImpl] — injectable for tests
 * @returns {Promise<{bpm:number, bars:number, loopDur:number, events:Array}>}
 *          events have t in SECONDS, ready for the renderer.
 */
export async function composeBeat({
  events, bpm, loopDur, prompt, apiKey, model = DEFAULT_MODEL, fetchImpl = fetch,
}) {
  if (!apiKey || !apiKey.trim()) throw new Error('No API key configured.');
  if (!events || !events.length) throw new Error('Record a beat first.');

  const score = buildScore({ events, bpm, loopDur });
  const userMessage = `Style I want: ${prompt}\n\nMy performance:\n${score}\n\nCompose my new beat.`;

  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey.trim(),
        'anthropic-version': API_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        output_config: { format: { type: 'json_schema', schema: BEAT_SCHEMA } },
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } catch (err) {
    throw new Error(`Couldn’t reach Claude (${(err && err.message) || 'network error'}). Check your connection.`);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* opaque */ }
    if (res.status === 401 || res.status === 403) {
      throw new Error('The API key was rejected — check it at console.anthropic.com.');
    }
    if (res.status === 429) {
      throw new Error('Rate limited — wait a moment and try again.');
    }
    if (res.status >= 500 || res.status === 529) {
      throw new Error('Claude is busy right now — try again in a moment.');
    }
    if (/credit balance/i.test(detail)) {
      throw new Error('Out of API credits — top up at console.anthropic.com.');
    }
    throw new Error(`Generation failed (HTTP ${res.status}). ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude declined this request — try a different style prompt.');
  }
  if (data.stop_reason === 'max_tokens') {
    throw new Error('The beat came back incomplete — try again.');
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock || !textBlock.text) throw new Error('Claude returned no beat — try again.');

  let raw;
  try {
    raw = JSON.parse(textBlock.text);
  } catch {
    throw new Error('Claude returned an unreadable beat — try again.');
  }
  return validateBeat(raw);
}

/**
 * Clamp and sanitize the model's pattern into render-ready events
 * (t converted from beats to seconds).
 */
export function validateBeat(raw) {
  const bpm = Math.round(Math.min(220, Math.max(40, Number(raw.bpm) || 100)));
  const bars = Math.min(8, Math.max(1, Math.round(Number(raw.bars) || 2)));
  const beatSec = 60 / bpm;
  const totalBeats = bars * 4;
  const events = (Array.isArray(raw.events) ? raw.events : [])
    .filter((e) => e && DRUM_TYPES.includes(e.type) && Number.isFinite(Number(e.t)))
    .map((e) => ({
      t: Number(e.t),
      type: e.type,
      velocity: Math.min(1, Math.max(0.05, Number(e.velocity) || 0.8)),
      ...(e.roll === true ? { roll: true } : {}),
    }))
    .filter((e) => e.t >= 0 && e.t < totalBeats)
    .sort((a, b) => a.t - b.t)
    .slice(0, 512)
    .map((e) => ({ ...e, t: e.t * beatSec }));
  if (!events.length) throw new Error('Claude returned an empty beat — try again.');
  return { bpm, bars, loopDur: totalBeats * beatSec, events };
}
