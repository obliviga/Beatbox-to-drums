import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWavPCM16, LoopRecorder } from '../../js/recorder.js';

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

test('free recording with no steady pulse falls back to raw take + tail', () => {
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
  assert.equal(rec.groove, null); // 2 hits — nothing to detect
  assert.equal(rec.grooveSource, null);
  assert.ok(Math.abs(rec.loopDur - 2.2) < 1e-9); // last hit 1.5 + 0.7
  assert.equal(rec.playableEvents().length, 2); // raw take still playable
});

test('free recording with steady hits auto-detects tempo and locks bars', () => {
  const { rec, clock } = makeRecorder();
  rec.startRecord();
  const types = ['kick', 'hat', 'snare', 'hat'];
  for (let i = 0; i < 12; i++) {
    clock.t += 0.25; // 8th notes at 120 BPM
    rec.recordHit(types[i % 4], 0.8);
  }
  clock.t += 0.1;
  rec.stopRecord();

  assert.equal(rec.grooveSource, 'auto');
  assert.ok(Math.abs(rec.loopBpm - 120) <= 3, `bpm ${rec.loopBpm}`);
  assert.ok(rec.bars() >= 1);
  assert.ok(Math.abs(rec.loopDur - rec.bars() * 16 * rec.groove.sixteenth) < 1e-9);

  // style ladder is live and non-destructive
  rec.setStyle('tight');
  const tight = rec.playableEvents();
  for (const e of tight) {
    const slots = e.t / rec.groove.sixteenth;
    assert.ok(Math.abs(slots - Math.round(slots)) < 1e-9, `off-grid t=${e.t}`);
  }
  rec.setStyle('full');
  assert.ok(rec.playableEvents().length > tight.length, 'full should add hits');
  rec.setStyle('raw');
  assert.equal(rec.playableEvents().length, 12);
  assert.equal(rec.events.length, 12, 'raw take untouched');
});

test('regrid re-fits an auto loop at a user-chosen tempo', () => {
  const { rec, clock } = makeRecorder();
  rec.startRecord();
  for (let i = 0; i < 12; i++) {
    clock.t += 0.25;
    rec.recordHit('kick', 0.8);
  }
  rec.stopRecord();
  assert.equal(rec.grooveSource, 'auto');

  const ok = rec.regrid(60); // halve the tempo: 8ths become 16ths
  assert.equal(ok, true);
  assert.equal(rec.loopBpm, 60);
  assert.ok(Math.abs(rec.groove.sixteenth - 0.25) < 1e-9);

  // metronome loops must not be regridded
  rec.grooveSource = 'metronome';
  assert.equal(rec.regrid(90), false);
});

test('metronome mode: grace at the bar line, overshoot wraps, styles apply', () => {
  const { rec, clock } = makeRecorder();
  rec.metronomeOn = true;
  rec.bpm = 120; // bar = 2 s
  beginMetronomeRecording(rec, clock);

  rec.recordHit('kick', 1); // t = 0
  clock.t += 0.51;
  rec.recordHit('snare', 0.8); // t ≈ 0.51 — slightly loose
  clock.t += 1.64;             // stop at 2.15 s, slightly past one bar
  rec.recordHit('hat', 0.7);   // overshoot hit at 2.15
  rec.stopRecord();

  assert.equal(rec.grooveSource, 'metronome');
  assert.equal(rec.loopDur, 2); // one 2 s bar — overshoot was within grace
  assert.equal(rec.bars(), 1);

  rec.setStyle('raw');
  const raw = rec.playableEvents();
  assert.ok(raw.some((e) => Math.abs(e.t - 0.15) < 1e-9), 'raw overshoot wraps to 0.15');
  assert.ok(raw.some((e) => Math.abs(e.t - 0.51) < 1e-9), 'raw keeps loose timing');

  rec.setStyle('tight');
  const snare = rec.playableEvents().find((e) => e.type === 'snare');
  assert.equal(snare.t, 0.5); // snapped to the beat
});

test('recording well into a second bar rounds the loop up to two bars', () => {
  const { rec, clock } = makeRecorder();
  rec.metronomeOn = true;
  rec.bpm = 120;
  beginMetronomeRecording(rec, clock);
  rec.recordHit('kick', 1);
  clock.t += 2.7; // clearly into bar 2
  rec.stopRecord();
  assert.equal(rec.loopDur, 4);
  assert.equal(rec.bars(), 2);
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

test('clear resets the loop and groove', () => {
  const { rec, clock } = makeRecorder();
  rec.startRecord();
  for (let i = 0; i < 8; i++) { clock.t += 0.3; rec.recordHit('kick', 0.8); }
  rec.stopRecord();
  assert.ok(rec.groove);
  rec.clear();
  assert.equal(rec.events.length, 0);
  assert.equal(rec.groove, null);
  assert.equal(rec.loopDur, 0);
});
