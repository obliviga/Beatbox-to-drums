/**
 * Metronome — rolling look-ahead scheduler for click sounds.
 * Beats are scheduled ~0.3 s ahead on a 80 ms timer so timing stays sample-
 * accurate (Web Audio clock) even if the main thread hiccups.
 */

export class Metronome {
  /**
   * @param {BaseAudioContext} ctx
   * @param {(when:number, accent:boolean)=>void} click
   */
  constructor(ctx, click) {
    this.ctx = ctx;
    this.click = click;
    this._interval = null;
    this._nextBeat = 0;
    this._beatIdx = 0;
    this._bpm = 120;
  }

  /** Start clicking at `bpm`, first beat exactly at `t0` (accented per bar). */
  start(bpm, t0, beatsPerBar = 4) {
    this.stop();
    this._bpm = bpm;
    this._nextBeat = t0;
    this._beatIdx = 0;
    const tick = () => {
      const horizon = this.ctx.currentTime + 0.3;
      while (this._nextBeat < horizon) {
        this.click(this._nextBeat, this._beatIdx % beatsPerBar === 0);
        this._nextBeat += 60 / this._bpm;
        this._beatIdx++;
      }
    };
    tick();
    this._interval = setInterval(tick, 80);
  }

  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  get running() {
    return this._interval !== null;
  }
}
