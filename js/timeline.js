/**
 * Timeline — canvas view of the recorded loop: one lane per drum,
 * a dot per hit (sized by velocity), optional beat grid, and a playhead.
 */

const LANES = ['hat', 'snare', 'kick'];
const LANE_COLORS = { kick: '#ff5d5d', snare: '#4dd6c1', hat: '#ffc24d', openhat: '#ffd98a' };
// open hats share the hat lane
const LANE_OF = { kick: 'kick', snare: 'snare', hat: 'hat', openhat: 'hat' };

export class Timeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
  }

  /**
   * @param {object} view
   * @param {{t:number,type:string,velocity:number}[]} view.events
   * @param {number} view.dur — loop length in seconds (>0)
   * @param {number|null} [view.playhead] — 0..1, or null to hide
   * @param {number|null} [view.bpm] — draw a beat grid when set
   * @param {boolean} [view.recording]
   */
  render({ events, dur, playhead = null, bpm = null, recording = false }) {
    const { canvas, g } = this;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const laneH = h / LANES.length;

    // lane separators
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    g.lineWidth = 1;
    for (let i = 1; i < LANES.length; i++) {
      g.beginPath();
      g.moveTo(0, i * laneH);
      g.lineTo(w, i * laneH);
      g.stroke();
    }

    // beat grid (bar lines stronger)
    if (bpm && dur > 0) {
      const beat = 60 / bpm;
      for (let i = 1; i * beat < dur - 1e-6; i++) {
        const x = (i * beat / dur) * w;
        g.strokeStyle = i % 4 === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.09)';
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
      }
    }

    // hits
    if (dur > 0) {
      for (const e of events) {
        const lane = LANES.indexOf(LANE_OF[e.type] || e.type);
        if (lane === -1) continue;
        const x = Math.min(1, e.t / dur) * w;
        const y = lane * laneH + laneH / 2;
        const r = 2.5 + 3 * (e.velocity || 0.8);
        g.fillStyle = LANE_COLORS[e.type];
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.fill();
      }
    }

    // playhead
    if (playhead !== null && playhead !== undefined) {
      const x = playhead * w;
      g.strokeStyle = recording ? 'rgba(255,77,109,0.9)' : 'rgba(108,140,255,0.9)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
    }
  }
}
