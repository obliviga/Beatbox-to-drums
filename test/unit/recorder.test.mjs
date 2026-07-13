import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantizeTime, encodeWavPCM16, LoopRecorder } from '../../js/recorder.js';

test('quantizeTime snaps to the 1/16 grid', () => {
  // 120 BPM → 1/16 = 0.125 s
  assert.equal(quantizeTime(0.26, 120), 0.25);
  assert.equal(quantizeTime(0.19, 120), 0.25);
  assert.equal(quantizeTime(0.07, 120), 0.125);
  assert.equal(quantizeTime(0.05, 120), 0);
  assert.equal(quantizeTime(0, 120), 0);
});

test('encodeWavPCM16 writes a valid stereo header', () => {
  const left = new Float32Array(100).fill(0.5);
  const right = new Float32Array(100).fill(-0.5);
  const buf = encodeWavPCM16([left, right], 44100);
  const dv = new DataView(buf);
  const str = (off, len) => String.fromCharCode(...new Uint8Array(buf, off, len));

  assert.equal(buf.byteLength, 44 + 100 * 2 * 2);
  assert.equal(str(0, 4), 'RIFF');
  assert.equal(str(8, 4), 'WAVE');
  assert.equal(str(12, 4), 'fmt ');
  assert.equal(dv.getUint16(20, true), 1); // PCM
  assert.equal(dv.getUint16(22, true), 2); // stereo
  assert.equal(dv.getUint32(24, true), 44100);
  assert.equal(str(36, 4), 'data');
  assert.equal(dv.getUint32(40, true), 400);
  // clipping guard
  const loud = encodeWavPCM16([new Float32Array([2, -2])], 8000);
  const ldv = new DataView(loud);
  assert.equal(ldv.getInt16(44, true), 0x7fff);
  assert.equal(ldv.getInt16(46, true), -0x8000);
});

/* ---------- LoopRecorder against a fake clock ---------- */

function makeRecorder() {
  const clock = { t: 100 };
  const triggered = [];
  const fakeCtx = { get currentTime() { return clock.t; } };
  const fakeEngine = {
    trigger: (type, opts) => triggered.push({ type, ...opts }),
    stopScheduled: () => {},
  };
  const fakeMetronome = { start: () => {}, stop: () => {} };
  const rec = new LoopRecorder({ ctx: fakeCtx, engine: fakeEngine, metronome: fakeMetronome });
  return { rec, clock, triggered };
}

test('free-mode recording: loop is last hit plus a tail', () => {
  const { rec, clock } = makeRecorder();
  rec.startRecord();
  assert.equal(rec.state, 'recording');
  clock.t += 0.5;
  rec.recordHit('kick', 1);
  clock.t += 1.0;
  rec.recordHit('snare', 0.8);
  clock.t += 0.2;
  rec.stopRecord();
  assert.equal(rec.state, 'idle');
  assert.equal(rec.events.length, 2);
  assert.ok(Math.abs(rec.events[1].t - 1.5) < 1e-9);
  assert.ok(Math.abs(rec.loopDur - 2.2) < 1e-9); // 1.5 + 0.7
});

function beginMetronomeRecording(rec, clock) {
  rec.startRecord();
  assert.equal(rec.state, 'armed'); // count-in
  // simulate the count-in elapsing (arm timer would fire in the browser)
  clock.t = rec._recStart;
  clearTimeout(rec._armTimer);
  rec._armTimer = null;
  rec.events = [];
  rec._set('recording');
}

test('stopping just past a bar line rounds down (grace) and wraps the overshoot hit', () => {
  const { rec, clock } = makeRecorder();
  rec.metronomeOn = true;
  rec.bpm = 120; // bar = 2 s
  beginMetronomeRecording(rec, clock);

  rec.recordHit('kick', 1); // t = 0
  clock.t += 2.15;          // slightly past one bar
  rec.recordHit('hat', 0.7);
  rec.stopRecord();

  assert.equal(rec.loopDur, 2); // one 2 s bar — overshoot was within grace
  assert.equal(rec.usedMetronome, true);
  // the overshoot hit was meant as the next pass's downbeat area
  assert.ok(Math.abs(rec.events[1].t - 0.15) < 1e-9, `wrapped t = ${rec.events[1].t}`);
});

test('recording well into a second bar rounds the loop up to two bars', () => {
  const { rec, clock } = makeRecorder();
  rec.metronomeOn = true;
  rec.bpm = 120; // bar = 2 s
  beginMetronomeRecording(rec, clock);

  rec.recordHit('kick', 1);
  clock.t += 2.7; // clearly into bar 2
  rec.stopRecord();

  assert.equal(rec.loopDur, 4);
});

test('quantize applies at playback only when recorded with metronome', () => {
  const { rec } = makeRecorder();
  rec.events = [{ t: 0.26, type: 'kick', velocity: 1 }];
  rec.loopDur = 2;
  rec.loopBpm = 120;
  rec.quantizeOn = true;

  rec.usedMetronome = false;
  assert.equal(rec.playableEvents()[0].t, 0.26);

  rec.usedMetronome = true;
  assert.equal(rec.playableEvents()[0].t, 0.25);
  // non-destructive
  assert.equal(rec.events[0].t, 0.26);
});

test('recordHit applies latency compensation and clamps at zero', () => {
  const { rec, clock } = makeRecorder();
  rec.startRecord();
  clock.t += 0.5;
  rec.recordHit('kick', 1, 0.03);
  clock.t += 0.001;
  rec.recordHit('hat', 1, 0.6); // compensation larger than elapsed
  assert.ok(Math.abs(rec.events[0].t - 0.47) < 1e-9);
  assert.equal(rec.events[1].t, 0);
});

test('cancelling during count-in preserves the previous loop', () => {
  const { rec } = makeRecorder();
  rec.events = [{ t: 0, type: 'kick', velocity: 1 }];
  rec.loopDur = 1.5;
  rec.metronomeOn = true;
  rec.startRecord();
  assert.equal(rec.state, 'armed');
  rec.stopRecord(); // cancel before recording began
  assert.equal(rec.state, 'idle');
  assert.equal(rec.events.length, 1);
  assert.equal(rec.loopDur, 1.5);
});
