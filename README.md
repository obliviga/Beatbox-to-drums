# Beatbox → Drums 🥁

Beatbox into your phone's microphone and hear yourself as an actual drum kit — acoustic, 808, trap, electro, lo-fi, or percussion. Everything runs live in the browser: no app install, no server, no audio ever leaves your device.

Make a **“B”** sound and a kick drum fires. **“Pss”** and you get a snare. **“Ts”** and a hi-hat plays. Record a bar-locked loop of your beat, quantize it, switch kits on it, and export it as a WAV for your DAW.

## Features

- 🎙️ **Live mic → drums** — real-time onset detection and hit classification (kick / snare / hi-hat) with velocity from how hard you hit
- 🥁 **Six kits, zero samples** — Acoustic, 808, Trap, Electro, Lo-Fi, and Percussion, fully synthesized with the Web Audio API
- 🔁 **Loop recorder** — free-time, or metronome mode with a 4-beat count-in and loops that lock to whole bars
- 🎯 **Quantize** — non-destructively snap playback to a 1/16 grid; mic latency is compensated at record time
- 📊 **Timeline** — see your loop on a three-lane grid with a live playhead
- 💾 **WAV export** — renders offline; bar-locked loops wrap their decay tails around so the file loops seamlessly in a DAW
- 🔊 **Speaker guard** — briefly gates detection after each drum sound so speakers can't re-trigger the mic (for playing without headphones)
- 🎚️ **Sensitivity control**, 👆 **tap pads**, ⌨️ **keyboard pads** (A/S/D, R to record, Space to play)
- 📱 **Installable PWA** — add it to your home screen, works offline
- 🔍 **Detection details** — optional readout of the spectral features behind each classification

## Quick start

Microphone capture requires a **secure context** (HTTPS, or `localhost`), so serve the folder rather than opening `index.html` directly:

```bash
npm start            # python3 http.server on :8000
# or any static server: npx serve .
```

Then open `http://localhost:8000`, tap **Start**, allow the mic, and beatbox.

**On a phone:** deploy anywhere with HTTPS — GitHub Pages works great (Settings → Pages → deploy from `main`, root). Open the URL on your phone, then “Add to Home Screen” to install it as an app. Plain `http://<laptop-ip>:8000` will *not* get mic access on a phone because it isn't a secure context.

**Use headphones**, or turn on **Speaker guard** so the drum output can't re-trigger the mic.

## How to play

| You say | You hear | Keyboard |
|---|---|---|
| “B” / “Puh” (lip plosive) | Kick | A |
| “Pss” / “Ka” (broadband burst) | Snare | S |
| “Ts” / “T” (sibilant) | Hi-hat | D |

Get close to the mic and keep sounds short and punchy. Turn on *Show detection details* to see exactly how your sounds are being read, and tune Sensitivity to your room.

**Making a loop:** enable *Metronome*, set a BPM, hit *Record* — you get a 4-beat count-in, then clicks while you record. Stop whenever; the loop rounds to whole bars, and a hit just past your stop point wraps around to the downbeat. *Quantize* snaps playback to 1/16s. *⬇ WAV* renders the loop to a file.

## How it works

```
mic ──► AudioWorklet onset detector ──► ~21 ms attack window
             (audio thread)                     │
                                                ▼
                            FFT features: centroid, band energy, ZCR
                                                │
                                                ▼
                             rule classifier: kick / snare / hat
                                                │
                                                ▼
                                DrumEngine synth voice (chosen kit)
```

1. **Onset detection** (`js/worklet/onset-processor.js`) runs on the audio rendering thread in 128-sample blocks. A hit is a block whose RMS jumps above both an adaptive noise floor and the previous block (rising edge), gated by a refractory period so one hit can't double-trigger. Browser voice processing (echo cancellation, noise suppression, AGC) is disabled on the mic stream because it smears exactly the transients we're looking for.
2. **Classification** (`js/classifier.js`) takes the first ~21 ms of the attack, applies a Hann window and a 2048-point FFT, and computes the spectral centroid, low/mid/high band ratios, and zero-crossing rate. A small rule tree maps those to a drum: bass-dominant and dark → kick, bright or noisy (sibilant) → hi-hat, broadband mid → snare.
3. **Synthesis** (`js/audio-engine.js`) plays the matching voice from the selected kit — the 808 hat is the classic six-detuned-squares metal stack, the trap kick is a long saturated sub, the electro snare is a triple-burst clap. Voices get subtle per-instrument stereo placement and velocity from your input level.
4. **Recording** (`js/recorder.js`) timestamps hits on the audio clock (compensating for the detection window), rounds metronome recordings up to whole bars with a grace window at the bar line, and re-schedules everything through the engine for playback. WAV export re-renders the loop through an `OfflineAudioContext` and folds post-loop decay back onto the loop start so exports cycle seamlessly.

End-to-end latency is roughly the 21 ms capture window plus the audio output buffer — tight enough to feel playable.

## Tuning

- **Sensitivity slider** — the main knob; raise it for quiet rooms/soft beatboxing, lower it if breathing or room noise triggers hits.
- **Classifier thresholds** — the constants at the top of `js/classifier.js` (`HAT_CENTROID_HZ`, `KICK_LOW_RATIO`, …). Use *Show detection details* to see the numbers for your own “B/Pss/Ts” sounds and adjust the boundaries to your voice.
- **Trigger timing** — `refractorySec` and `CAPTURE_SAMPLES` in `js/worklet/onset-processor.js` trade retrigger speed against classification accuracy.

## Development

The app itself has **no dependencies and no build step**. Dev tooling:

```bash
npm test        # unit tests (plain Node, no install needed)
npm install     # only needed for the browser smoke test
npm run smoke   # drives the full app in headless Chromium with a fake mic
```

- `test/unit/` covers the classifier (against synthesized kick/snare/hat waveforms), the onset detector (driven block-by-block, including an end-to-end capture→classify test), and the recorder's bar math, quantization, and WAV encoding.
- `test/smoke.mjs` exercises the real thing: mic start, all kits, count-in recording, quantized looped playback, WAV download, persistence, and the service worker.
- CI (`.github/workflows/ci.yml`) runs the unit tests on every push and PR.

## Project layout

```
index.html                     app shell
css/style.css                  mobile-first dark UI
js/main.js                     wiring: mic, pads, kits, recorder, timeline, PWA
js/classifier.js               FFT + spectral features + rule classifier
js/audio-engine.js             six synthesized drum kits + metronome click
js/recorder.js                 loop recorder, quantize, WAV encode/render
js/metronome.js                look-ahead click scheduler
js/timeline.js                 canvas loop view
js/worklet/onset-processor.js  audio-thread onset detector
sw.js / manifest.json / icons  PWA install + offline
test/                          unit tests + headless-browser smoke test
```

## Roadmap ideas

- Tiny on-device ML classifier for more sounds: toms, rimshots, clap vs. snare, open vs. closed hat
- Sample-based kits and user-loadable kits
- Web MIDI out — use your voice to drive a DAW or hardware sampler
- Overdub mode and per-hit editing on the timeline
- Share loops (MIDI export, `navigator.share`)
