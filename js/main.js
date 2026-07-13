/**
 * Beatbox → Drums — app wiring.
 *
 * Pipeline: mic → AudioWorklet onset detector → attack window →
 * classifier (kick/snare/hat) → DrumEngine synth voice.
 * Plus: kit selection, sensitivity, level meter, and a simple loop recorder.
 */

import { DrumEngine } from './audio-engine.js';
import { analyzeHit, classifyHit } from './classifier.js';

const els = {
  micBtn: document.getElementById('micBtn'),
  micLabel: document.getElementById('micLabel'),
  statusText: document.getElementById('statusText'),
  meterFill: document.getElementById('meterFill'),
  pads: Array.from(document.querySelectorAll('.pad')),
  chips: Array.from(document.querySelectorAll('.chip')),
  sensSlider: document.getElementById('sensSlider'),
  recBtn: document.getElementById('recBtn'),
  playBtn: document.getElementById('playBtn'),
  loopChk: document.getElementById('loopChk'),
  clearBtn: document.getElementById('clearBtn'),
  recCount: document.getElementById('recCount'),
  debugChk: document.getElementById('debugChk'),
  debugLine: document.getElementById('debugLine'),
};

let ctx = null;
let engine = null;
let workletReady = false;
let workletNode = null;
let micStream = null;
let micSource = null;
let micOn = false;
let micBusy = false;

let kitName = 'acoustic';
let sensitivity = Number(els.sensSlider.value) / 100;

// Loop recorder state
let recording = false;
let recStart = 0;
let events = [];
let playing = false;
let playbackTimers = [];

let meterLevel = 0;

/* ---------- audio setup ---------- */

function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    engine = new DrumEngine(ctx);
    engine.setKit(kitName);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
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
  // sensitivity 0..1 → gentler/stricter gates
  workletNode.port.postMessage({
    type: 'config',
    thresholdRatio: 12 - 9 * sensitivity, // 12 (strict) → 3 (hair trigger)
    minRms: 0.03 - 0.024 * sensitivity,   // 0.03 → 0.006
  });
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
    performHit(type, velocity, features);
  }
}

/* ---------- hits, pads, debug ---------- */

function performHit(type, velocity, features) {
  engine.trigger(type, { velocity });
  flashPad(type);
  if (recording) {
    events.push({ t: (performance.now() - recStart) / 1000, type, velocity });
    updateRecCount();
  }
  if (features && !els.debugLine.hidden) {
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
    performHit(pad.dataset.drum, 0.9, null);
  });
}

/* ---------- mic button ---------- */

els.micBtn.addEventListener('click', async () => {
  if (micBusy) return;
  micBusy = true;
  try {
    if (!micOn) {
      setStatus('Requesting microphone…');
      await startMic();
      els.micBtn.classList.add('live');
      els.micBtn.setAttribute('aria-pressed', 'true');
      els.micLabel.textContent = 'Stop';
      setStatus('Listening — beatbox away!');
    } else {
      stopMic();
      els.micBtn.classList.remove('live');
      els.micBtn.setAttribute('aria-pressed', 'false');
      els.micLabel.textContent = 'Start';
      setStatus('Tap Start and allow microphone access');
    }
  } catch (err) {
    stopMic();
    els.micBtn.classList.remove('live');
    els.micLabel.textContent = 'Start';
    setStatus(friendlyMicError(err), true);
  } finally {
    micBusy = false;
  }
});

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

/* ---------- kit chips & sensitivity ---------- */

for (const chip of els.chips) {
  chip.addEventListener('click', () => {
    kitName = chip.dataset.kit;
    if (engine) engine.setKit(kitName);
    for (const c of els.chips) c.classList.toggle('active', c === chip);
  });
}

els.sensSlider.addEventListener('input', () => {
  sensitivity = Number(els.sensSlider.value) / 100;
  applySensitivity();
});

/* ---------- loop recorder ---------- */

els.recBtn.addEventListener('click', () => {
  if (playing) return;
  recording = !recording;
  if (recording) {
    events = [];
    recStart = performance.now();
    els.recBtn.textContent = '■ Stop';
    els.recBtn.classList.add('recording');
    setStatus(micOn ? 'Recording — beatbox or tap the pads' : 'Recording — tap the pads (mic is off)');
  } else {
    els.recBtn.textContent = '● Record';
    els.recBtn.classList.remove('recording');
    setStatus(micOn ? 'Listening — beatbox away!' : 'Tap Start and allow microphone access');
  }
  updateRecCount();
  updateTransportButtons();
});

els.playBtn.addEventListener('click', () => {
  if (playing) {
    stopPlayback();
  } else if (events.length) {
    startPlayback();
  }
});

els.clearBtn.addEventListener('click', () => {
  if (playing) stopPlayback();
  events = [];
  updateRecCount();
  updateTransportButtons();
});

function startPlayback() {
  ensureAudio();
  playing = true;
  els.playBtn.textContent = '■ Stop';
  els.playBtn.classList.add('playing');
  updateTransportButtons();
  scheduleLoopPass();
}

function scheduleLoopPass() {
  const t0 = ctx.currentTime + 0.1;
  let lastT = 0;
  for (const e of events) {
    engine.trigger(e.type, { when: t0 + e.t, velocity: e.velocity, track: true });
    playbackTimers.push(setTimeout(() => flashPad(e.type), (e.t + 0.1) * 1000));
    if (e.t > lastT) lastT = e.t;
  }
  const durationMs = (lastT + 0.7) * 1000;
  playbackTimers.push(setTimeout(() => {
    playbackTimers = [];
    if (playing && els.loopChk.checked) scheduleLoopPass();
    else stopPlayback();
  }, durationMs));
}

function stopPlayback() {
  playing = false;
  for (const t of playbackTimers) clearTimeout(t);
  playbackTimers = [];
  if (engine) engine.stopScheduled();
  els.playBtn.textContent = '▶ Play';
  els.playBtn.classList.remove('playing');
  updateTransportButtons();
}

function updateRecCount() {
  els.recCount.textContent = events.length
    ? `${events.length} hit${events.length === 1 ? '' : 's'} recorded`
    : 'No hits recorded';
}

function updateTransportButtons() {
  els.playBtn.disabled = recording || (!playing && events.length === 0);
  els.clearBtn.disabled = recording || events.length === 0;
  els.recBtn.disabled = playing;
}

/* ---------- debug toggle & level meter ---------- */

els.debugChk.addEventListener('change', () => {
  els.debugLine.hidden = !els.debugChk.checked;
});

(function meterLoop() {
  meterLevel *= 0.88;
  const pct = Math.min(1, Math.sqrt(meterLevel * 6)) * 100;
  els.meterFill.style.width = `${pct}%`;
  requestAnimationFrame(meterLoop);
})();

updateTransportButtons();
