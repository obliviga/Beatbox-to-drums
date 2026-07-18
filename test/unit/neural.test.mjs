import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScore, composeBeat, validateBeat, loadNeuralConfig, saveNeuralConfig, isConfigured,
  DEFAULT_PROMPT, DEFAULT_MODEL, BEAT_SCHEMA, DRUM_TYPES,
} from '../../js/neural.js';

test('config load falls back to defaults without localStorage', () => {
  const cfg = loadNeuralConfig();
  assert.equal(cfg.prompt, DEFAULT_PROMPT);
  assert.equal(cfg.model, DEFAULT_MODEL);
  assert.equal(cfg.apiKey, '');
  assert.equal(isConfigured(cfg), false);
});

test('config round-trips through a localStorage shim', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  saveNeuralConfig({ apiKey: 'sk-ant-x', prompt: 'jazzy break' });
  const cfg = loadNeuralConfig();
  assert.equal(cfg.apiKey, 'sk-ant-x');
  assert.equal(cfg.prompt, 'jazzy break');
  assert.equal(cfg.model, DEFAULT_MODEL); // unset field falls back
  assert.equal(isConfigured(cfg), true);
  delete globalThis.localStorage;
});

test('buildScore writes beats when a tempo is known, seconds otherwise', () => {
  const events = [
    { t: 0, type: 'kick', velocity: 0.9 },
    { t: 0.5, type: 'hat', velocity: 0.31234 },
    { t: 1.0, type: 'snare', velocity: 0.8, roll: true },
  ];
  const withBpm = buildScore({ events, bpm: 120, loopDur: 2 });
  assert.match(withBpm, /Detected tempo: 120 BPM/);
  assert.match(withBpm, /^0\.00 kick v0\.9$/m); // 0 sec = beat 0
  assert.match(withBpm, /^1\.00 hat v0\.31$/m); // 0.5 sec @120 = beat 1
  assert.match(withBpm, /^2\.00 snare v0\.8 roll$/m);

  const noBpm = buildScore({ events, bpm: null, loopDur: 2 });
  assert.match(noBpm, /No steady tempo/);
  assert.match(noBpm, /^0\.500 hat v0\.31$/m); // raw seconds
});

test('composeBeat posts a well-formed direct-browser API request', async () => {
  let captured = null;
  const beat = {
    bpm: 96, bars: 2,
    events: [
      { t: 0, type: 'kick', velocity: 0.95, roll: false },
      { t: 1, type: 'snare', velocity: 0.85, roll: false },
      { t: 0.5, type: 'hat', velocity: 0.4, roll: false },
    ],
  };
  const fetchImpl = async (url, opts) => {
    captured = { url, opts, body: JSON.parse(opts.body) };
    return new Response(JSON.stringify({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: JSON.stringify(beat) },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await composeBeat({
    events: [{ t: 0, type: 'kick', velocity: 0.9 }],
    bpm: 100,
    loopDur: 2.4,
    prompt: 'boom bap',
    apiKey: ' sk-ant-test ',
    fetchImpl,
  });

  assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured.opts.method, 'POST');
  assert.equal(captured.opts.headers['x-api-key'], 'sk-ant-test');
  assert.equal(captured.opts.headers['anthropic-version'], '2023-06-01');
  assert.equal(captured.opts.headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(captured.body.model, DEFAULT_MODEL);
  assert.deepEqual(captured.body.thinking, { type: 'adaptive' });
  assert.deepEqual(captured.body.output_config, { format: { type: 'json_schema', schema: BEAT_SCHEMA } });
  assert.match(captured.body.messages[0].content, /boom bap/);
  assert.match(captured.body.messages[0].content, /kick v0\.9/);
  assert.match(captured.body.system, /drummer/i);

  // events come back in seconds at the composed tempo (96 BPM → 0.625 s/beat)
  assert.equal(result.bpm, 96);
  assert.equal(result.bars, 2);
  assert.ok(Math.abs(result.loopDur - 5) < 1e-9);
  assert.deepEqual(result.events.map((e) => e.type), ['kick', 'hat', 'snare']); // sorted by t
  assert.ok(Math.abs(result.events[1].t - 0.3125) < 1e-9);
});

test('validateBeat clamps and drops junk from the model', () => {
  const out = validateBeat({
    bpm: 500, // clamped to 220
    bars: 1.7, // rounded to 2
    events: [
      { t: 0, type: 'kick', velocity: 4 }, // velocity clamped to 1
      { t: 2, type: 'kazoo', velocity: 0.5 }, // unknown drum dropped
      { t: -1, type: 'snare', velocity: 0.5 }, // before the loop dropped
      { t: 99, type: 'snare', velocity: 0.5 }, // past the loop dropped
      { t: 3, type: 'snare', velocity: 0.000001, roll: true }, // vel floor, roll kept
    ],
  });
  assert.equal(out.bpm, 220);
  assert.equal(out.bars, 2);
  assert.equal(out.events.length, 2);
  assert.equal(out.events[0].velocity, 1);
  assert.equal(out.events[1].velocity, 0.05);
  assert.equal(out.events[1].roll, true);
  assert.ok(DRUM_TYPES.includes(out.events[0].type));
  assert.throws(() => validateBeat({ bpm: 120, bars: 2, events: [] }), /empty beat/);
});

test('composeBeat maps API failures to human messages', async () => {
  const base = { events: [{ t: 0, type: 'kick', velocity: 0.9 }], bpm: 120, loopDur: 2, prompt: 'x', apiKey: 'sk-ant-x' };
  const respond = (status, body = '') => async () => new Response(body, { status });
  await assert.rejects(composeBeat({ ...base, fetchImpl: respond(401) }), /key was rejected/);
  await assert.rejects(composeBeat({ ...base, fetchImpl: respond(429) }), /Rate limited/);
  await assert.rejects(composeBeat({ ...base, fetchImpl: respond(529) }), /busy/);
  await assert.rejects(
    composeBeat({ ...base, fetchImpl: respond(400, '{"error":{"message":"Your credit balance is too low"}}') }),
    /Out of API credits/,
  );
  await assert.rejects(
    composeBeat({ ...base, fetchImpl: async () => { throw new Error('dns fail'); } }),
    /reach Claude.*dns fail/s,
  );
  await assert.rejects(
    composeBeat({
      ...base,
      fetchImpl: async () => new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 }),
    }),
    /declined/,
  );
  await assert.rejects(
    composeBeat({
      ...base,
      fetchImpl: async () => new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }), { status: 200 }),
    }),
    /unreadable/,
  );
  await assert.rejects(composeBeat({ ...base, apiKey: '' }), /No API key/);
});
