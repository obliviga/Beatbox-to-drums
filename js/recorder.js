/**
 * LoopRecorder — records hits (from the mic or pads) and plays them back.
 *
 * Two recording modes:
 *   free      — no metronome; the loop is simply "last hit + a tail"
 *   metronome — 4-beat count-in, clicks while recording, and the loop
 *               length rounds to whole 4/4 bars so it cycles musically.
 *               Quantize (non-destructive) snaps playback to a 1/16 grid.
 *
 * DOM-free: main.js owns the UI and subscribes via onHit/onStateChange.
 * Pure helpers (quantizeTime, encodeWavPCM16, renderLoopWav) are exported
 * separately so they can be unit-tested in Node.
 */

import { DrumEngine } from './audio-engine.js';

export const BEATS_PER_BAR = 4;
export const QUANT_DIVISION = 4; // 4 subdivisions per beat = 1/16 notes

/** Snap a time (seconds) to the nearest 1/16-note at the given tempo. */
export function quantizeTime(t, bpm, division = QUANT_DIVISION) {
  const step = 60 / bpm / division;
  return Math.round(t / step) * step;
}

/** Encode float channel data as a 16-bit PCM WAV file. */
export function encodeWavPCM16(channels, sampleRate) {
  const numCh = channels.length;
  const len = channels[0].length;
  const blockAlign = numCh * 2;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let v = channels[c][i];
      if (v > 1) v = 1;
      else if (v < -1) v = -1;
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return buf;
}

/**
 * Render a loop offline and return a WAV ArrayBuffer.
 * In bar-synced mode the decay ringing past the loop end is wrapped back
 * onto the loop start, so the file loops seamlessly in a DAW.
 */
export async function renderLoopWav({ events, loopDur, kit, seamless = false, sampleRate = 44100 }) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const tail = 0.8;
  const lead = 0.02; // scheduling headroom inside the offline context
  const ctx = new OAC(2, Math.ceil((loopDur + tail) * sampleRate), sampleRate);
  const engine = new DrumEngine(ctx);
  engine.setKit(kit);
  for (const e of events) {
    engine.trigger(e.type, { when: lead + e.t, velocity: e.velocity });
  }
  const rendered = await ctx.startRendering();

  const loopSamples = Math.round(loopDur * sampleRate);
  const channels = [];
  for (let c = 0; c < 2; c++) {
    const data = rendered.getChannelData(c);
    if (!seamless) {
      channels.push(data);
      continue;
    }
    const outData = new Float32Array(loopSamples);
    outData.set(data.subarray(0, loopSamples));
    for (let i = loopSamples; i < data.length; i++) {
      outData[i - loopSamples] += data[i];
    }
    channels.push(outData);
  }
  return encodeWavPCM16(channels, sampleRate);
}

export class LoopRecorder {
  /**
   * @param {object} deps
   * @param {BaseAudioContext} deps.ctx
   * @param {DrumEngine} deps.engine
   * @param {{start:Function, stop:Function}} deps.metronome
   * @param {(type:string)=>void} [deps.onHit] — fired when a playback hit sounds
   * @param {(state:string)=>void} [deps.onStateChange]
   */
  constructor({ ctx, engine, metronome, onHit, onStateChange }) {
    this.ctx = ctx;
    this.engine = engine;
    this.metronome = metronome;
    this.onHit = onHit || (() => {});
    this.onStateChange = onStateChange || (() => {});

    /** @type {'idle'|'armed'|'recording'|'playing'} */
    this.state = 'idle';
    this.events = [];
    this.bpm = 90;
    this.metronomeOn = false;
    this.quantizeOn = false;

    this.loopDur = 0;
    this.loopBpm = 90;
    this.usedMetronome = false;

    this._recStart = 0;
    this._armTimer = null;
    this._timers = [];
    this._playT0 = 0;
  }

  _set(state) {
    this.state = state;
    this.onStateChange(state);
  }

  startRecord() {
    if (this.state !== 'idle') return;
    if (this.metronomeOn) {
      const beat = 60 / this.bpm;
      const t0 = this.ctx.currentTime + 0.15;
      this._recStart = t0 + BEATS_PER_BAR * beat; // recording starts after count-in
      this.metronome.start(this.bpm, t0);
      this._set('armed');
      this._armTimer = setTimeout(() => {
        this._armTimer = null;
        this.events = [];
        this._set('recording');
      }, (this._recStart - this.ctx.currentTime) * 1000);
    } else {
      this._recStart = this.ctx.currentTime;
      this.events = [];
      this._set('recording');
    }
  }

  stopRecord() {
    this.metronome.stop();
    if (this._armTimer) {
      // cancelled during count-in — previous loop (if any) is preserved
      clearTimeout(this._armTimer);
      this._armTimer = null;
      this._set('idle');
      return;
    }
    if (this.state !== 'recording') return;
    const rawDur = Math.max(0.5, this.ctx.currentTime - this._recStart);
    this.usedMetronome = this.metronomeOn;
    this.loopBpm = this.bpm;
    if (this.usedMetronome) {
      const bar = (BEATS_PER_BAR * 60) / this.bpm;
      // Grace window: stopping shortly after a bar line doesn't add a bar
      const bars = Math.max(1, Math.ceil((rawDur - 0.2 * bar) / bar));
      this.loopDur = bars * bar;
      // Hits in the overshoot were meant as the next pass's downbeat
      this.events = this.events.map((e) => ({ ...e, t: e.t % this.loopDur }));
    } else {
      const lastT = this.events.reduce((m, e) => Math.max(m, e.t), 0);
      this.loopDur = lastT + 0.7;
    }
    this._set('idle');
  }

  /** Called by main for every performed hit; ignored unless recording. */
  recordHit(type, velocity, latencyComp = 0) {
    if (this.state !== 'recording') return;
    const t = Math.max(0, this.ctx.currentTime - this._recStart - latencyComp);
    this.events.push({ t, type, velocity });
  }

  /** Events as they will actually play (quantized if applicable). */
  playableEvents() {
    if (!(this.quantizeOn && this.usedMetronome)) return this.events.slice();
    return this.events.map((e) => ({
      ...e,
      t: quantizeTime(e.t, this.loopBpm) % this.loopDur,
    }));
  }

  play(isLoopOn = () => false) {
    if (this.state !== 'idle' || !this.events.length) return;
    this._set('playing');
    this._schedulePass(isLoopOn);
  }

  _schedulePass(isLoopOn) {
    const t0 = this.ctx.currentTime + 0.12;
    this._playT0 = t0;
    for (const e of this.playableEvents()) {
      this.engine.trigger(e.type, { when: t0 + e.t, velocity: e.velocity, track: true });
      this._timers.push(setTimeout(
        () => this.onHit(e.type),
        Math.max(0, (t0 + e.t - this.ctx.currentTime) * 1000),
      ));
    }
    this._timers.push(setTimeout(() => {
      this._timers = [];
      if (this.state === 'playing' && isLoopOn()) this._schedulePass(isLoopOn);
      else this.stopPlay();
    }, Math.max(0, (t0 + this.loopDur - this.ctx.currentTime) * 1000)));
  }

  stopPlay() {
    if (this.state !== 'playing') return;
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
    this.engine.stopScheduled();
    this._set('idle');
  }

  /** 0..1 position within the loop while playing, else null. */
  playheadPos() {
    if (this.state !== 'playing' || !this.loopDur) return null;
    const p = (this.ctx.currentTime - this._playT0) / this.loopDur;
    return p < 0 ? 0 : p % 1;
  }

  recordingElapsed() {
    return this.state === 'recording' ? this.ctx.currentTime - this._recStart : 0;
  }

  clear() {
    if (this.state !== 'idle') return;
    this.events = [];
    this.loopDur = 0;
  }
}
