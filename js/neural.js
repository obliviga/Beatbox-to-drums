/**
 * Neural restyle — sends the rendered beat to a generative audio model
 * (Stability AI "Stable Audio" audio-to-audio) and returns one AI take.
 *
 * Privacy: this is the ONLY feature that sends audio off the device, it
 * only runs when the user taps Generate, and it uses the user's own API
 * key. The key and settings live in localStorage.
 *
 * Browsers can't call api.stability.ai directly (no CORS), so requests
 * go through the user's own tiny relay (see worker/relay.js — a
 * copy-paste Cloudflare Worker). The relay either injects a key stored
 * as a Worker secret, or forwards the key the app sends.
 */

const CONFIG_KEY = 'b2d-neural-v1';
const API_PATH = '/v2beta/audio/stable-audio-2/audio-to-audio';

export const DEFAULT_PROMPT =
  'punchy studio drum break, acoustic kit, tight low end, crisp hi-hats, produced, no melody';
export const DEFAULT_STRENGTH = 0.65;

export function loadNeuralConfig() {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
    return {
      relayUrl: typeof c.relayUrl === 'string' ? c.relayUrl : '',
      apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
      prompt: typeof c.prompt === 'string' && c.prompt.trim() ? c.prompt : DEFAULT_PROMPT,
      strength: typeof c.strength === 'number' ? c.strength : DEFAULT_STRENGTH,
    };
  } catch {
    return { relayUrl: '', apiKey: '', prompt: DEFAULT_PROMPT, strength: DEFAULT_STRENGTH };
  }
}

export function saveNeuralConfig(config) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch { /* private mode — settings just won't persist */ }
}

export function isConfigured(config) {
  return !!(config.relayUrl && config.relayUrl.trim());
}

/** Normalize the relay/base URL and append the API path. */
export function buildEndpoint(relayUrl) {
  const base = (relayUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  const withProto = /^https?:\/\//i.test(base) ? base : `https://${base}`;
  return withProto + API_PATH;
}

/**
 * Generate one AI take from a rendered beat.
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
export async function generateRestyle({
  wav, prompt, strength, durationSec, relayUrl, apiKey = '', fetchImpl = fetch,
}) {
  const endpoint = buildEndpoint(relayUrl);
  if (!endpoint) throw new Error('No relay URL configured.');

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'beat.wav');
  form.append('strength', String(Math.min(1, Math.max(0.05, strength))));
  form.append('duration', String(Math.min(47, Math.max(6, Math.round(durationSec)))));
  form.append('output_format', 'mp3');

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
  const type = res.headers.get('content-type') || 'audio/mpeg';
  const blob = await res.blob();
  if (!blob.size) throw new Error('The model returned empty audio — try again.');
  return { blob, type };
}
