import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEndpoint, generateRestyle, loadNeuralConfig, saveNeuralConfig, isConfigured, DEFAULT_PROMPT,
} from '../../js/neural.js';

test('buildEndpoint normalizes relay URLs', () => {
  assert.equal(buildEndpoint(''), null);
  assert.equal(buildEndpoint('  '), null);
  assert.equal(
    buildEndpoint('https://my-relay.workers.dev/'),
    'https://my-relay.workers.dev/v2beta/audio/stable-audio-2/audio-to-audio',
  );
  assert.equal(
    buildEndpoint('my-relay.workers.dev'),
    'https://my-relay.workers.dev/v2beta/audio/stable-audio-2/audio-to-audio',
  );
});

test('config load falls back to defaults without localStorage', () => {
  const cfg = loadNeuralConfig();
  assert.equal(cfg.prompt, DEFAULT_PROMPT);
  assert.equal(cfg.relayUrl, '');
  assert.equal(isConfigured(cfg), false);
});

test('config round-trips through a localStorage shim', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  saveNeuralConfig({ relayUrl: 'https://r.example', apiKey: 'sk-x', prompt: 'jazzy break', strength: 0.5 });
  const cfg = loadNeuralConfig();
  assert.equal(cfg.relayUrl, 'https://r.example');
  assert.equal(cfg.apiKey, 'sk-x');
  assert.equal(cfg.prompt, 'jazzy break');
  assert.equal(cfg.strength, 0.5);
  assert.equal(isConfigured(cfg), true);
  delete globalThis.localStorage;
});

test('generateRestyle posts a well-formed request and returns the audio', async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return new Response(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' }), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    });
  };
  const { blob, type } = await generateRestyle({
    wav: new Uint8Array([82, 73, 70, 70]).buffer,
    prompt: 'punchy break',
    strength: 3, // clamped to 1
    durationSec: 2, // clamped to 6
    relayUrl: 'relay.example',
    apiKey: ' sk-test ',
    fetchImpl,
  });
  assert.equal(type, 'audio/mpeg');
  assert.equal(blob.size, 4);
  assert.equal(captured.url, 'https://relay.example/v2beta/audio/stable-audio-2/audio-to-audio');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers['x-api-key'], 'sk-test');
  const form = captured.opts.body;
  assert.equal(form.get('prompt'), 'punchy break');
  assert.equal(form.get('strength'), '1');
  assert.equal(form.get('duration'), '6');
  assert.equal(form.get('output_format'), 'mp3');
  assert.ok(form.get('audio') instanceof Blob, 'audio file attached');
});

test('generateRestyle maps API failures to human messages', async () => {
  const respond = (status, body = '') => async () => new Response(body, { status });
  await assert.rejects(
    generateRestyle({ wav: new ArrayBuffer(4), prompt: 'x', strength: 0.5, durationSec: 8, relayUrl: 'r.example', fetchImpl: respond(401) }),
    /key was rejected/,
  );
  await assert.rejects(
    generateRestyle({ wav: new ArrayBuffer(4), prompt: 'x', strength: 0.5, durationSec: 8, relayUrl: 'r.example', fetchImpl: respond(402) }),
    /credits/,
  );
  await assert.rejects(
    generateRestyle({ wav: new ArrayBuffer(4), prompt: 'x', strength: 0.5, durationSec: 8, relayUrl: 'r.example', fetchImpl: respond(500, 'boom') }),
    /HTTP 500.*boom/s,
  );
  await assert.rejects(
    generateRestyle({
      wav: new ArrayBuffer(4), prompt: 'x', strength: 0.5, durationSec: 8, relayUrl: 'r.example',
      fetchImpl: async () => { throw new Error('dns fail'); },
    }),
    /reach the relay.*dns fail/s,
  );
  await assert.rejects(
    generateRestyle({ wav: new ArrayBuffer(4), prompt: 'x', strength: 0.5, durationSec: 8, relayUrl: '', fetchImpl: respond(200) }),
    /No relay URL/,
  );
});
