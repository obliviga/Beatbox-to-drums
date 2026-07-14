import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHit, classifyHit } from '../../js/classifier.js';

/**
 * The onset worklet is a plain script for AudioWorkletGlobalScope.
 * Stub that scope's globals, import it, and drive process() directly.
 */

const SR = 48000;
const BLOCK = 128;

let ProcessorClass;

before(async () => {
  globalThis.sampleRate = SR;
  globalThis.registerProcessor = (name, cls) => { ProcessorClass = cls; };
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      const messages = [];
      this.port = {
        onmessage: null,
        postMessage: (msg) => messages.push(msg),
        _messages: messages,
      };
    }
  };
  await import('../../js/worklet/onset-processor.js');
  assert.ok(ProcessorClass, 'worklet did not register a processor');
});

function makeProcessor() {
  const proc = new ProcessorClass();
  return { proc, messages: proc.port._messages };
}

function feedBlocks(proc, blocks) {
  for (const block of blocks) proc.process([[block]]);
}

function silentBlocks(n) {
  return Array.from({ length: n }, () => new Float32Array(BLOCK));
}

function toneBlocks(n, amp = 0.4, freq = 200, startSample = 0) {
  return Array.from({ length: n }, (_, b) => {
    const out = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) {
      const s = startSample + b * BLOCK + i;
      out[i] = amp * Math.sin((2 * Math.PI * freq * s) / SR);
    }
    return out;
  });
}

const onsets = (messages) => messages.filter((m) => m.type === 'onset');

test('silence produces level messages but no onsets', () => {
  const { proc, messages } = makeProcessor();
  feedBlocks(proc, silentBlocks(40));
  assert.equal(onsets(messages).length, 0);
  assert.ok(messages.some((m) => m.type === 'level'), 'expected level updates');
});

test('a burst triggers exactly one onset with a full capture window', () => {
  const { proc, messages } = makeProcessor();
  feedBlocks(proc, silentBlocks(10));
  feedBlocks(proc, toneBlocks(20)); // sustained loud tone
  const hits = onsets(messages);
  assert.equal(hits.length, 1, 'sustained burst must not retrigger');
  assert.equal(hits[0].samples.length, 1024);
  assert.ok(hits[0].peak > 0.3 && hits[0].peak <= 0.4001, `peak ${hits[0].peak}`);
});

test('two bursts separated by silence trigger two onsets', () => {
  const { proc, messages } = makeProcessor();
  feedBlocks(proc, silentBlocks(5));
  feedBlocks(proc, toneBlocks(10));
  feedBlocks(proc, silentBlocks(40)); // > 80 ms refractory (30 blocks)
  feedBlocks(proc, toneBlocks(10));
  assert.equal(onsets(messages).length, 2);
});

test('config message can gate detection off', () => {
  const { proc, messages } = makeProcessor();
  proc.port.onmessage({ data: { type: 'config', thresholdRatio: 50, minRms: 0.9 } });
  feedBlocks(proc, silentBlocks(5));
  feedBlocks(proc, toneBlocks(20));
  assert.equal(onsets(messages).length, 0);
});

test('suppress message blocks detection for its duration', () => {
  const { proc, messages } = makeProcessor();
  proc.port.onmessage({ data: { type: 'suppress', sec: 0.2 } }); // 75 blocks
  feedBlocks(proc, silentBlocks(10));
  feedBlocks(proc, toneBlocks(10)); // inside the suppress window
  assert.equal(onsets(messages).length, 0, 'suppressed hit must not trigger');
  feedBlocks(proc, silentBlocks(60)); // suppress expires around block 75
  feedBlocks(proc, toneBlocks(10));
  assert.equal(onsets(messages).length, 1, 'post-suppress hit must trigger');
});

test('raw-audio streaming delivers ordered chunks and flushes on stop', () => {
  const { proc, messages } = makeProcessor();
  proc.port.onmessage({ data: { type: 'stream', on: true } });
  let s = 0;
  const blocks = Array.from({ length: 70 }, () => {
    const b = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) b[i] = (s++ % 1000) / 1000;
    return b;
  });
  feedBlocks(proc, blocks);
  proc.port.onmessage({ data: { type: 'stream', on: false } });

  const chunks = messages.filter((m) => m.type === 'chunk');
  // 70 × 128 = 8960 samples → one full 8192 chunk + a 768-sample flush
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].samples.length, 8192);
  assert.equal(chunks[1].samples.length, 768);
  assert.equal(chunks[1].last, true);
  // continuity across the chunk boundary
  assert.ok(Math.abs(chunks[0].samples[8191] - ((8191 % 1000) / 1000)) < 1e-6);
  assert.ok(Math.abs(chunks[1].samples[0] - ((8192 % 1000) / 1000)) < 1e-6);
  // stream stays quiet after stop
  feedBlocks(proc, blocks.slice(0, 5));
  assert.equal(messages.filter((m) => m.type === 'chunk').length, 2);
});

test('end-to-end: captured attack windows classify correctly', () => {
  // Stream a kick-like plosive and a hat-like sibilant through the detector,
  // then classify what it captured — the full mic pipeline minus the browser.
  const { proc, messages } = makeProcessor();

  const kickSignal = new Float32Array(BLOCK * 16);
  let phase = 0;
  for (let i = 0; i < kickSignal.length; i++) {
    const t = i / SR;
    const f = 60 + 60 * Math.exp(-t * 90);
    phase += (2 * Math.PI * f) / SR;
    kickSignal[i] = 0.7 * Math.sin(phase) * Math.exp(-t * 12);
  }

  const hatSignal = new Float32Array(BLOCK * 16);
  for (let i = 0; i < hatSignal.length; i++) {
    const t = i / SR;
    let v = 0;
    for (let f = 5000; f <= 11000; f += 400) v += Math.sin(2 * Math.PI * f * t + f);
    hatSignal[i] = (v / 16) * 0.9 * Math.exp(-t * 25);
  }

  const asBlocks = (sig) => Array.from(
    { length: sig.length / BLOCK },
    (_, b) => sig.subarray(b * BLOCK, (b + 1) * BLOCK),
  );

  feedBlocks(proc, silentBlocks(5));
  feedBlocks(proc, asBlocks(kickSignal));
  feedBlocks(proc, silentBlocks(40));
  feedBlocks(proc, asBlocks(hatSignal));

  const hits = onsets(messages);
  assert.equal(hits.length, 2);
  const labels = hits.map((h) => classifyHit(analyzeHit(h.samples, SR)));
  assert.deepEqual(labels, ['kick', 'hat']);
});
