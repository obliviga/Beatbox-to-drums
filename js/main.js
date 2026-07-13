/**
 * Beatbox → Drums — app wiring.
 *
 * Pipeline: mic → AudioWorklet onset detector → attack window →
 * classifier (kick/snare/hat) → DrumEngine synth voice, with auto tempo
 * detection turning a take into a quantized, bar-locked loop.
 *
 * UI NOTE: the interface is currently pared down to Record → waveform →
 * Play. The richer controls (kits, sensitivity, speaker guard, metronome,
 * beat styles, pads, timeline, export, debug) are commented out in
 * index.html; every reference here is null-guarded, so uncommenting a
 * section in the HTML re-enables it with no JS changes.
 */

import { DrumEngine, KIT_NAMES } from './audio-engine.js';
import { analyzeHit, classifyHit } from './classifier.js';
import { LoopRecorder, renderLoopWav, STYLE_LEVELS } from './recorder.js';
import { Metronome } from './metronome.js';
import { Timeline } from './timeline.js';
import { Waveform } from './waveform.js';

const CAPTURE_SAMPLES = 1024; // keep in sync with js/worklet/onset-processor.js
const SETTINGS_KEY = 'b2d-settings';

const els = {
  micBtn: document.getElementById('micBtn'),
  micLabel: document.getElementById('micLabel'),
  statusText: document.getElementById('statusText'),
  meterFill: document.getElementById('meterFill'),
  pads: Array.from(document.querySelectorAll('.pad')),
  chips: Array.from(document.querySelectorAll('.chip[data-kit]')),
  styleChips: Array.from(document.querySelectorAll('.style-chip')),
  sensSlider: document.getElementById('sensSlider'),
  guardChk: document.getElementById('guardChk'),
  bpmInput: document.getElementById('bpmInput'),
  metChk: document.getElementById('metChk'),
  recBtn: document.getElementById('recBtn'),
  playBtn: document.getElementById('playBtn'),
  loopChk: document.getElementById('loopChk'),
  clearBtn: document.getElementById('clearBtn'),
  exportBtn: document.getElementById('exportBtn'),
  recCount: document.getElementById('recCount'),
  timelineCanvas: document.getElementById('timeline'),
  waveformCanvas: document.getElementById('waveform'),
  debugChk: document.getElementById('debugChk'),
  debugLine: document.getElementById('debugLine'),
};

let ctx = null;
let engine = null;
let metronome = null;
let recorder = null;
let workletReady = false;
let workletNode = null;
let micStream = null;
let micSource = null;
let micOn = false;
let micBusy = false;

let kitName = 'acoustic';
let styleLevel = 'clean';
let sensitivity = 0.65;
let speakerGuard = false;
let meterLevel = 0;
let prevRecorderState = 'idle';

const timeline = els.timelineCanvas ? new Timeline(els.timelineCanvas) : null;
const waveform = els.waveformCanvas ? new Waveform(els.waveformCanvas) : null;

const loopEnabled = () => (els.loopChk ? els.loopChk.checked : true);

/* ---------- settings persistence ---------- */

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { /* fresh start */ }
  if (KIT_NAMES.includes(s.kit)) kitName = s.kit;
  // honor a persisted style only while the style chips are visible —
  // in the minimal UI the conversion is always the sensible default
  if (els.styleChips.length && STYLE_LEVELS.includes(s.styleLevel)) styleLevel = s.styleLevel;
  if (typeof s.sensitivity === 'number') sensitivity = Math.min(1, Math.max(0, s.sensitivity));
  if (els.guardChk && typeof s.speakerGuard === 'boolean') speakerGuard = s.speakerGuard;
  if (els.sensSlider) els.sensSlider.value = String(Math.round(sensitivity * 100));
  if (els.guardChk) els.guardChk.checked = speakerGuard;
  if (els.bpmInput && typeof s.bpm === 'number') els.bpmInput.value = String(clampBpm(s.bpm));
  if (els.metChk && typeof s.metronomeOn === 'boolean') els.metChk.checked = s.metronomeOn;
  if (els.debugChk && els.debugLine && typeof s.debug === 'boolean') {
    els.debugChk.checked = s.debug;
    els.debugLine.hidden = !s.debug;
  }
  for (const c of els.chips) c.classList.toggle('active', c.dataset.kit === kitName);
  reflectStyleChips();
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      kit: kitName,
      styleLevel,
      sensitivity,
      speakerGuard,
      bpm: els.bpmInput ? clampBpm(Number(els.bpmInput.value)) : 90,
      metronomeOn: els.metChk ? els.metChk.checked : false,
      debug: els.debugChk ? els.debugChk.checked : false,
    }));
  } catch { /* storage unavailable (private mode) — fine */ }
}

function clampBpm(n) {
  if (!Number.isFinite(n)) return 90;
  return Math.min(240, Math.max(40, Math.round(n)));
}

/* ---------- audio setup ---------- */

function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    engine = new DrumEngine(ctx);
    engine.setKit(kitName);
    if (waveform) engine.master.connect(waveform.attach(ctx)); // drums show on the waveform
    metronome = new Metronome(ctx, (when, accent) => engine.click(when, accent));
    recorder = new LoopRecorder({
      ctx,
      engine,
      metronome,
      onHit: (type) => {
        flashPad(type);
        suppressDetection();
      },
      onStateChange: onRecorderState,
    });
    recorder.setStyle(styleLevel);
    syncRecorderSettings();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function syncRecorderSettings() {
  if (!recorder) return;
  recorder.bpm = els.bpmInput ? clampBpm(Number(els.bpmInput.value)) : 90;
  recorder.metronomeOn = els.metChk ? els.metChk.checked : false;
}

async function startMic() {
  if (!window.isSecureContext) {
    throw new Error('Microphone needs HTTPS (or localhost). Open this page over a secure connection.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser does not support microphone capture.');
  }
  ensureAudio();
  await ctx.resume();

  // Disable browser voice processing — it eats percussive transients.
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });

  if (!workletReady) {
    await ctx.audioWorklet.addModule('js/worklet/onset-processor.js');
    workletReady = true;
  }

  workletNode = new AudioWorkletNode(ctx, 'onset-processor');
  workletNode.port.onmessage = onWorkletMessage;

  micSource = ctx.createMediaStreamSource(micStream);
  micSource.connect(workletNode);
  if (waveform) micSource.connect(waveform.attach(ctx)); // mic shows on the waveform
  // Keep the worklet pulled by the graph without hearing the raw mic.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  workletNode.connect(mute).connect(ctx.destination);

  applySensitivity();
  micOn = true;
}

function stopMic() {
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
    micStream = null;
  }
  if (micSource) {
    try { micSource.disconnect(); } catch { /* noop */ }
    micSource = null;
  }
  if (workletNode) {
    workletNode.port.onmessage = null;
    try { workletNode.disconnect(); } catch { /* noop */ }
    workletNode = null;
  }
  micOn = false;
  meterLevel = 0;
}

function applySensitivity() {
  if (!workletNode) return;
  const guardFactor = speakerGuard ? 1.6 : 1;
  workletNode.port.postMessage({
    type: 'config',
    thresholdRatio: (12 - 9 * sensitivity) * guardFactor, // 12 (strict) → 3 (hair trigger)
    minRms: 0.03 - 0.024 * sensitivity,                   // 0.03 → 0.006
  });
}

function suppressDetection() {
  if (speakerGuard && workletNode) {
    workletNode.port.postMessage({ type: 'suppress', sec: 0.15 });
  }
}

function onWorkletMessage(e) {
  const msg = e.data;
  if (msg.type === 'level') {
    if (msg.rms > meterLevel) meterLevel = msg.rms;
    return;
  }
  if (msg.type === 'onset') {
    const features = analyzeHit(msg.samples, ctx.sampleRate);
    const type = classifyHit(features);
    if (!type) return;
    const velocity = Math.min(1, 0.35 + msg.peak * 1.2);
    performHit(type, velocity, { features, fromMic: true });
  }
}

/* ---------- hits, pads, debug ---------- */

function detectionLatency() {
  return CAPTURE_SAMPLES / ctx.sampleRate + (ctx.outputLatency || ctx.baseLatency || 0.01);
}

function performHit(type, velocity, { features = null, fromMic = false } = {}) {
  const capturing = recorder && (recorder.state === 'recording' || recorder.state === 'armed');
  // Recording is silent capture — the drums are only heard on ▶ Play.
  // (Also means the speakers can't feed back into the take.)
  if (!capturing) {
    engine.trigger(type, { velocity });
    suppressDetection();
  }
  flashPad(type);
  recorder.recordHit(type, velocity, fromMic ? detectionLatency() : 0);
  updateRecCount();
  if (features && els.debugLine && !els.debugLine.hidden) {
    els.debugLine.textContent =
      `${type.toUpperCase()} — centroid ${Math.round(features.centroid)} Hz · ` +
      `zcr ${features.zcr.toFixed(2)} · ` +
      `low ${(features.low * 100).toFixed(0)}% · ` +
      `mid ${(features.mid * 100).toFixed(0)}% · ` +
      `high ${(features.high * 100).toFixed(0)}%`;
  }
}

function flashPad(type) {
  const pad = els.pads.find((p) => p.dataset.drum === type);
  if (!pad) return;
  const cls = `hit-${type}`;
  pad.classList.remove(cls);
  void pad.offsetWidth; // restart the CSS animation
  pad.classList.add(cls);
}

for (const pad of els.pads) {
  pad.addEventListener('pointerdown', () => {
    ensureAudio();
    performHit(pad.dataset.drum, 0.9);
  });
}

/* ---------- mic session ---------- */

async function startMicSession() {
  setStatus('Requesting microphone…');
  try {
    await startMic();
  } catch (err) {
    stopMic();
    if (els.micBtn) {
      els.micBtn.classList.remove('live');
      if (els.micLabel) els.micLabel.textContent = 'Start';
    }
    throw err;
  }
  if (els.micBtn) {
    els.micBtn.classList.add('live');
    els.micBtn.setAttribute('aria-pressed', 'true');
    if (els.micLabel) els.micLabel.textContent = 'Stop';
  }
  setStatus('Listening — beatbox away!');
}

function stopMicQuiet() {
  stopMic();
  if (els.micBtn) {
    els.micBtn.classList.remove('live');
    els.micBtn.setAttribute('aria-pressed', 'false');
    if (els.micLabel) els.micLabel.textContent = 'Start';
  }
}

function stopMicSession() {
  stopMicQuiet();
  setStatus('Press Record and beatbox — “B” kick · “Pss” snare · “Ts” hi-hat');
}

if (els.micBtn) {
  els.micBtn.addEventListener('click', async () => {
    if (micBusy) return;
    micBusy = true;
    try {
      if (!micOn) await startMicSession();
      else stopMicSession();
    } catch (err) {
      setStatus(friendlyMicError(err), true);
    } finally {
      micBusy = false;
    }
  });
}

function friendlyMicError(err) {
  if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
    return 'Microphone access denied — allow it in your browser settings and try again.';
  }
  if (err && err.name === 'NotFoundError') {
    return 'No microphone found on this device.';
  }
  return (err && err.message) || 'Could not start the microphone.';
}

function setStatus(text, isError = false) {
  els.statusText.textContent = text;
  els.statusText.classList.toggle('error', isError);
}

/* ---------- kit chips, style chips, sensitivity, guard, groove ---------- */

for (const chip of els.chips) {
  chip.addEventListener('click', () => {
    kitName = chip.dataset.kit;
    if (engine) engine.setKit(kitName);
    for (const c of els.chips) c.classList.toggle('active', c === chip);
    saveSettings();
  });
}

for (const chip of els.styleChips) {
  chip.addEventListener('click', () => {
    styleLevel = chip.dataset.style;
    if (recorder) recorder.setStyle(styleLevel);
    reflectStyleChips();
    updateRecCount();
    saveSettings();
  });
}

function reflectStyleChips() {
  if (!els.styleChips.length) return;
  const hasGroove = !!(recorder && recorder.groove);
  for (const c of els.styleChips) {
    c.classList.toggle('active', c.dataset.style === styleLevel);
    // without a grid there is nothing to snap to — only Raw applies
    c.disabled = !hasGroove && c.dataset.style !== 'raw' && !!(recorder && recorder.events.length);
  }
}

if (els.sensSlider) {
  els.sensSlider.addEventListener('input', () => {
    sensitivity = Number(els.sensSlider.value) / 100;
    applySensitivity();
    saveSettings();
  });
}

if (els.guardChk) {
  els.guardChk.addEventListener('change', () => {
    speakerGuard = els.guardChk.checked;
    applySensitivity();
    saveSettings();
  });
}

if (els.bpmInput) {
  els.bpmInput.addEventListener('change', () => {
    els.bpmInput.value = String(clampBpm(Number(els.bpmInput.value)));
    syncRecorderSettings();
    // nudging the BPM of an auto-detected loop re-fits its grid
    if (recorder && recorder.grooveSource === 'auto' && recorder.state === 'idle') {
      if (recorder.regrid(clampBpm(Number(els.bpmInput.value)))) {
        setStatus(`Re-gridded at ${recorder.loopBpm} BPM — ${recorder.bars()}-bar loop`);
        updateRecCount();
      }
    }
    saveSettings();
  });
}

if (els.metChk) {
  els.metChk.addEventListener('change', () => {
    syncRecorderSettings();
    saveSettings();
  });
}

/* ---------- loop recorder ---------- */

els.recBtn.addEventListener('click', async () => {
  ensureAudio();
  syncRecorderSettings();
  // pressing Record during playback = stop the loop and re-take
  if (recorder.state === 'playing') recorder.stopPlay();
  if (recorder.state === 'idle') {
    // Record should just work: bring the mic up if it isn't already
    let micFailNote = null;
    if (!micOn && !micBusy) {
      micBusy = true;
      try {
        await startMicSession();
      } catch (err) {
        micFailNote = friendlyMicError(err);
      } finally {
        micBusy = false;
      }
    }
    recorder.startRecord();
    if (micFailNote) setStatus(`${micFailNote} Recording without the mic.`, true);
  } else if (recorder.state === 'armed' || recorder.state === 'recording') {
    recorder.stopRecord();
  }
});

els.playBtn.addEventListener('click', () => {
  ensureAudio();
  syncRecorderSettings();
  if (recorder.state === 'playing') recorder.stopPlay();
  else if (recorder.state === 'idle') recorder.play(loopEnabled);
});

if (els.clearBtn) {
  els.clearBtn.addEventListener('click', () => {
    if (!recorder) return;
    recorder.clear();
    updateRecCount();
    updateTransportUI();
    reflectStyleChips();
  });
}

if (els.exportBtn) {
  els.exportBtn.addEventListener('click', async () => {
    if (!recorder || !recorder.events.length || recorder.state !== 'idle') return;
    els.exportBtn.disabled = true;
    setStatus('Rendering WAV…');
    try {
      const wav = await renderLoopWav({
        events: recorder.playableEvents(),
        loopDur: recorder.loopDur,
        kit: kitName,
        seamless: !!recorder.groove,
      });
      const blob = new Blob([wav], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = recorder.groove
        ? `beatbox-loop-${recorder.loopBpm}bpm-${kitName}.wav`
        : `beatbox-loop-${kitName}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setStatus('Loop exported as WAV ✓');
    } catch (err) {
      setStatus(`Export failed: ${(err && err.message) || err}`, true);
    } finally {
      els.exportBtn.disabled = false;
      updateTransportUI();
    }
  });
}

function onRecorderState(state) {
  // The mic is hot only while a take is being captured — release it as
  // soon as recording ends so nothing can trigger between takes.
  if (state === 'idle' && (prevRecorderState === 'recording' || prevRecorderState === 'armed') && micOn) {
    stopMicQuiet();
  }
  if (state === 'armed') {
    setStatus('Count-in — recording starts on the next “1”…');
  } else if (state === 'recording') {
    setStatus(micOn ? 'Recording — beatbox now… (you’ll hear the drums on Play)' : 'Recording — mic unavailable');
  } else if (state === 'playing') {
    setStatus('Playing your drums ▶');
  } else if (prevRecorderState === 'recording') {
    // just stopped a take — report what the conversion found
    if (!recorder.events.length) {
      setStatus('No hits captured — beatbox close to the mic with short, punchy sounds, then try again.', true);
    } else {
      let summary;
      if (recorder.grooveSource === 'auto') {
        summary = `Converted ✓ ${recorder.loopBpm} BPM · ${recorder.bars()}-bar drum loop`;
        if (els.bpmInput) {
          els.bpmInput.value = String(recorder.loopBpm);
          saveSettings();
        }
      } else if (recorder.grooveSource === 'metronome') {
        summary = `Loop locked to ${recorder.bars()} bar${recorder.bars() === 1 ? '' : 's'} at ${recorder.loopBpm} BPM`;
      } else {
        summary = `Captured ${recorder.events.length} hit${recorder.events.length === 1 ? '' : 's'}`;
      }
      setStatus(`${summary} — press ▶ Play`);
      els.playBtn.classList.add('ready');
      // Auto-play is disabled while the UI is minimal — Play is the star.
      // autoPlay(summary);
    }
  } else if (prevRecorderState === 'armed') {
    setStatus('Count-in cancelled — nothing recorded. Press ● Record to try again.');
  } else {
    setStatus(micOn ? 'Listening — beatbox away!' : 'Press Record and beatbox — “B” kick · “Pss” snare · “Ts” hi-hat');
  }
  if (state !== 'idle' || prevRecorderState !== 'recording') {
    if (state === 'playing' || state === 'recording' || state === 'armed') els.playBtn.classList.remove('ready');
  }
  prevRecorderState = state;
  updateRecCount();
  updateTransportUI();
  reflectStyleChips();
}

// Kept for when the fuller UI returns — plays the loop right after a take.
// eslint-disable-next-line no-unused-vars
function autoPlay(summary) {
  setTimeout(() => {
    if (!recorder || recorder.state !== 'idle' || !recorder.events.length) return;
    recorder.play(loopEnabled);
    if (recorder.state === 'playing') setStatus(`${summary} — playing ▶`);
  }, 120);
}

function updateRecCount() {
  if (!els.recCount) return;
  if (!recorder || (recorder.state === 'armed')) {
    els.recCount.textContent = recorder ? 'Get ready…' : 'No hits recorded';
    return;
  }
  if (recorder.state === 'recording') {
    const n = recorder.events.length;
    els.recCount.textContent = n ? `${n} hit${n === 1 ? '' : 's'} — keep going…` : 'Recording — waiting for your first hit…';
    return;
  }
  if (!recorder.events.length) {
    els.recCount.textContent = 'No hits recorded';
    return;
  }
  const n = recorder.playableEvents().length;
  const hits = `${n} hit${n === 1 ? '' : 's'}`;
  if (recorder.groove) {
    els.recCount.textContent = `${hits} · ${recorder.bars()}-bar loop @ ${recorder.loopBpm} BPM`;
  } else {
    els.recCount.textContent = `${hits} · loop ${recorder.loopDur.toFixed(2)} s`;
  }
}

function updateTransportUI() {
  const state = recorder ? recorder.state : 'idle';
  const hasEvents = !!(recorder && recorder.events.length);

  // Record stays available during playback: pressing it stops the loop
  // and immediately starts a new take.
  els.recBtn.disabled = false;
  els.recBtn.classList.toggle('recording', state === 'recording' || state === 'armed');
  els.recBtn.textContent = state === 'recording' ? '■ Stop' : state === 'armed' ? '■ Cancel' : '● Record';

  els.playBtn.disabled = state === 'recording' || state === 'armed' || (!hasEvents && state !== 'playing');
  els.playBtn.classList.toggle('playing', state === 'playing');
  els.playBtn.textContent = state === 'playing' ? '■ Stop' : '▶ Play';
  if (els.playBtn.disabled || state === 'playing') els.playBtn.classList.remove('ready');

  if (els.clearBtn) els.clearBtn.disabled = state !== 'idle' || !hasEvents;
  if (els.exportBtn) els.exportBtn.disabled = state !== 'idle' || !hasEvents;
  if (els.bpmInput) els.bpmInput.disabled = state !== 'idle';
  if (els.metChk) els.metChk.disabled = state !== 'idle';
}

/* ---------- keyboard shortcuts (desktop) ---------- */

const KEY_PADS = { a: 'kick', s: 'snare', d: 'hat' };

document.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' && e.target.type === 'number') return; // typing BPM
  const key = e.key.toLowerCase();
  if (KEY_PADS[key]) {
    ensureAudio();
    performHit(KEY_PADS[key], 0.9);
  } else if (key === 'r' && !els.recBtn.disabled) {
    els.recBtn.click();
  } else if (key === ' ' && e.target === document.body) {
    e.preventDefault();
    if (!els.playBtn.disabled) els.playBtn.click();
  }
});

/* ---------- debug toggle ---------- */

if (els.debugChk && els.debugLine) {
  els.debugChk.addEventListener('change', () => {
    els.debugLine.hidden = !els.debugChk.checked;
    saveSettings();
  });
}

/* ---------- waveform / meter / timeline animation ---------- */

(function animate() {
  meterLevel *= 0.88;
  if (els.meterFill) {
    const pct = Math.min(1, Math.sqrt(meterLevel * 6)) * 100;
    els.meterFill.style.width = `${pct}%`;
  }

  if (waveform) {
    waveform.sample();
    waveform.render({
      live: micOn || (recorder && recorder.state === 'playing'),
      recording: !!(recorder && (recorder.state === 'recording' || recorder.state === 'armed')),
    });
  }

  if (recorder && recorder.state === 'armed') {
    // visible countdown — count-in clicks are inaudible on muted phones
    const remaining = recorder.countInRemaining();
    if (remaining !== null) {
      const beats = Math.max(1, Math.ceil(remaining / (60 / recorder.bpm)));
      setStatus(`Count-in — ${beats}…`);
    }
  }

  if (timeline) {
    if (recorder && recorder.state === 'recording') {
      const elapsed = recorder.recordingElapsed();
      const dur = Math.max(2, elapsed);
      timeline.render({
        events: recorder.events,
        dur,
        playhead: Math.min(1, elapsed / dur),
        bpm: recorder.metronomeOn ? recorder.bpm : null,
        recording: true,
      });
    } else if (recorder) {
      timeline.render({
        events: recorder.playableEvents(),
        dur: recorder.loopDur || 1,
        playhead: recorder.playheadPos(),
        bpm: recorder.groove ? recorder.loopBpm : null,
      });
    } else {
      timeline.render({ events: [], dur: 1 });
    }
  }
  requestAnimationFrame(animate);
})();

/* ---------- init ---------- */

loadSettings();
updateTransportUI();
updateRecCount();

if ('serviceWorker' in navigator && window.isSecureContext) {
  const register = () => navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is best-effort */ });
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}
