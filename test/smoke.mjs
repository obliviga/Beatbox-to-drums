/**
 * Browser smoke test — drives the whole app in headless Chromium.
 *
 * Context A has a fake microphone (Chrome's fake device emits a pulsing
 * tone, which genuinely exercises the onset → classify → synth pipeline).
 * Context B force-denies getUserMedia, so recording tests are driven by
 * precisely-timed pad taps (deterministic) and the mic-denied paths run.
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
  '.svg': 'image/svg+xml', '.wav': 'audio/wav',
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

const { server, port } = await serve(ROOT);
const base = `http://localhost:${port}`;
const errors = [];
let step = 'launch';
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
const countOf = async (page) => (await page.textContent('#recCount')).trim();
const waitStatus = (page, re, timeout = 5000) =>
  page.waitForFunction((src) => new RegExp(src).test(document.getElementById('statusText').textContent), re.source, { timeout });
const waitAutoPlay = (page) =>
  page.waitForFunction(() => document.getElementById('playBtn').textContent.includes('Stop'), null, { timeout: 4000 });

try {
  /* ================= Context A: working (fake) microphone ================= */
  const ctxA = await browser.newContext({ permissions: ['microphone'] });
  const pageA = await ctxA.newPage();
  wirePage(pageA);
  await pageA.goto(base, { waitUntil: 'load' });
  await pageA.waitForTimeout(300);

  step = 'A: service worker';
  const swOk = await pageA.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]));
  check(swOk, 'service worker did not become ready');
  console.log('✓ service worker registered');

  step = 'A: mic start + detection';
  await pageA.click('#micBtn');
  await waitStatus(pageA, /Listening/);
  await pageA.check('#debugChk');
  await pageA.waitForTimeout(1200);
  console.log(`✓ mic listening; fake-mic detection: ${(await pageA.textContent('#debugLine')).trim()}`);

  step = 'A: pads + kits';
  for (const kit of ['acoustic', 'tr808', 'trap', 'electro', 'lofi', 'perc']) {
    await pageA.click(`.chip[data-kit="${kit}"]`);
    for (const drum of ['kick', 'snare', 'hat']) {
      await pageA.dispatchEvent(`.pad[data-drum="${drum}"]`, 'pointerdown');
      await pageA.waitForTimeout(40);
    }
  }
  console.log('✓ all 6 kits × 3 pads trigger cleanly');

  step = 'A: keyboard + speaker guard';
  await pageA.click('body', { position: { x: 5, y: 5 } });
  for (const key of ['a', 's', 'd']) await pageA.keyboard.press(key);
  await pageA.check('#guardChk');
  await pageA.dispatchEvent('.pad[data-drum="kick"]', 'pointerdown');
  await pageA.uncheck('#guardChk');
  console.log('✓ keyboard pads + speaker guard');

  step = 'A: hands-free record from mic, auto-play on stop';
  await pageA.click('#recBtn'); // mic already on
  await waitStatus(pageA, /Recording/);
  await pageA.waitForTimeout(5000); // fake tone pulses = mic-driven hits
  const during = await countOf(pageA);
  check(/keep going/.test(during), `live counter missing: ${during}`);
  await pageA.click('#recBtn');
  await waitAutoPlay(pageA);
  check(/playing ▶/.test(await statusOf(pageA)), `no auto-play status: ${await statusOf(pageA)}`);
  console.log(`✓ mic-only take auto-plays on stop (${await countOf(pageA)})`);
  await pageA.click('#playBtn'); // stop playback
  await pageA.click('#clearBtn');
  await pageA.click('#micBtn'); // mic off
  await ctxA.close();

  /* ============ Context B: microphone denied (deterministic taps) ============ */
  const ctxB = await browser.newContext();
  await ctxB.addInitScript(() => {
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    }
  });
  const pageB = await ctxB.newPage();
  wirePage(pageB);
  await pageB.goto(base, { waitUntil: 'load' });
  await pageB.waitForTimeout(300);

  step = 'B: mic button reports denial';
  await pageB.click('#micBtn');
  await waitStatus(pageB, /denied/);
  console.log('✓ denied mic is reported clearly');

  step = 'B: record auto-tries the mic, falls back to pads-only';
  await pageB.click('#recBtn');
  await waitStatus(pageB, /pad taps only/);
  console.log('✓ record warns when the mic is unavailable');

  step = 'B: auto-beat from timed taps + auto-play';
  await pageB.evaluate(() => new Promise((resolve) => {
    const seq = ['kick', 'hat', 'snare', 'hat', 'kick', 'hat', 'snare', 'hat'];
    let i = 0;
    const iv = setInterval(() => {
      document.querySelector(`.pad[data-drum="${seq[i]}"]`)
        .dispatchEvent(new PointerEvent('pointerdown'));
      if (++i >= seq.length) { clearInterval(iv); setTimeout(resolve, 150); }
    }, 250);
  }));
  await pageB.click('#recBtn');
  await waitAutoPlay(pageB);
  const bpmDetected = Number(await pageB.$eval('#bpmInput', (el) => el.value));
  check(Math.abs(bpmDetected - 120) <= 5, `expected ~120 BPM, got ${bpmDetected}`);
  check(/-bar loop @ \d+ BPM/.test(await countOf(pageB)), `not bar-locked: ${await countOf(pageB)}`);
  console.log(`✓ auto-beat detected ${bpmDetected} BPM and auto-played (${await countOf(pageB)})`);
  await pageB.click('#playBtn'); // stop playback

  step = 'B: beat style ladder';
  const hitCount = async () => Number((await countOf(pageB)).match(/(\d+) hit/)[1]);
  await pageB.click('.style-chip[data-style="raw"]');
  const rawHits = await hitCount();
  await pageB.click('.style-chip[data-style="clean"]');
  const cleanHits = await hitCount();
  await pageB.click('.style-chip[data-style="full"]');
  const fullHits = await hitCount();
  check(cleanHits <= rawHits, `clean (${cleanHits}) should be ≤ raw (${rawHits})`);
  check(fullHits > cleanHits, `full (${fullHits}) should add hits over clean (${cleanHits})`);
  console.log(`✓ style ladder: raw ${rawHits} → clean ${cleanHits} → full ${fullHits} hits`);

  step = 'B: re-grid via BPM nudge';
  await pageB.fill('#bpmInput', '60');
  await pageB.dispatchEvent('#bpmInput', 'change');
  check(/@ 60 BPM/.test(await countOf(pageB)), `regrid failed: ${await countOf(pageB)}`);
  console.log(`✓ re-gridded at 60 BPM (${await countOf(pageB)})`);

  step = 'B: WAV export';
  const dlPromise = pageB.waitForEvent('download', { timeout: 15000 });
  await pageB.click('#exportBtn');
  const download = await dlPromise;
  const head = await readFile(await download.path());
  check(head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE', 'not a WAV file');
  check(/beatbox-loop-\d+bpm-/.test(download.suggestedFilename()), `filename: ${download.suggestedFilename()}`);
  console.log(`✓ WAV export: ${download.suggestedFilename()} (${head.length} bytes)`);

  step = 'B: empty take gives explicit feedback';
  await pageB.click('#clearBtn');
  await pageB.click('#recBtn');
  await waitStatus(pageB, /Recording/);
  await pageB.waitForTimeout(700);
  await pageB.click('#recBtn');
  await waitStatus(pageB, /No hits captured/);
  console.log('✓ empty take explains itself');

  step = 'B: metronome count-in shows a visible countdown';
  await pageB.fill('#bpmInput', '240'); // fast count-in for the test
  await pageB.dispatchEvent('#bpmInput', 'change');
  await pageB.check('#metChk');
  await pageB.click('#recBtn');
  await waitStatus(pageB, /Count-in — \d/, 2000);
  await pageB.waitForFunction(() => document.getElementById('recBtn').textContent.includes('Stop'), null, { timeout: 5000 });
  for (const drum of ['kick', 'snare']) {
    await pageB.dispatchEvent(`.pad[data-drum="${drum}"]`, 'pointerdown');
    await pageB.waitForTimeout(140);
  }
  await pageB.click('#recBtn');
  await waitAutoPlay(pageB);
  check(/@ 240 BPM/.test(await countOf(pageB)), `metronome loop not locked: ${await countOf(pageB)}`);
  console.log(`✓ count-in countdown + metronome loop auto-plays (${await countOf(pageB)})`);
  await pageB.click('#playBtn');

  step = 'B: cancelling the count-in keeps the previous loop';
  await pageB.click('#recBtn');
  await pageB.waitForTimeout(300); // inside the count-in
  await pageB.click('#recBtn');    // reads "■ Cancel"
  await waitStatus(pageB, /Count-in cancelled/);
  check(/@ 240 BPM/.test(await countOf(pageB)), `previous loop lost: ${await countOf(pageB)}`);
  console.log('✓ count-in cancel is explicit and non-destructive');

  step = 'B: settings persistence';
  await pageB.click('.chip[data-kit="trap"]');
  await pageB.reload({ waitUntil: 'load' });
  await pageB.waitForTimeout(300);
  check((await pageB.$eval('.chip[data-kit].active', (el) => el.dataset.kit)) === 'trap', 'kit not persisted');
  check((await pageB.$eval('#bpmInput', (el) => el.value)) === '240', 'bpm not persisted');
  check((await pageB.$eval('.style-chip.active', (el) => el.dataset.style)) === 'full', 'style not persisted');
  console.log('✓ settings persist across reload (kit, BPM, beat style)');
  await ctxB.close();

  if (errors.length) {
    console.error('\nFAIL — page errors:');
    for (const e of errors) console.error(' ', e);
    process.exit(1);
  }
  console.log('\nSMOKE TEST PASSED — no console or page errors');
} catch (err) {
  console.error(`\nFAIL at step "${step}": ${err.message}`);
  if (errors.length) for (const e of errors) console.error(' ', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
