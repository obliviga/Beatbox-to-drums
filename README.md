# Beatbox → Drums 🥁

Beatbox into your phone's microphone and hear yourself as an actual drum kit — acoustic, 808, or electro. Everything runs live in the browser: no app install, no server, no audio ever leaves your device.

Make a **“B”** sound and a kick drum fires. **“Pss”** and you get a snare. **“Ts”** and a hi-hat plays. Record a loop of your beat, switch kits, and play it back.

## Features

- 🎙️ **Live mic → drums** — real-time onset detection and hit classification (kick / snare / hi-hat)
- 🥁 **Three kits, zero samples** — Acoustic, 808, and Electro kits are fully synthesized with the Web Audio API
- 🔁 **Loop recorder** — record your hits (mic or pad taps), play them back, loop them, switch kits on the recorded beat
- 🎚️ **Sensitivity control** — tune the trigger threshold to your mic and room
- 👆 **Tap pads** — audition sounds or finger-drum without the mic
- 🔍 **Detection details** — optional readout of the spectral features behind each classification

## Quick start

Microphone capture requires a **secure context** (HTTPS, or `localhost`), so serve the folder rather than opening `index.html` directly:

```bash
# any static server works — pick one:
npx serve .
# or
python3 -m http.server 8000
```

Then open `http://localhost:8000`, tap **Start**, allow the mic, and beatbox.

**On a phone:** deploy anywhere with HTTPS (GitHub Pages works great — Settings → Pages → serve from this branch/root), then open the URL on your phone. Plain `http://<laptop-ip>:8000` will *not* get mic access on a phone because it isn't a secure context.

**Use headphones.** With speakers, the drum sounds can feed back into the mic and re-trigger themselves.

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
3. **Synthesis** (`js/audio-engine.js`) plays the matching voice from the selected kit — e.g. the 808 kick is a saturated sine with a pitch drop; the 808 hat is the classic six-detuned-squares metal stack. Hit velocity follows how hard you hit the mic.

End-to-end latency is roughly the 21 ms capture window plus the audio output buffer — tight enough to feel playable.

## Tuning

- **Sensitivity slider** — the main knob; raise it for quiet rooms/soft beatboxing, lower it if breathing or room noise triggers hits.
- **Classifier thresholds** — the constants at the top of `js/classifier.js` (`HAT_CENTROID_HZ`, `KICK_LOW_RATIO`, …). Turn on *Show detection details* in the app to see the centroid/ZCR/band numbers for your own “B/Pss/Ts” sounds and adjust the boundaries to your voice.
- **Trigger timing** — `refractorySec` and `CAPTURE_SAMPLES` in `js/worklet/onset-processor.js` trade retrigger speed against classification accuracy.

## Browser support

Any modern browser with `AudioWorklet` and `getUserMedia`: Chrome/Edge, Firefox, and Safari ≥ 14.5 (iOS included). On iOS, audio starts only after a tap — the Start button handles that.

## Roadmap ideas

- ML classifier (tiny on-device model) for more sounds: toms, rimshots, clap vs. snare
- Sample-based kits and user-loadable kits
- Web MIDI out — use your voice to drive a DAW or hardware sampler
- Quantize + tempo grid, export loops as audio/MIDI
- PWA install for offline use

## Project layout

```
index.html                     app shell
css/style.css                  mobile-first dark UI
js/main.js                     wiring: mic, pads, kits, recorder, meter
js/classifier.js               FFT + spectral features + rule classifier
js/audio-engine.js             synthesized drum kits (acoustic / 808 / electro)
js/worklet/onset-processor.js  audio-thread onset detector
```

No build step, no dependencies.
