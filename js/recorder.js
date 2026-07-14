/**
 * LoopRecorder — records hits (from the mic or pads) and plays them back.
 *
 * Two recording modes, both feeding the same groove pipeline (js/groove.js):
 *   free      — no metronome, no setup. On stop, the tempo is auto-detected
 *               from your hit timing, bar 1 anchors on your first kick, and
 *               the loop locks to whole bars. The BPM can be nudged
 *               afterwards (regrid).
 *   metronome — 4-beat count-in and clicks while recording; the grid is
 *               known exactly, and the loop rounds to whole 4/4 bars.
 *
 * Playback renders one of four style levels, non-destructively derived
 * from the raw take: raw | tight | clean | full (see groove.js).
 * If tempo detection fails on a free take, the loop falls back to
 * "last hit + tail" and only the raw style is available.
 *
 * DOM-free: main.js owns the UI and subscribes via onHit/onStateChange.
 */

import { DrumEngine } from './audio-engine.js';
import { detectGrid, buildGroove, STYLE_LEVELS, SLOTS_PER_BAR } from './groove.js';

export const BEATS_PER_BAR = 4;

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
 * With `seamless`, decay ringing past the loop end is wrapped back onto
 * the loop start, so the file loops perfectly in a DAW.
 */
export async function renderLoopWav({ events, loopDur, kit, sampleKit = null, seamless = false, sampleRate = 44100 }) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const tail = 0.8;
  const lead = 0.02; // scheduling headroom inside the offline context
  const ctx = new OAC(2, Math.ceil((loopDur + tail) * sampleRate), sampleRate);
  const engine = new DrumEngine(ctx);
  if (sampleKit) engine.registerSampleKit(kit, sampleKit); // AudioBuffers are context-independent
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
    this.events = []; // the raw take, timestamps relative to recording start
    this.bpm = 90;
    this.metronomeOn = false;
    this.styleLevel = 'clean';

    /** Groove of the current loop, or null (no loop / detection failed). */
    this.groove = null;
    /** @type {'auto'|'metronome'|null} */
    this.grooveSource = null;
    this.loopDur = 0;
    this.loopBpm = 90;

    this._recStart = 0;
    this._armTimer = null;
    this._timers = [];
    this._playT0 = 0;
  }

  _set(state) {
    this.state = state;
    this.onStateChange(state);
  }

  /**
   * Swap the audio plumbing (used after a mic session: rebuilding the
   * AudioContext restores media-speaker routing on phones). Events,
   * groove, and loop state are plain data and survive untouched.
   */
  setAudio(ctx, engine, metronome) {
    if (this.state !== 'idle') return false;
    this.ctx = ctx;
    this.engine = engine;
    this.metronome = metronome;
    return true;
  }

  setStyle(level) {
    if (STYLE_LEVELS.includes(level)) this.styleLevel = level;
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

    if (this.metronomeOn) {
      const bar = (BEATS_PER_BAR * 60) / this.bpm;
      // Grace window: stopping shortly after a bar line doesn't add a bar
      const bars = Math.max(1, Math.ceil((rawDur - 0.2 * bar) / bar));
      const grid = {
        bpm: this.bpm,
        sixteenth: 15 / this.bpm,
        offset: 0,
        anchorT: 0, // t=0 IS the downbeat — that's what the count-in is for
        confidence: 1,
      };
      this.groove = buildGroove(this.events, grid, { anchor: 'none', bars });
      this.grooveSource = this.groove ? 'metronome' : null;
      this.loopBpm = this.bpm;
      this.loopDur = this.groove ? this.groove.loopDur : bars * bar;
    } else {
      const grid = detectGrid(this.events);
      this.groove = grid ? buildGroove(this.events, grid) : null;
      if (this.groove) {
        this.grooveSource = 'auto';
        this.loopBpm = this.groove.bpm;
        this.loopDur = this.groove.loopDur;
      } else {
        // couldn't hear a steady pulse — keep the take playable as-is
        this.grooveSource = null;
        const lastT = this.events.reduce((m, e) => Math.max(m, e.t), 0);
        this.loopDur = lastT + 0.7;
      }
    }
    this._set('idle');
  }

  /**
   * Replace the take's events (e.g. with whole-clip analysis results)
   * and re-run the groove pipeline on them.
   * @returns {boolean} true if the take was replaced
   */
  replaceTake(events) {
    if (this.state !== 'idle') return false;
    this.events = (events || []).slice().sort((a, b) => a.t - b.t);
    if (!this.events.length) {
      this.groove = null;
      this.grooveSource = null;
      this.loopDur = 0;
      return true;
    }
    const grid = detectGrid(this.events);
    this.groove = grid ? buildGroove(this.events, grid) : null;
    if (this.groove) {
      this.grooveSource = 'auto';
      this.loopBpm = this.groove.bpm;
      this.loopDur = this.groove.loopDur;
    } else {
      this.grooveSource = null;
      const lastT = this.events.reduce((m, e) => Math.max(m, e.t), 0);
      this.loopDur = lastT + 0.7;
    }
    return true;
  }

  /**
   * Re-fit the grid of an auto-detected loop at a user-chosen tempo.
   * @returns {boolean} true if the loop was re-gridded
   */
  regrid(bpm) {
    if (this.grooveSource !== 'auto' || this.state !== 'idle' || !this.events.length) return false;
    const grid = detectGrid(this.events, { bpm });
    const groove = buildGroove(this.events, grid);
    if (!groove) return false;
    this.groove = groove;
    this.loopBpm = groove.bpm;
    this.loopDur = groove.loopDur;
    return true;
  }

  /** Called by main for every performed hit; ignored unless recording. */
  recordHit(type, velocity, latencyComp = 0) {
    if (this.state !== 'recording') return;
    const t = Math.max(0, this.ctx.currentTime - this._recStart - latencyComp);
    this.events.push({ t, type, velocity });
  }

  /** Events as they will actually play (current style level). */
  playableEvents() {
    if (!this.groove) return this.events.slice();
    return this.groove.styles[this.styleLevel] || this.groove.styles.raw;
  }

  bars() {
    return this.groove ? this.groove.bars : null;
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

  /** Seconds until recording actually starts (while counting in), else null. */
  countInRemaining() {
    if (this.state !== 'armed') return null;
    return Math.max(0, this._recStart - this.ctx.currentTime);
  }

  clear() {
    if (this.state !== 'idle') return;
    this.events = [];
    this.groove = null;
    this.grooveSource = null;
    this.loopDur = 0;
  }
}

export { STYLE_LEVELS, SLOTS_PER_BAR };
