# Beatbox → Drums 🥁

Beatbox into your phone's microphone and hear yourself as an actual drum kit — acoustic, 808, trap, electro, lo-fi, or percussion. Everything runs live in the browser: no app install, no server, and audio never leaves your device — except the optional **✨ Restyle with AI** feature, which sends your rendered beat (never the raw mic recording) to a generative audio model only when you tap Generate, using your own API key.

> **Current UI: intentionally minimal.** While the core record → convert → play flow gets solid, the interface shows a **Record button**, a **live waveform**, **▶ Original** (plays back the raw audio you actually recorded), **▶ Drums** (plays the converted beat on the real sampled kit), and **🎯 Tune to my voice**. Recording is silent capture — you hear the drums only on ▶ Drums — and the mic is active only while a take (or tuning) is in progress. The features described below (kits, pads, sensitivity, metronome, beat styles, timeline, WAV export, …) still exist and are unit-tested — their markup is commented out in `index.html`, and `js/main.js` re-enables each section automatically when uncommented.

> **Accuracy — context, not training.** When you stop a take, the app analyzes the **whole clip**: onsets are detected with thresholds derived from the clip itself, every hit's spectral features are extracted, and the hits are **clustered against each other** (k-means, merged by instrument-similarity). Your kicks sound like each other far more than they sound like any fixed template — so the clusters are found first, then labeled kick/snare/hat by majority vote with a darkest→kick, brightest→hat ordering. One oddly-pronounced hit gets outvoted by its cluster siblings instead of being misread alone. No training step, no stored profile — every take self-calibrates. The **▶ Original / ▶ Drums** pair lets you A/B what you said against what it heard.

> **Expression carries over — your groove is the groove.** The default conversion style is **Faithful**: every hit plays at its original micro-timing (swing and feel intact — nothing is snapped to a grid), with dynamics from each hit's peak *and* energy relative to the take's own loudest hit (ghost notes stay whispered, accents smack, velocity picks between five real recorded layers per drum). Hit *duration* is captured too — a short “ts” is a closed hat, while a hat still ringing when the next hit lands becomes a real **open hi-hat**, choked by the next hat strike exactly like a pedal. Only accidental double-triggers are cleaned. The grid-snapping and beat-template styles (Tight/Clean/Full) still exist behind the hidden style chips for when you *want* machine-quantization or generated fills.

Make a **“B”** sound and a kick drum fires. **“Pss”** and you get a snare. **“Ts”** and a hi-hat plays. Record a loop with zero setup — the app detects your tempo by itself and hands the beat back quantized — then switch kits on it and export it as a WAV for your DAW.

## Features

- 🎙️ **Live mic → drums** — real-time onset detection and hit classification (kick / snare / hi-hat) with velocity from how hard you hit
- 🥁 **Real Kit** — a professionally recorded acoustic drum kit (GMRockKit by Glen MacArthur, from the Hydrogen drum machine): five true velocity layers per drum, chosen by how hard you beatboxed, with subtle playback-rate humanization so fast rolls never machine-gun. Falls back to synthesis if the samples haven't loaded yet
- 🎛️ **Six synthesized kits** — Acoustic, 808, Trap, Electro, Lo-Fi, and Percussion, generated with the Web Audio API (currently behind the hidden kit picker)
- ✨ **Auto-beat** — one button: Record starts the mic if needed; when you stop, the tempo is detected from your hit timing, bar 1 anchors on your first kick, the loop locks to whole bars and starts playing immediately. Nudge the BPM afterwards to re-grid
- 🪜 **Beat style ladder** — non-destructive, from simple to complex: **Raw** (exactly as played) · **Tight** (snapped to 1/16s) · **Clean** (snapped + accidental doubles merged) · **Full** (adds hi-hats on 8ths, backbeat snares, bar-start kicks — a produced beat from your sketch)
- 🔁 **Metronome mode** — optional 4-beat count-in with clicks, for when you want to record to a fixed grid
- 📊 **Timeline** — see your loop on a three-lane grid with a live playhead
- 💾 **WAV export** — renders offline; bar-locked loops wrap their decay tails around so the file loops seamlessly in a DAW
- ✨ **AI restyle (optional)** — one tap sends your rendered beat to a generative audio model (Stability AI *Stable Audio 2*, audio-to-audio) and returns one produced, reimagined take you can play and save. Uses your own API key through your own tiny relay — see [AI restyle setup](#-ai-restyle-optional)
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

**Making a loop:** just hit *Record* and beatbox — no setup, and the mic starts automatically if it isn't on. When you stop, the app detects your tempo, locks the loop to whole bars (bar 1 starts on your first kick; anything you played before it wraps to the loop's end as a pickup), and **immediately starts playing it back** at the selected **beat style**. Flip between Raw / Tight / Clean / Full any time — your original take is always kept. If the detected BPM isn't what you meant (e.g. it heard your 8ths as 16ths), nudge the BPM field and the loop re-grids. Pressing *Record* during playback stops the loop and starts a fresh take. *⬇ WAV* renders the loop to a file.

Prefer recording to a click? Enable *Metronome*, set a BPM, and Record gives you a 4-beat count-in first, with a visible countdown (handy when the phone is muted). Pressing the button during the count-in cancels without touching your previous loop. If no steady tempo can be heard in a free take (it needs ~6+ hits with intentional timing), the take stays available raw.

## ✨ AI restyle (optional)

The converter maps your mouth sounds onto drum samples. **Restyle with AI** goes one step further: it hands your beat to a generative audio model (Stability AI's **Stable Audio 2**, audio-to-audio) and gets back one fully *produced* take that follows your rhythm but reimagines the sound. One tap = one take, generated with **your own API key** — there's no shared backend and nothing to subscribe to in the app.

**One-time setup (~2 minutes):**

1. **Get a Stability AI key** at [platform.stability.ai](https://platform.stability.ai) — new accounts include free credits, and after that a take costs on the order of a few cents.
2. **Deploy the relay**: browsers can't call `api.stability.ai` directly (no CORS), so you run your own tiny forwarder. On [dash.cloudflare.com](https://dash.cloudflare.com) → *Workers & Pages* → *Create Worker*, paste the contents of [`worker/relay.js`](worker/relay.js), and deploy — the free tier is far more than enough. The worker only forwards the one endpoint the app uses; it is not a general-purpose proxy.
3. **Point the app at it**: record a beat, tap **✨ Restyle with AI**, and paste your `https://….workers.dev` URL. For the key, either store it in the worker as a secret named `STABILITY_API_KEY` (*Settings → Variables* — recommended, the key never touches the browser), or paste it into the app, where it's kept in `localStorage` and sent only to *your* relay.

Then tap **✨ Generate one take** (15–40 s), and play or save the result alongside your original and the sample-based conversion. The style prompt is editable — try "boom bap drum break, dusty vinyl" or "tight metal kit, roomy toms".

**Privacy:** this is the only feature that sends audio anywhere. What's uploaded is the *rendered drum loop* (the same thing ⬇ Save exports — never your raw voice recording), it happens only when you tap Generate, and it goes to your own relay and on to the AI provider. Everything else in the app stays 100% on-device.

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
2. **Conversion** happens on the whole take (`js/clip-analysis.js`): the raw audio (streamed off the audio thread during recording, also used for ▶ Original) is scanned for onsets with clip-relative thresholds; each hit's features (`js/classifier.js`: centroid, band ratios, zero-crossing rate, flatness, rolloff over a 2048-point FFT of the attack) feed a per-clip clustering — k-means in the clip's own z-space, clusters merged when they're variants of one instrument (fixed-scale distance, measured empirically), labeled by rule-tree majority vote with brightness-ordered conflict resolution. The live rule tree still powers the during-recording hit counter and mic-less (keyboard) takes.
3. **Playback** (`js/audio-engine.js`, `js/sample-kit.js`) routes each hit to the selected kit. The default **Real Kit** plays recorded samples: your hit velocity picks one of five true velocity layers (soft strokes are *different recordings*, not quieter copies — boundaries come from the kit's own Hydrogen definition), a gentle gain slope smooths the steps, and ±1.5% playback-rate humanization keeps fast rolls from repeating bit-identical audio. Every voice then runs through a **production chain**: per-drum sends into a shared room reverb (impulse response generated in code — decorrelated decaying noise, darkening tail), parallel "New York" compression for density without killing transients, subtle tanh saturation, and a limiter. The default beat style is **Full**, so a sparse take comes back as a produced groove (hats on 8ths with deterministic velocity wobble, backbeat snares, bar-start kicks); your literal hits remain available via ▶ Original and the Raw style. The synthesized kits remain as an instant fallback while samples load.
4. **Tempo detection** (`js/groove.js`) needs no audio — just your hit times. Every candidate pulse is scored with circular statistics: map hit times onto a circle whose circumference is the candidate step; if the hits sit on that grid, their phases cluster and the resultant vector is long. The best largest step becomes the sixteenth note (octave-folded into a musical range), and the grid phase falls out of the same math. Three gates keep random timing from producing a fake grid — resultant length, grid inliers, and inter-onset-interval consistency (real rhythms space hits near whole multiples of the pulse). The thresholds were tuned by Monte-Carlo simulation: ~5% false positives on 12 random hits while accepting ≥99.5% of patterns with ±20–30 ms of human jitter.
5. **Recording** (`js/recorder.js`) timestamps hits on the audio clock (compensating for the detection window), feeds both free and metronome takes through the same groove pipeline, and derives the four style levels non-destructively — Clean merges same-slot doubles, Full generates hats/backbeat/downbeat kicks using the velocities of your own playing. WAV export re-renders the loop through an `OfflineAudioContext` and folds post-loop decay back onto the loop start so exports cycle seamlessly.

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

- `test/unit/` covers the classifier (against synthesized kick/snare/hat waveforms), the onset detector (driven block-by-block, including an end-to-end capture→classify test), the groove analysis (tempo detection with jitter, pickup wrapping, style ladder, random-timing rejection), the recorder's bar math and WAV encoding, and the AI-restyle client (request format, config persistence, error mapping — with an injected `fetch`, no network).
- `test/smoke.mjs` exercises the real thing: mic start, all kits, auto-beat detection from timed taps, the style ladder, re-gridding, count-in recording, WAV download, persistence, the service worker, and the AI restyle flow against a route-intercepted mock relay (no real network).
- CI (`.github/workflows/ci.yml`) runs the unit tests on every push and PR.

## Project layout

```
index.html                     app shell
css/style.css                  mobile-first dark UI
js/main.js                     wiring: mic, pads, kits, recorder, timeline, PWA
js/clip-analysis.js            whole-take conversion: onsets + clustering
js/classifier.js               FFT + spectral features + rule classifier
js/audio-engine.js             sampled + synthesized kits, metronome click
js/sample-kit.js               real-kit manifest, loader, velocity layers
samples/real/                  GMRockKit kick/snare/hat (see LICENSE.md there)
js/groove.js                   tempo detection + grid fitting + beat styles
js/recorder.js                 loop recorder, WAV encode/render
js/neural.js                   AI restyle client (config, request, errors)
worker/relay.js                copy-paste Cloudflare Worker: CORS relay for the AI API
js/metronome.js                look-ahead click scheduler
js/timeline.js                 canvas loop view
js/worklet/onset-processor.js  audio-thread onset detector
sw.js / manifest.json / icons  PWA install + offline
test/                          unit tests + headless-browser smoke test
```

## Sample credits

The Real Kit uses the kick, snare, and closed hi-hat of **GMRockKit** — recorded by **Glen MacArthur** ([AVL Drumkits](https://x42-plugins.com/x42/x42-avldrums)) / Sebastian Moors — which ships with the [Hydrogen drum machine](https://github.com/hydrogen-music/hydrogen) under the GNU GPL. See `samples/real/LICENSE.md` for details. Thanks for recording a great-sounding kit and sharing it freely.

## Roadmap ideas

- Tiny on-device ML classifier for more sounds: toms, rimshots, clap vs. snare, open vs. closed hat
- Sample-based kits and user-loadable kits
- Web MIDI out — use your voice to drive a DAW or hardware sampler
- Overdub mode and per-hit editing on the timeline
- Share loops (MIDI export, `navigator.share`)
