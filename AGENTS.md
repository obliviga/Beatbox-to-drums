# AGENTS.md — Beatbox → Drums: full project handoff

> **Who this file is for:** any AI coding agent (Codex, Claude Code, Cursor, aider, …) or human
> picking up this project without access to its development history. It contains everything a
> long-running agent session knew: what the product is, how the owner likes to work, the
> architecture with its tuned constants *and the reasons behind them*, the bugs that were already
> fought and won (do not re-fight them), the AI feature's exact wiring and costs, the test
> strategy, and the July 2026 competitive landscape. Codex reads this file automatically; other
> tools can be pointed at it.

---

## 1. What this product is

**Beatbox → Drums** is a free, phone-first **web app** (installable PWA, no App Store, no build
step, no framework, no backend). The user beatboxes into their phone mic and gets back:

1. **A faithful drum conversion** — on-device DSP turns the *whole take* into a performance on a
   professionally sampled acoustic kit, preserving exact micro-timing, dynamics/ghost notes,
   open vs closed hi-hats, buzz rolls, and performed ambience. No training, no calibration, no
   metronome required (tempo is auto-detected).
2. **Optionally, one hi-fi AI-generated track** — one tap sends the *rendered drum loop* (never
   the voice recording) to Stability AI's **Stable Audio 2.5** (audio-to-audio) via the user's
   own Cloudflare Worker relay + API key, returning a fully produced 44.1 kHz stereo WAV that
   follows the performed rhythm. ~$0.20 per generation, user's own key.

Current UI is deliberately minimal (three actions): **● Record**, **▶ Original** (raw take,
volume-normalized), **✨ Generate AI track** (+ ▶/⬇ for the result, ⚙ for settings). Everything
else (▶ Drums direct playback, kit picker, beat styles, WAV export, metronome, pads, timeline,
sensitivity, debug) is **commented out of `index.html`, not deleted** — see §9.

- **Repo:** `obliviga/Beatbox-to-drums` on GitHub. **Deploy:** GitHub Pages serves `main`
  (root). There is no other deploy step — push to `main` = deploy.
- **Current release:** `v21 · 2026-07-20` (footer) / SW cache `b2d-v21`.
- **Stack:** vanilla ES modules + Web Audio API. Only dev dependency: `playwright-core` (smoke
  test). `npm start` = `python3 -m http.server 8000`.

## 2. How to work with the product owner

Learned over the whole project — follow these unless told otherwise:

- **Commit directly to `main`** (owner's explicit instruction: "just commit to main"). No PRs
  unless asked. After pushing `main`, **also sync the branch**
  `claude/box-drum-converter-app-cdxrdo`:
  `git push -u origin main && git push origin main:claude/box-drum-converter-app-cdxrdo`.
- The owner granted broad autonomy ("you have free rein to make this app the best it can be")
  but has strong product taste — when they state a UI/product preference, it is a hard
  requirement, not a suggestion. Preferences they have stated explicitly:
  - **Minimal UI.** They asked twice to pare the interface down. Don't add visible controls
    without being asked; hide new complexity behind existing affordances.
  - **Silent capture.** "Don't play anything back while I'm recording." Recording must never
    monitor drums live.
  - **No training/setup.** "It should just work based off the context of the entire audio
    clip." Never add a calibration step to the main flow.
  - **Fidelity above all.** "Super high fidelity", "use whatever technology you can". Prefer
    lossless (WAV end-to-end), real recorded samples, the best model tier.
  - **The performance is sacred.** The complaint that triggered the biggest rework: "the timing
    and groove is completely off… as if the analyzer doesn't know how to play drums." The
    default style is `faithful` — never quantize or embellish by default.
  - **One AI take per tap.** They explicitly rejected generating 3 takes.
  - **Cost-consciousness.** They asked "how much will it cost me?" — keep the
    own-API-key/~$0.20 model; don't introduce subscriptions or a hosted backend.
- The owner tests **on their phone** via GitHub Pages. That's why the footer shows the version
  string — they use it to confirm a deploy landed. Always bump it (see §11) on user-visible
  changes, or they will think the deploy failed.
- They usually can't watch logs; **status messages are the product's voice**. Every state should
  tell them what to do next (see `READY_HINT` convention, §9).
- Commit messages in this repo are long and narrative (what + why). Keep that style.

## 3. Golden rules (things that must stay true)

1. **The raw voice recording never leaves the device.** The only upload, ever, is the rendered
   drum-loop WAV to the user's own relay when they tap Generate. This is stated in the footer,
   the AI panel, the README, and code comments. Breaking it is a product betrayal.
2. **No build step, no frameworks, no runtime dependencies.** Plain ES modules served statically.
3. **`js/version.js` `VERSION` and `sw.js` `CACHE` bump together** on every release
   (`'v21 · 2026-07-20'` ↔ `'b2d-v21'`). One without the other = stale caches or a lying footer.
4. **Hidden-features pattern:** UI sections are commented out in `index.html`; `js/main.js`
   null-guards every element (`if (els.x)`, `els.x?.value`, empty-array chips). Uncommenting
   HTML re-enables a feature with zero JS changes. When adding elements, keep this invariant.
5. **`CAPTURE_SAMPLES = 1024` in `js/main.js` must match `js/worklet/onset-processor.js`.**
6. **`AUDIO_API_PATH` in `js/neural.js` must match the single entry in `worker/relay.js`
   `ALLOWED_PATHS`** (`/v2beta/audio/stable-audio-2/audio-to-audio`).
7. **Sample files are GPL** (GMRockKit from Hydrogen, recorded by Glen MacArthur / Sebastian
   Moors). Keep `samples/real/LICENSE.md` accurate, including the rename mapping
   (`Kick-Softest.wav → kick_1.wav`, etc.). Don't mix in non-GPL-compatible samples silently.
8. **Keep the tests green:** 72 unit tests (`npm test`, dependency-free) + the Playwright smoke
   test (`npm install && npm run smoke`). CI runs unit tests only (Node 22).
9. **Two audio paths on purpose** (§9): Web Audio graph for drums; `<audio>` media elements for
   Original and AI playback. Never "simplify" this — it exists because of phone speaker routing.
10. **`js/local-config.js` is gitignored by design and must never be committed** (nor may the
    owner's relay URL or any API key be hardcoded anywhere tracked). It's the optional dev-time
    file (see `js/local-config.example.js`) that pre-fills the ✨ settings via
    `setLocalDefaults()`; the public deployment ships without it, so downloads of the repo can't
    spend the owner's credits. Saved ⚙-panel settings always override it. The smoke test
    deliberately ignores its 404 console error on clean checkouts.

## 4. Repo map

```
index.html                     app shell; large commented-out feature blocks (see §9)
css/style.css                  mobile-first dark UI; styles hidden features too
js/main.js                     all wiring: mic, recorder, playback, AI, settings (no exports)
js/clip-analysis.js            THE conversion brain: whole-take onsets + clustering (§6)
js/classifier.js               FFT features + live rule-tree classifier + voice-profile k-NN
js/groove.js                   tempo detection (circular stats) + style ladder (§7)
js/recorder.js                 LoopRecorder state machine + offline WAV render/encode (§7)
js/audio-engine.js             DrumEngine: synth kits + sample playback + production chain (§8)
js/sample-kit.js               REAL_KIT_MANIFEST + loader + layerIndex (velocity layers)
js/neural.js                   ✨ AI engines: Stable Audio generator (active) + Claude composer (dormant) (§10)
worker/relay.js                copy-paste Cloudflare Worker: CORS relay to api.stability.ai
js/worklet/onset-processor.js  audio-thread onset detector + raw-audio streamer
js/metronome.js                look-ahead click scheduler (hidden feature)
js/timeline.js                 4-lane beat map canvas (hidden feature)
js/waveform.js                 scrolling amplitude bars canvas
js/version.js                  VERSION string (footer; lockstep with sw.js)
sw.js                          stale-while-revalidate SW; CACHE name + ASSETS precache list
manifest.json, icons/          PWA install bits
samples/real/                  40 WAVs: 8 drums × 5 velocity layers + LICENSE.md (GPL)
test/unit/*.test.mjs           72 node:test tests (see §12)
test/smoke.mjs                 headless-Chromium end-to-end script (see §12)
.github/workflows/ci.yml       push/PR → unit tests on Node 22 (no install)
README.md                      user-facing docs incl. AI setup walkthrough
```

## 5. Architecture & data flow

```
                     ┌── live path (while recording) ────────────────────────────┐
mic ─► AudioWorklet onset-processor ─► 1024-sample attack ─► classifier rule tree │
      (audio thread; also streams     (hit counter UI only during capture — silent)│
       raw audio in 8192 chunks)                                                   │
                     └─────────────────────────────────────────────────────────────┘
on stop ─► finalizeRawTake: chunks → mono AudioBuffer (also powers ▶ Original)
        ─► analyzeClip(wholeTake)  ← THE conversion (§6): onsets → features →
                                      clustering → labels → articulations
        ─► recorder.replaceTake(events) → detectGrid/buildGroove (§7)
        ─► showTakeSummary ("Converted ✓ 122 BPM · 2-bar drum loop · heard 4 sounds → …")

playback: events ─► DrumEngine.trigger (sampled kit, velocity layers, choke, §8)
                    └─► production chain ─► speakers
✨ Generate: playableEvents tiled to ≥8 s ─► renderLoopWav (OfflineAudioContext)
             ─► generateAudio() ─► user's relay ─► Stable Audio 2.5 ─► WAV blob
             ─► <audio> element playback + ⬇ save as beatbox-ai-<bpm>bpm.wav
```

Event shape everywhere: `{t, type, velocity}` + optional `duration`, `ambience`, `roll`.
Types: `kick, snare, hat, openhat, tom, tomfloor, rimshot, crash` (`DRUM_TYPES` in neural.js;
same 8 drums in sw.js SAMPLES and the manifest).

## 6. The conversion brain — `js/clip-analysis.js` (+ `js/classifier.js`)

**Philosophy (owner-driven):** no training, no fixed thresholds — every take self-calibrates.
Your kicks sound like each other more than like any template, so hits are **clustered against
each other** first, then labeled. `analyzeClip(samples, sampleRate) → {events, sounds}`.

Pipeline (all pure functions, Node-testable):

1. **Envelope:** per-128-sample RMS, then a causal 4-frame (~11 ms) moving average.
   *Why:* a 55 Hz kick ripples the raw 2.7 ms envelope at 2× its frequency → phantom onsets.
2. **Novelty:** `nov[f] = max(0, env[f] − max(env[f−3], env[f−4]))` — reference beyond the
   smoothing window so the full step registers.
3. **Noise floor:** median of **ALL** novelty frames (zeros included). *Why:* on clean
   recordings novelty is exactly 0 between hits; median-of-positives would be the hits
   themselves and 3× that gates everything (this bug actually happened).
   `novThr = max(3·median, 0.04·peakEnv)` — deliberately hair-triggered so ghost notes get in;
   clustering downstream tolerates soft extras. `envThr = max(0.003, 0.055·peakEnv)`.
4. **Peak picking:** local nov maximum, min separation `MIN_SEP_SEC = 0.048` (supports 120 BPM
   16th triplets ≈ 83 ms and rolls). Per hit also measures `duration` and `sustain`.
5. **Features per hit:** `classifier.analyzeHit` on a `BODY_SAMPLES = 2048` window — the *body*,
   not the attack. *Why:* through a phone mic the first ~20 ms of every mouth sound is broadband
   pop/hiss; a kick only reveals itself once the body develops (this fixed the
   "everything is a hi-hat" bug). Plus `lowBandFeatures` (80 ms): bass ratio `low80` and
   `lowPitch` = **envelope-gated** low-band zero-crossing rate. *Key insight:* crossings happen
   at amplitude ≈ 0, so gate on a 5 ms *envelope* of the low band (≥ 0.15·lowPeak), skip the
   first 8 ms of attack — gating on instantaneous amplitude would skip every crossing you're
   trying to count.
6. **Clustering:** k-means (deterministic: k-means++ from seeded mulberry32, seeds 1–3,
   best-of-3 by inertia) over z-scored 10-dim features; k = 1..`MAX_SOUNDS`(6) chosen by
   silhouette; below `MIN_SILHOUETTE = 0.3` → one repeated sound.
7. **Merging:** clusters merge when mean distance in **fixed-scale** space < `MERGE_DIST_FIXED
   = 1.3`. `FEATURE_SCALE = [1500, .15, .25, .3, .25, .25, 3000, .25, .0015, .05]` for dims
   [centroid, zcr, low, mid, high, flatness, rolloff, low80, lowPitch, duration] — measured on
   clean *and* phone-simulated voices: same-instrument variants ≤ ~0.8 apart, different
   instruments ≥ ~1.9. *Why fixed scale:* z-space merging amplified noise on takes where all
   hits were similar (identical kicks split, distinct drums merged).
   **Veto:** `MERGE_VETO_DIMS = [8, 9]` (lowPitch, duration), `MERGE_VETO_LIMIT = 1.2` — a hard
   difference on a *categorical* cue (kick-vs-tom pitch; rimshot-vs-snare ring) blocks a merge
   even when spectra agree. Spectral dims are exempt (variants legitimately vary there).
8. **Labeling:** rule-tree majority vote per cluster, resolved by relative brightness ordering:
   darkest bass-qualified cluster = kick; brightest = hat only if it *qualifies* as a hat
   (centroid/zcr/vote); tonal-low = tom/tomfloor; short-clicky = rimshot; else snare.
9. **Articulations:**
   - Open hat: `duration ≥ 0.15 s` OR (gap ≥ 0.18 s AND ringing through ≥ 45% of gap, gap
     capped 0.5 s) — the ratio rule exists because in a busy beat the next hit cuts the
     measurement short. Hat family ringing ≥ `CRASH_SEC = 0.45` → crash.
   - Buzz/press roll (snare/tom family): `duration ≥ 0.2 s` AND `sustain ≥ 0.45` (plateau, not
     decay) → replaced by 4–28 strokes spaced 31 ms, tapered, alternating accents, deterministic
     wobble, all flagged `roll: true`.
   - Performed ambience (non-hat, long *decaying* tail ≥ 0.22 s, sustain < 0.45):
     `ambience = min(1, (dur−0.22)/0.38)`, **halved for kick** (keep low end tight).
10. **Velocity:** `0.55·(peak/clipPeak) + 0.45·sqrt(rms/clipRms)` → `clamp(0.1+0.9·loud, .1, 1)`
    — relative to the take's own loudest hit so ghosts stay whispered, accents smack.

`js/classifier.js` also holds the live rule tree (used for during-capture hit counts and
mic-less keyboard takes) and the dormant "Tune to my voice" k-NN profile
(`buildProfile`/`classifyWithProfile`, localStorage key `b2d-voice-profile-v1`).

## 7. Groove — `js/groove.js` + `js/recorder.js`

- `detectGrid(events)` — tempo from hit times alone, via circular statistics: map times onto a
  circle of circumference = candidate step; real rhythms cluster in phase → long resultant
  vector. Sweep steps 0.08–0.8 s (×1.01 geometric); prefer the **largest** step among
  candidates ≥ 97% of max confidence (avoids the wrong octave); refine ±3%; octave-fold BPM up
  into [65, ~188).
  **Three gates, Monte-Carlo tuned** (~5% false grids on 12 random hits, ≥99.5% acceptance with
  ±20–30 ms human jitter): resultant `confidence ≥ 0.7`, inliers ≥ 75% within ±20% of a slot,
  and IOI consistency ≥ 70% of intervals within ±18% of a whole slot count (the strongest
  anti-false-grid gate; without it ~85% FP). Fail → take stays available raw (loop = last hit
  + 0.7 s).
- `buildGroove(events, grid)` → 5 style levels (`STYLE_LEVELS`), all non-destructive:
  - **`faithful` (DEFAULT):** the performance exactly as played — original micro-timing, only
    same-type double-triggers < 35 ms merged (keep louder); **roll strokes never deduped**.
    Raw/faithful anchor on the **first hit** (never scrambled by pickup wrapping); grid styles
    anchor bar 1 on the first kick.
  - `raw` = everything as played; `tight` = snapped to 16ths; `clean` = tight + same-slot dupes
    merged; `full` = clean + embellish() (backbeat snares slots 4/12, kick slot 0, 8th hats with
    deterministic velocity wobble, never stacking a closed hat on a performed open hat).
- `LoopRecorder` (states `idle|armed|recording|playing`): free mode (auto-detect on stop) and
  metronome mode (4-beat count-in; `armed` state; cancel preserves the previous loop).
  `replaceTake(events)` is how clip-analysis results enter. `regrid(bpm)` re-fits phase for
  auto grooves. `setAudio(ctx, engine, metronome)` exists solely for the AudioContext rebuild
  (§9). `renderLoopWav({events, loopDur, kit, sampleKit, seamless, sampleRate=44100})` renders
  offline; with `seamless: true` the decay tail past the loop end is **added back onto the loop
  start** so exports cycle perfectly in a DAW. `encodeWavPCM16` = plain 44-byte RIFF writer.
- Convention: `sixteenth = 15/bpm` seconds everywhere.
- Known stale comments: groove.js/recorder.js headers still say "four style levels" — there are
  five (`faithful` added later). Safe to fix.

## 8. Sound — `js/audio-engine.js` + `js/sample-kit.js`

- `KIT_NAMES = ['real', 'acoustic', 'tr808', 'trap', 'electro', 'lofi', 'perc']`. `'real'` =
  GMRockKit samples (8 drums × 5 true velocity layers, boundaries from the kit's own Hydrogen
  `drumkit.xml`; kick has its own `[0.203, 0.37, 0.732, 0.866]`). Synth kits define only
  kick/snare/hat; `SYNTH_FALLBACK = {openhat:'hat', crash:'hat', tom:'snare', tomfloor:'kick',
  rimshot:'snare'}` covers the palette while samples load ('real' is selectable pre-load).
- Sample playback: layer via `layerIndex(boundaries, velocity)`, gentle gain slope
  `0.7 + 0.3·v` (layers carry the timbre), ±1.5% playback-rate humanization cycling per drum
  (fast rolls never repeat a bit-identical file).
- **Hi-hat choke:** `_ringingOpenHat` tracks the last open hat; any hat/openhat > 10 ms later
  ramps it to silence with `setTargetAtTime` τ = 12 ms ("the pedal closes"). Works offline too
  because events arrive time-ordered. Smoke test asserts ~460× tail-energy difference.
- **Production chain** (constructor): voices → master(0.9) → dry(1) + parallel "NY" squash
  (−32 dB, 12:1, 3 ms/250 ms, mix 0.4) + room reverb return(0.3) from a **generated** stereo IR
  (0.5 s decorrelated decaying noise, darkening tail — zero asset bytes) → tanh drive 1.15 →
  limiter (−4 dB, 20:1) → destination. Per-drum reverb sends `REVERB_SEND` (kick .07 … snare
  .22, crash .2) + `ambience`·0.4; subtle per-drum constant `PAN` + ±0.04 jitter.
- Runs identically on `OfflineAudioContext` (AudioBuffers are context-independent) — this is
  what makes WAV export and the AI upload render possible.

## 9. UI layer — `js/main.js`, `index.html`, `css/style.css`

- **Hidden-features pattern (critical):** `main.js` queries *every* element ID unconditionally;
  missing ones are null and every use is guarded. Currently live: `waveform, statusText,
  recBtn, origBtn, aiBtn, aiSettings, aiPanel, aiPrompt, aiRelay, aiKey, aiGenerate, aiClose,
  aiRow, aiPlayBtn, aiSaveBtn, versionLine`. Commented out in HTML (with explanatory comments):
  `playBtn` (▶ Drums), beat map (`mapWrap`/`timeline`), kit chips + `exportBtn`, `tuneBtn`,
  mic button/meter, pads, sensitivity/speaker-guard, metronome/BPM, style chips (`faithful`
  active), loop/clear/recCount, tips, debug. CSS still styles all of it.
- **The phone speaker routing saga (do not undo):** using the mic flips phones into call-mode
  routing (quiet earpiece). Two-part fix:
  1. `ctxTainted`/`maybeRebuildAudio()` — after the mic is released and everything is idle, a
     **fresh AudioContext** is built (new DrumEngine, re-register kit, reattach waveform,
     `recorder.setAudio`, worklet must reload) and the old one closed.
  2. **▶ Original and ▶ AI play through `<audio>` media elements** (blob URLs), which phones
     route to the loud media speaker like any music app. Original gets voice-memo makeup gain
     (`min(6, 0.9/peak)`). The waveform during Original playback is driven from the buffer at
     `currentTime` because the media element bypasses the graph.
- **Mic lifecycle:** `getUserMedia` with echoCancellation/noiseSuppression/autoGainControl all
  **false** (browser voice processing eats transients). Mic is hot only during a take;
  released 150 ms after stop (cancellable timer), then rebuild. Record auto-starts the mic; if
  denied, recording continues via keyboard/pads with a clear status.
- **AI wiring:** `aiBtn` is one-tap — generates directly if `isConfigured` (relay set), else
  opens the panel; `⚙ aiSettings` always opens it. `runAiGenerate` tiles
  `playableEvents()` to ≥ 8 s of context (`passes = clamp(ceil(8/dur), 1, 8)`), renders via
  `renderLoopWav`, calls `generateAudio`, stores blob → `aiUrl`, filename
  `beatbox-ai-<bpm>bpm.wav`. New recording always invalidates the AI take (`invalidateAiTake`).
- **Status conventions:** `READY_HINT = '✨ Generate for the AI track, ▶ Original for your
  take'`; conversion summary includes the transparency line "heard N sounds → kick · hats · …"
  (instantly explains an all-one-drum take). Errors via `setStatus(msg, true)`.
- Keyboard: `a/s/d` = kick/snare/hat, `r` = record, Space = AI take > drums loop > original.
- Settings: localStorage `b2d-settings` `{kit, styleLevel, sensitivity, speakerGuard, bpm,
  metronomeOn, debug}` — kit/style only honored while their chips are visible in HTML.

## 10. The ✨ AI feature — `js/neural.js` + `worker/relay.js`

**Two engines live in `js/neural.js`. Know both; only one is wired to the UI.**

### Active: audio generator (`generateAudio`) — Stable Audio 2.5

- Endpoint: user's relay URL + `/v2beta/audio/stable-audio-2/audio-to-audio` (buildEndpoint
  normalizes: trim, strip trailing `/`, add `https://`). Relay required because
  `api.stability.ai` has no CORS.
- Multipart form (exact): `prompt`, `audio` (WAV blob named `beat.wav`), `model =
  'stable-audio-2.5'`, `strength` clamped 0.05–1 (default `DEFAULT_STRENGTH = 0.65`),
  `duration` clamped 6–47 s (rounded), `output_format = 'wav'` (lossless, deliberately).
  Header `x-api-key` only when the app holds a key (it may live in the worker instead —
  that's why `isConfigured` checks **relayUrl only**).
- Human error mapping: network → "Couldn't reach the relay…"; 401/403 → key rejected; 402 →
  out of credits (top up at platform.stability.ai); other → `Generation failed (HTTP n)`;
  empty blob → "returned empty audio".
- **`worker/relay.js`** (Cloudflare Worker, copy-paste deploy): OPTIONS → 204+CORS; only POST
  to the one allowlisted path; key = `env.STABILITY_API_KEY` secret (preferred) else forwarded
  `x-api-key`; upstream `Authorization: Bearer`; streams the response back with CORS.
- **Costs (verified July 2026):** Stability credits are 1¢ each, $10 minimum top-up;
  Stable Audio 2.5 = flat **20 credits ≈ $0.20 per successful generation** (failures free);
  signup **via Google** grants 25 free credits (≈ first track free). Cloudflare Workers free
  tier is ample. Full user-facing setup walkthrough lives in README §"Generate AI track".
- Config: localStorage `b2d-neural-v3` `{relayUrl, apiKey, prompt, model}`;
  `DEFAULT_PROMPT = 'punchy studio drum break, acoustic kit, tight low end, crisp hi-hats,
  produced, high fidelity, no melody'`.

### Dormant: Claude composer (`composeBeat`) — kept unit-tested, not in the UI

- History: v20 shipped this as the ✨ feature (owner asked for "an LLM API"); v21 replaced it
  with the audio generator when the owner clarified they wanted real generated *audio* — the
  composer was kept because it's genuinely good and may return (e.g. as a "Compose" second
  button, or chained: compose → render → Stable Audio).
- Mechanics: `buildScore()` serializes the take as text (beats when BPM known, else seconds;
  lines like `0.00 kick v0.9 roll`); POST **directly from the browser** to
  `https://api.anthropic.com/v1/messages` with headers `x-api-key`, `anthropic-version:
  2023-06-01`, **`anthropic-dangerous-direct-browser-access: true`** (this is what makes
  relay-free browser calls possible); body: `model` (default in code: `claude-opus-4-8` —
  re-check current model names if reactivating), `max_tokens: 16000`, `thinking:
  {type:'adaptive'}`, `output_config.format = json_schema` with `BEAT_SCHEMA` (strict: bpm,
  bars 1–8, events `{t beats, type ∈ DRUM_TYPES, velocity, roll}`), drummer system prompt.
- `validateBeat` clamps everything (bpm 40–220, bars 1–8, velocity 0.05–1, drops unknown
  types/out-of-range times, caps 512 events, sorts, converts beats→seconds). Handles
  `stop_reason: 'refusal'` and credit-balance errors with human messages.
- Privacy note if reactivating: this path uploads *only rhythm text*, no audio at all.

## 11. PWA / deploy / versioning

- `sw.js`: stale-while-revalidate; precaches app shell + all 40 samples; same-origin GETs only
  (cross-origin AI calls intentionally untouched — this is why Playwright can mock them).
- **Release checklist:** bump `VERSION` in `js/version.js` AND `CACHE` in `sw.js` → run
  `npm test` + `npm run smoke` → commit to `main` with a narrative message → push `main` +
  sync `claude/box-drum-converter-app-cdxrdo` → owner verifies the footer on their phone.
- If adding a JS file, add it to `sw.js` `ASSETS` or it won't work offline.

## 12. Testing

- **`npm test`** — 72 unit tests, zero dependencies, `node --test "test/unit/*.test.mjs"`:
  classifier 6 · clip-analysis 19 · groove 15 · neural 9 · onset 7 · profile 4 · recorder 9 ·
  sample-kit 3. All synthetic-signal based, seeded mulberry32 PRNG ("so CI never flakes"),
  SR = 48000. Notable: the phone-mic regression test (highpassed+breathy take must NOT collapse
  into all hats), "THE context test" (bright snares the rule tree misreads get fixed by cluster
  siblings), triplets at 83 ms captured hit-for-hit, `fetchImpl` injection tests every HTTP
  failure mode of both AI engines without network, sample-kit test validates the actual WAV
  bytes on disk.
- **`npm run smoke`** (after `npm install`; needs Chromium — autodetects `/opt/pw-browsers`,
  `CHROME_PATH` overrides) — one script, ~20 labeled steps, two browser contexts:
  - **A (fake mic):** Chrome's `--use-fake-device-for-media-stream` tone genuinely exercises
    onset→cluster→convert. Covers minimal-UI assertions, SW registration, live waveform,
    conversion + status text, Original playback, 40 sample fetches, offline render fidelity
    metrics, hi-hat choke ratio, the **entire ✨ flow against a route-mocked relay**
    (`page.route('**/v2beta/audio/stable-audio-2/audio-to-audio')` — must answer the OPTIONS
    **CORS preflight** because `x-api-key` is a custom header; asserts multipart contains
    `model=stable-audio-2.5`, `output_format=wav`, and the rendered RIFF bytes; body checks are
    conditional because CDP may withhold large post bodies), one-tap regeneration, ⚙ toggle,
    stale-take invalidation on re-record, and post-mic-release rebuilt-context playback.
  - **B (mic denied):** keyboard-driven take converts at ~120 BPM, arms ✨, Original stays
    disabled, empty take explains itself.
  - On failure it prints the failing `step` name + page state dump. Any console/page error
    fails the run even if steps pass.
- CI = unit tests only (ubuntu, Node 22, no npm install). Smoke is local-only.

## 13. Version history — how the product got here (don't re-litigate)

| Ver | What happened |
|---|---|
| v1–v8 | Real-time mic→drums with pads/metronome/styles; owner: "UI too noisy" → minimal UI; "don't play anything back while recording" → silent capture. |
| ~v10 | "Nothing happens" bug → Record auto-starts mic; count-in countdown; explicit empty-take message. |
| v11–v13 | Phone speaker saga (§9): context rebuild + media-element playback + voice-memo gain. |
| v14 | "Everything registers as a hi-hat" → whole-clip contextual analysis (`clip-analysis.js`), no training (owner explicitly rejected training). |
| v15 | "Timing and groove completely off… analyzer doesn't know how to play drums" → `faithful` style, made DEFAULT; first-hit anchoring. |
| v16 | "I make so many sounds, output only makes 3" → full 8-drum vocabulary, GMRockKit samples, velocity layers, choke, production chain, beat-map + "heard N sounds" transparency. |
| v17 | Fast playing: 48 ms min-sep, buzz rolls, performed ambience. |
| v18 | Visible kit chips + one-tap WAV export (later re-hidden in v21). |
| v19 | First ✨: Stability audio-to-audio + relay (owner: "make it an AI tool… one take only"). |
| v20 | Owner: "use an LLM API" → Claude composer (compose JSON → kit performs); relay deleted. |
| v21 (current) | Owner: "there are Spotify playlists of AI music… I want real AI audio, high fidelity, three buttons" → Stable Audio 2.5 + wav out as the ✨ action; relay restored; composer kept dormant; UI pared to Record/Original/Generate. |

## 14. Hard-won lessons (bugs already fought — don't reintroduce)

1. **Median-of-positives trap:** with a smoothed envelope, novelty is exactly 0 between hits;
   thresholding on median-of-positive-novelty gates out everything. Median over ALL frames.
2. **Crossings happen at zero:** any zero-crossing counter gated on instantaneous amplitude
   counts nothing. Gate on a short *envelope*.
3. **Attack windows lie on phones:** classify the body (2048), not the first 21 ms.
4. **Z-space merging amplifies noise** when all hits are similar; merge in fixed semantic scale,
   veto only on categorical dims (8, 9).
5. **Tempo detection needs the IOI gate** — confidence + inliers alone pass ~85% of random
   timing; with IOI ~5%.
6. **Phones punish Web Audio after mic use** — rebuild the context; use media elements for
   anything that must be loud.
7. **Playwright mocks of CORS-preflighted endpoints must handle OPTIONS**, and
   `postDataBuffer()` can be null for large bodies (assert conditionally).
8. **Browser voice processing (AGC/echo/noise) destroys percussive transients** — always
   request it off.
9. **Choke needs a 10 ms guard** or a simultaneous hit chokes itself.
10. **Seamless loops:** fold post-loop decay back onto the start, don't truncate.

## 15. Competitive landscape (researched July 2026 — ~230 searches, cross-verified)

Verdict then: **no product does this app's combination**; the dedicated iOS niche is vacant.
- VoxBeat drums and looper (the only dedicated iOS beatbox→drums app) — **delisted Dec 2025**.
- HumBeatz — dormant since Jan 2024, ~3.2★, training required, 2-bar loops.
- Vochlea Dubler 2 — desktop-only ~$220 benchmark; their iOS app (Dubnote, 2025) is
  capture-only, no conversion. "Dubler Go" does not exist.
- BandLab iOS — closest live mainstream: cloud Audio-to-MIDI "Drums mode", quantized, behind
  ~$99+/yr membership, no articulation nuance.
- Suno iOS — biggest adjacent gravity: beatbox → full AI *song* (loose reinterpretation,
  subscription, no faithful drums/stems, voice uploaded).
- gary4beatbox — free open-source iOS; sends raw beatbox to MusicGen/MelodyFlow (no faithful
  conversion step).
- Sonarworks SoundID VoiceAI — strongest quality competitor (beatbox→drum audio), desktop DAW
  plugin, $99/freemium.
- Web timbre-transfer wave (Kits.AI, Musicfy, Soundverse, voicetoinstrument.com, …) — cloud
  converts of raw voice, subscription/credits, no timing-fidelity claims.
- **TRIA (Adobe Research, ISMIR 2025)** — research model of exactly this pipeline (rhythm
  prompt → hi-fi drums). Watch for productization; it's the real future threat, alongside Suno.
- Dead: Humtap, Mawf, Ripple (both ByteDance), Vocal Beater, Voxkit, Voice Band, Sounds.Studio;
  Riffusion absorbed into Google (Feb 2026); Udio exports disabled post-settlement.

Differentiators to protect: faithful whole-take conversion (no training), free/on-device,
voice-never-uploaded, WAV samples for DAWs, BYO-key ~$0.20 generations.

## 16. Known stale comments / small cleanups (safe, low priority)

- groove.js + recorder.js headers say "four style levels" — there are five.
- sample-kit.js `loadRealKit` JSDoc `@returns` lists only kick/snare/hat — manifest has eight.
- main.js header comment still describes the live-classifier pipeline as primary — whole-clip
  analysis is the real conversion path.
- `.big-controls.three` CSS + `autoPlay()` in main.js are kept intentionally for when hidden
  UI returns.

## 17. Dormant features & likely next steps

Everything commented out in `index.html` works when uncommented (§9): ▶ Drums, kit chips +
WAV export, beat map, style chips, metronome/BPM, pads, sensitivity, speaker guard, voice
tuning, debug readout. Other credible directions the owner has circled: re-surfacing the kit
picker/export, chaining the composer with the audio generator (compose → render → restyle),
Suno-style "re-roll history" (multiple kept takes — note owner previously wanted ONE take per
tap, so ask first), a strength slider for the AI panel, and Android/desktop polish (everything
already runs there; it's just untested love).

## 18. If ✨ breaks, check in this order

1. Relay reachable? (`curl -X OPTIONS https://<relay>/v2beta/audio/stable-audio-2/audio-to-audio` → 204)
2. Key valid / credits left? (401/403 vs 402 statuses map to exact user-facing messages)
3. Stability changed the API? (endpoint path, `model` field values, credit price — last
   verified July 2026: 2.5 = 20 credits)
4. The smoke test's mocked flow still passing? (isolates app-side vs Stability-side breakage)
