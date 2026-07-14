/**
 * Browser smoke test — drives the app in headless Chromium.
 *
 * The UI is currently minimal: Record → waveform → Play. Context A uses
 * Chrome's fake microphone (a pulsing tone that genuinely exercises the
 * onset → classify → synth pipeline) and mocks the AI-restyle relay with
 * route interception (no real network). Context B force-denies getUserMedia
 * and drives hits with precisely-timed keyboard events, covering the
 * mic-less fallback and deterministic tempo detection.
 *
 * Usage:  npm install && npm run smoke
 * Env:    CHROME_PATH to point at a Chromium binary if autodetection fails.
 */

import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (existsSync(base)) {
    for (const entry of await readdir(base)) {
      if (entry.startsWith('chromium-')) {
        const p = path.join(base, entry, 'chrome-linux', 'chrome');
        if (existsSync(p)) return p;
      }
    }
  }
  try { return chromium.executablePath(); } catch { /* fall through */ }
  throw new Error('No Chromium found — set CHROME_PATH');
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.wav': 'audio/wav',
};

function serve(rootDir) {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = path.normalize(path.join(rootDir, p));
      if (!file.startsWith(rootDir)) throw new Error('traversal');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/** A tiny playable WAV (mono PCM16, decaying tone) — the mocked AI response. */
function makeWav(seconds = 1.2, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 440) / rate) * 12000 * (1 - i / n)), 44 + i * 2);
  }
  return buf;
}

const { server, port } = await serve(ROOT);
const base = `http://localhost:${port}`;
const errors = [];
let step = 'launch';
let activePage = null; // for failure diagnostics
const check = (cond, msg) => { if (!cond) throw new Error(`[${step}] ${msg}`); };

const browser = await chromium.launch({
  executablePath: await findChromium(),
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--no-sandbox',
  ],
});

const wirePage = (page) => {
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
};
const statusOf = async (page) => (await page.textContent('#statusText')).trim();
const waitStatus = (page, re, timeout = 6000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.getElementById('statusText').textContent), re.source, { timeout });
// count strongly-visible waveform bar pixels (bars are opaque; the center line is faint)
const wavePixels = (page) => page.evaluate(() => {
  const c = document.getElementById('waveform');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 80) n++;
  return n;
});

try {
  /* ================= Context A: working (fake) microphone ================= */
  const ctxA = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true });
  const pageA = await ctxA.newPage();
  activePage = pageA;
  wirePage(pageA);
  await pageA.goto(base, { waitUntil: 'load' });
  await pageA.waitForTimeout(300);

  step = 'A: minimal UI';
  for (const sel of ['#micBtn', '.pad', '#bpmInput', '#debugChk', '#tuneBtn']) {
    check((await pageA.$(sel)) === null, `${sel} should be hidden in the minimal UI`);
  }
  for (const sel of ['#recBtn', '#origBtn', '#playBtn', '#waveform', '#timeline', '#exportBtn', '#aiBtn']) {
    check((await pageA.$(sel)) !== null, `${sel} missing`);
  }
  check((await pageA.$$('.chip[data-kit]')).length === 7, 'expected 7 style chips');
  check(await pageA.$eval('#playBtn', (el) => el.disabled), 'Drums should start disabled');
  check(await pageA.$eval('#origBtn', (el) => el.disabled), 'Original should start disabled');
  check(await pageA.$eval('#exportBtn', (el) => el.disabled), 'Save should start disabled');
  check(await pageA.$eval('#aiBtn', (el) => el.disabled), 'AI restyle should start disabled');
  check(await pageA.$eval('#aiPanel', (el) => el.hidden), 'AI panel should start hidden');
  check(await pageA.$eval('#aiRow', (el) => el.hidden), 'AI take row should start hidden');
  check(await pageA.$eval('#mapWrap', (el) => el.hidden), 'beat map should start hidden');
  const versionText = (await pageA.textContent('#versionLine')).trim();
  check(/v\d+ · \d{4}-\d{2}-\d{2}/.test(versionText), `version line missing/malformed: "${versionText}"`);
  console.log(`✓ minimal UI: Record, waveform, Original, Drums (${versionText})`);

  step = 'A: service worker';
  const swOk = await pageA.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]));
  check(swOk, 'service worker did not become ready');
  console.log('✓ service worker registered');

  step = 'A: record from mic with live waveform';
  const idlePixels = await wavePixels(pageA);
  await pageA.click('#recBtn');
  await waitStatus(pageA, /Recording — beatbox now/);
  await pageA.waitForTimeout(4000); // fake tone pulses = mic-driven hits
  const recPixels = await wavePixels(pageA);
  check(recPixels > idlePixels + 200, `waveform not drawing (idle ${idlePixels} → rec ${recPixels})`);
  console.log(`✓ mic auto-started; waveform is live (${recPixels} px of signal)`);

  step = 'A: stop converts the take';
  await pageA.click('#recBtn');
  await waitStatus(pageA, /(Converted ✓|Captured \d+ hit).*▶ Drums/);
  check(!(await pageA.$eval('#playBtn', (el) => el.disabled)), 'Drums should be enabled after a take');
  check(!(await pageA.$eval('#mapWrap', (el) => el.hidden)), 'beat map should be visible after a take');
  console.log(`✓ stop converts and hands off ("${await statusOf(pageA)}")`);

  step = 'A: play back the original recording';
  await pageA.waitForFunction(() => !document.getElementById('origBtn').disabled, null, { timeout: 3000 });
  await pageA.click('#origBtn');
  await waitStatus(pageA, /Playing your original recording/);
  check((await pageA.textContent('#origBtn')).includes('Stop'), 'Original should toggle to Stop');
  await waitStatus(pageA, /▶ Drums/, 10000); // take is ~4 s; wait for it to finish
  console.log('✓ original take plays back and returns cleanly');

  step = 'A: play the converted drums';
  await pageA.click('#playBtn');
  await waitStatus(pageA, /Playing your drums/);
  check((await pageA.textContent('#playBtn')).includes('Stop'), 'Play should toggle to Stop');
  await pageA.waitForTimeout(1200);

  step = 'A: real drum samples loaded';
  const sampleCount = await pageA.evaluate(() =>
    performance.getEntriesByType('resource').filter((e) => e.name.includes('/samples/real/')).length);
  check(sampleCount >= 40, `only ${sampleCount} sample fetches observed`);
  console.log(`✓ real sampled kit loaded (${sampleCount} sample files fetched)`);

  step = 'A: production-chain render fidelity';
  const metrics = await pageA.evaluate(async () => {
    const { renderLoopWav } = await import('./js/recorder.js');
    const { loadRealKit } = await import('./js/sample-kit.js');
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const kit = await loadRealKit(ac, 'samples/real/');
    const types = ['kick', 'hat', 'snare', 'hat'];
    const events = Array.from({ length: 8 }, (_, i) => ({ t: i * 0.25, type: types[i % 4], velocity: 0.9 }));
    const wav = await renderLoopWav({ events, loopDur: 2, kit: 'real', sampleKit: kit, seamless: true });
    await ac.close();
    const dv = new DataView(wav);
    const frames = (wav.byteLength - 44) / 4;
    let peak = 0;
    let diff = 0;
    let energy = 0;
    for (let i = 0; i < frames; i++) {
      const l = dv.getInt16(44 + i * 4, true) / 32768;
      const r = dv.getInt16(46 + i * 4, true) / 32768;
      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > peak) peak = al;
      if (ar > peak) peak = ar;
      diff += Math.abs(l - r);
      energy += l * l + r * r;
    }
    return { frames, peak, meanDiff: diff / frames, rms: Math.sqrt(energy / (2 * frames)) };
  });
  check(metrics.frames === 2 * 44100, `wrong render length: ${metrics.frames}`);
  check(metrics.peak <= 1.0, `clipping: peak ${metrics.peak}`);
  check(metrics.peak > 0.15 && metrics.rms > 0.02, `render too quiet: peak ${metrics.peak}, rms ${metrics.rms}`);
  check(metrics.meanDiff > 0.0005, `no stereo image: meanDiff ${metrics.meanDiff}`);
  console.log(`✓ produced render: peak ${metrics.peak.toFixed(2)}, rms ${metrics.rms.toFixed(3)}, stereo ✓, no clipping`);

  step = 'A: hi-hat choke';
  const choke = await pageA.evaluate(async () => {
    const { renderLoopWav } = await import('./js/recorder.js');
    const { loadRealKit } = await import('./js/sample-kit.js');
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const kit = await loadRealKit(ac, 'samples/real/');
    await ac.close();
    const tailEnergy = (wav) => {
      const dv = new DataView(wav);
      const frames = (wav.byteLength - 44) / 4;
      const from = Math.floor(0.55 * 44100); // open hat still rings here…
      const to = Math.min(frames, Math.floor(0.95 * 44100));
      let e = 0;
      for (let i = from; i < to; i++) {
        const l = dv.getInt16(44 + i * 4, true) / 32768;
        const r = dv.getInt16(46 + i * 4, true) / 32768;
        e += l * l + r * r;
      }
      return e;
    };
    const open = await renderLoopWav({
      events: [{ t: 0, type: 'openhat', velocity: 0.9 }],
      loopDur: 1.2, kit: 'real', sampleKit: kit,
    });
    const choked = await renderLoopWav({
      events: [{ t: 0, type: 'openhat', velocity: 0.9 }, { t: 0.3, type: 'hat', velocity: 0.9 }],
      loopDur: 1.2, kit: 'real', sampleKit: kit,
    });
    return { open: tailEnergy(open), choked: tailEnergy(choked) };
  });
  check(choke.open > choke.choked * 3, `choke ineffective: open tail ${choke.open.toFixed(4)} vs choked ${choke.choked.toFixed(4)}`);
  console.log(`✓ hi-hat choke: ringing tail ${(choke.open / Math.max(choke.choked, 1e-9)).toFixed(1)}× louder unchoked`);

  step = 'A: style switch + save beat sample';
  await pageA.click('.chip[data-kit="tr808"]');
  check(!(await pageA.$eval('#exportBtn', (el) => el.disabled)), 'Save should be enabled after a take');
  const dlPromise = pageA.waitForEvent('download', { timeout: 20000 });
  await pageA.click('#exportBtn');
  const download = await dlPromise;
  const wavBytes = await readFile(await download.path());
  check(wavBytes.subarray(0, 4).toString() === 'RIFF' && wavBytes.subarray(8, 12).toString() === 'WAVE', 'not a WAV file');
  check(/beatbox-loop-.*tr808\.wav/.test(download.suggestedFilename()), `filename: ${download.suggestedFilename()}`);
  console.log(`✓ style switched to 808, sample saved: ${download.suggestedFilename()} (${wavBytes.length} bytes)`);
  await pageA.click('.chip[data-kit="real"]');

  step = 'A: AI restyle asks for a relay before generating';
  check(!(await pageA.$eval('#aiBtn', (el) => el.disabled)), 'AI restyle should be enabled after a take');
  await pageA.click('#aiBtn');
  check(!(await pageA.$eval('#aiPanel', (el) => el.hidden)), 'AI panel should open');
  const promptPrefill = await pageA.$eval('#aiPrompt', (el) => el.value);
  check(promptPrefill.length > 10, `prompt should be pre-filled, got "${promptPrefill}"`);
  await pageA.click('#aiGenerate'); // no relay configured yet
  await waitStatus(pageA, /Add your relay URL first/);
  console.log('✓ unconfigured AI restyle explains the relay setup');

  step = 'A: AI restyle generates one take (mocked relay)';
  const AI_ROUTE = '**/v2beta/audio/stable-audio-2/audio-to-audio';
  const mockTake = makeWav();
  let aiReq = null;
  await pageA.route(AI_ROUTE, async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') { // CORS preflight (x-api-key is a custom header)
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type, x-api-key, accept',
        },
      });
      return;
    }
    aiReq = { url: req.url(), headers: req.headers(), body: req.postDataBuffer() };
    await route.fulfill({
      status: 200,
      contentType: 'audio/wav',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: mockTake,
    });
  });
  await pageA.fill('#aiRelay', 'https://fake-relay.example');
  await pageA.fill('#aiKey', 'sk-test');
  await pageA.click('#aiGenerate');
  await waitStatus(pageA, /AI take ready/, 30000);
  check(aiReq, 'no request reached the mocked relay');
  check(aiReq.url === 'https://fake-relay.example/v2beta/audio/stable-audio-2/audio-to-audio',
    `wrong endpoint: ${aiReq.url}`);
  check(aiReq.headers['x-api-key'] === 'sk-test', 'API key header not forwarded');
  check((aiReq.headers['content-type'] || '').startsWith('multipart/form-data'),
    `expected multipart body, got ${aiReq.headers['content-type']}`);
  if (aiReq.body) { // CDP may withhold large post bodies; assert content when available
    const bodyStr = aiReq.body.toString('latin1');
    check(bodyStr.includes('name="prompt"'), 'multipart prompt field missing');
    check(bodyStr.includes('name="audio"') && bodyStr.includes('RIFF'), 'rendered WAV missing from request');
    check(bodyStr.includes('name="strength"'), 'strength field missing');
  }
  check(!(await pageA.$eval('#aiRow', (el) => el.hidden)), 'AI take row should appear');
  check(await pageA.$eval('#aiPanel', (el) => el.hidden), 'AI panel should close after generating');
  console.log(`✓ AI request well-formed (endpoint, key, multipart${aiReq.body ? ' + WAV payload' : ''}); take ready`);

  step = 'A: play + save the AI take';
  await pageA.click('#aiPlayBtn');
  await waitStatus(pageA, /Playing the AI take/);
  check((await pageA.textContent('#aiPlayBtn')).includes('Stop'), 'AI play should toggle to Stop');
  await waitStatus(pageA, /▶ Drums/, 10000); // short mock clip ends, status returns
  const aiDlPromise = pageA.waitForEvent('download', { timeout: 10000 });
  await pageA.click('#aiSaveBtn');
  const aiDl = await aiDlPromise;
  const aiBytes = await readFile(await aiDl.path());
  check(aiBytes.length === mockTake.length && aiBytes.subarray(0, 4).toString() === 'RIFF',
    `saved AI take should be the returned audio (${aiBytes.length} vs ${mockTake.length} bytes)`);
  check(/^beatbox-ai-.*\.wav$/.test(aiDl.suggestedFilename()), `AI filename: ${aiDl.suggestedFilename()}`);
  console.log(`✓ AI take plays via media element and saves (${aiDl.suggestedFilename()})`);
  await pageA.unroute(AI_ROUTE);

  step = 'A: record during playback starts a re-take';
  await pageA.click('#recBtn');
  await waitStatus(pageA, /Recording/);
  await pageA.waitForTimeout(1500);
  await pageA.click('#recBtn');
  await waitStatus(pageA, /(▶ Drums|No hits found)/);
  check(await pageA.$eval('#aiRow', (el) => el.hidden), 'a new recording should invalidate the old AI take');
  console.log('✓ playback, and Record-while-playing re-takes cleanly (stale AI take cleared)');

  step = 'A: playback works on the rebuilt (post-mic) audio context';
  await pageA.waitForTimeout(400); // mic released at +150 ms → context rebuilt
  await pageA.click('#playBtn');
  await waitStatus(pageA, /Playing your drums/);
  await pageA.waitForTimeout(600);
  await pageA.click('#playBtn');
  console.log('✓ post-rebuild playback (media-speaker routing) works');
  await ctxA.close();

  /* ============ Context B: microphone denied (keyboard-driven hits) ============ */
  const ctxB = await browser.newContext();
  await ctxB.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    }
  });
  const pageB = await ctxB.newPage();
  activePage = pageB;
  wirePage(pageB);
  await pageB.goto(base, { waitUntil: 'load' });
  await pageB.waitForTimeout(300);

  step = 'B: record explains a missing mic';
  await pageB.click('#recBtn');
  await waitStatus(pageB, /denied.*Recording without the mic/s);
  console.log('✓ denied mic is reported, recording continues without it');

  step = 'B: auto-beat from timed keyboard hits';
  await pageB.evaluate(() => new Promise((resolve) => {
    const seq = ['a', 'd', 's', 'd', 'a', 'd', 's', 'd']; // kick hat snare hat ×2
    let i = 0;
    const iv = setInterval(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: seq[i] }));
      if (++i >= seq.length) { clearInterval(iv); setTimeout(resolve, 150); }
    }, 250);
  }));
  await pageB.click('#recBtn');
  await waitStatus(pageB, /Converted ✓ \d+ BPM/);
  const bpm = Number((await statusOf(pageB)).match(/Converted ✓ (\d+) BPM/)[1]);
  check(Math.abs(bpm - 120) <= 5, `expected ~120 BPM, got ${bpm}`);
  console.log(`✓ converted at ${bpm} BPM ("${await statusOf(pageB)}")`);

  step = 'B: play converted beat';
  await pageB.click('#playBtn');
  await waitStatus(pageB, /Playing your drums/);
  await pageB.waitForTimeout(1000);
  await pageB.click('#playBtn');
  console.log('✓ converted beat plays and stops');

  step = 'B: no mic means no original take';
  check(await pageB.$eval('#origBtn', (el) => el.disabled), 'Original should stay disabled without mic audio');
  console.log('✓ mic-less takes degrade clearly (no Original playback)');

  step = 'B: empty take gives explicit feedback';
  await pageB.click('#recBtn');
  await waitStatus(pageB, /Recording/);
  await pageB.waitForTimeout(700);
  await pageB.click('#recBtn');
  await waitStatus(pageB, /No hits found/);
  console.log('✓ empty take explains itself');
  await ctxB.close();

  if (errors.length) {
    console.error('\nFAIL — page errors:');
    for (const e of errors) console.error(' ', e);
    process.exit(1);
  }
  console.log('\nSMOKE TEST PASSED — no console or page errors');
} catch (err) {
  console.error(`\nFAIL at step "${step}": ${err.message}`);
  if (activePage) {
    try {
      const state = await activePage.evaluate(() => ({
        status: document.getElementById('statusText')?.textContent,
        rec: document.getElementById('recBtn')?.textContent,
        play: document.getElementById('playBtn')?.textContent,
        orig: document.getElementById('origBtn')?.textContent,
      }));
      console.error('  page state at failure:', JSON.stringify(state));
    } catch { /* page already gone */ }
  }
  if (errors.length) for (const e of errors) console.error(' ', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
