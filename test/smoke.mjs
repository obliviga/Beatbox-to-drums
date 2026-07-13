/**
 * Browser smoke test — drives the whole app in headless Chromium with a
 * fake microphone (Chrome's fake device emits a pulsing tone, which
 * genuinely exercises the onset → classify → synth pipeline).
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

/* ---------- chromium discovery ---------- */

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

/* ---------- tiny static server ---------- */

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

/* ---------- the test ---------- */

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

try {
  const context = await browser.newContext({ permissions: ['microphone'], acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  step = 'service worker';
  const swOk = await page.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]));
  check(swOk, 'service worker did not become ready');
  console.log('✓ service worker registered');

  step = 'mic start';
  await page.click('#micBtn');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Listening'), null, { timeout: 5000 });
  await page.check('#debugChk');
  await page.waitForTimeout(1200);
  const debugLine = (await page.textContent('#debugLine')).trim();
  console.log(`✓ mic listening; fake-mic detection: ${debugLine}`);

  step = 'pads + kits';
  for (const kit of ['acoustic', 'tr808', 'trap', 'electro', 'lofi', 'perc']) {
    await page.click(`.chip[data-kit="${kit}"]`);
    for (const drum of ['kick', 'snare', 'hat']) {
      await page.dispatchEvent(`.pad[data-drum="${drum}"]`, 'pointerdown');
      await page.waitForTimeout(40);
    }
  }
  console.log('✓ all 6 kits × 3 pads trigger cleanly');

  step = 'keyboard shortcuts';
  await page.click('body', { position: { x: 5, y: 5 } });
  for (const key of ['a', 's', 'd']) await page.keyboard.press(key);
  console.log('✓ keyboard pads');

  step = 'speaker guard';
  await page.check('#guardChk');
  await page.dispatchEvent('.pad[data-drum="kick"]', 'pointerdown');
  await page.uncheck('#guardChk');
  console.log('✓ speaker guard toggles');

  // stop the mic so the fake device's pulsing tone can't inject stray hits
  // into the timing-sensitive recordings below
  step = 'mic stop';
  await page.click('#micBtn');
  console.log('✓ mic stopped');

  step = 'auto-beat: free recording, steady 250 ms taps';
  await page.click('#recBtn');
  await page.evaluate(() => new Promise((resolve) => {
    const seq = ['kick', 'hat', 'snare', 'hat', 'kick', 'hat', 'snare', 'hat'];
    let i = 0;
    const iv = setInterval(() => {
      document.querySelector(`.pad[data-drum="${seq[i]}"]`)
        .dispatchEvent(new PointerEvent('pointerdown'));
      if (++i >= seq.length) {
        clearInterval(iv);
        setTimeout(resolve, 150);
      }
    }, 250);
  }));
  await page.click('#recBtn');
  const bpmDetected = Number(await page.$eval('#bpmInput', (el) => el.value));
  check(Math.abs(bpmDetected - 120) <= 5, `expected ~120 BPM, got ${bpmDetected}`);
  const autoCount = (await page.textContent('#recCount')).trim();
  check(/-bar loop @ \d+ BPM/.test(autoCount), `no bar-locked loop: ${autoCount}`);
  console.log(`✓ auto-beat detected ${bpmDetected} BPM (${autoCount})`);

  step = 'beat style ladder';
  const hitCount = async () => Number((await page.textContent('#recCount')).match(/(\d+) hit/)[1]);
  await page.click('.style-chip[data-style="raw"]');
  const rawHits = await hitCount();
  await page.click('.style-chip[data-style="clean"]');
  const cleanHits = await hitCount();
  await page.click('.style-chip[data-style="full"]');
  const fullHits = await hitCount();
  check(cleanHits <= rawHits, `clean (${cleanHits}) should be ≤ raw (${rawHits})`);
  check(fullHits > cleanHits, `full (${fullHits}) should add hits over clean (${cleanHits})`);
  console.log(`✓ style ladder: raw ${rawHits} → clean ${cleanHits} → full ${fullHits} hits`);

  step = 'looped playback of the auto-beat';
  await page.check('#loopChk');
  await page.click('#playBtn');
  await page.waitForTimeout(2500); // 1 bar @120 = 2 s — must wrap at least once
  check((await page.textContent('#playBtn')).includes('Stop'), 'loop did not keep playing');
  await page.click('#playBtn');
  console.log('✓ auto-beat loops and stops on demand');

  step = 're-grid via BPM nudge';
  await page.fill('#bpmInput', '60');
  await page.dispatchEvent('#bpmInput', 'change');
  const regridCount = (await page.textContent('#recCount')).trim();
  check(/@ 60 BPM/.test(regridCount), `regrid failed: ${regridCount}`);
  console.log(`✓ re-gridded at 60 BPM (${regridCount})`);

  step = 'WAV export';
  const dlPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.click('#exportBtn');
  const download = await dlPromise;
  const wavPath = await download.path();
  const head = await readFile(wavPath);
  check(head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE', 'not a WAV file');
  check(/beatbox-loop-\d+bpm-/.test(download.suggestedFilename()), `filename: ${download.suggestedFilename()}`);
  console.log(`✓ WAV export: ${download.suggestedFilename()} (${head.length} bytes)`);

  step = 'metronome record with count-in';
  await page.fill('#bpmInput', '240'); // fast count-in for the test
  await page.dispatchEvent('#bpmInput', 'change');
  await page.check('#metChk');
  await page.click('#recBtn');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Count-in'), null, { timeout: 3000 });
  await page.waitForFunction(() => document.getElementById('recBtn').textContent.includes('Stop'), null, { timeout: 5000 });
  for (const drum of ['kick', 'snare']) {
    await page.dispatchEvent(`.pad[data-drum="${drum}"]`, 'pointerdown');
    await page.waitForTimeout(140);
  }
  await page.click('#recBtn');
  const metCount = (await page.textContent('#recCount')).trim();
  check(/-bar loop @ 240 BPM/.test(metCount), `metronome loop not locked: ${metCount}`);
  console.log(`✓ metronome record with count-in (${metCount})`);

  step = 'settings persistence';
  await page.click('.chip[data-kit="trap"]');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(300);
  const activeKit = await page.$eval('.chip[data-kit].active', (el) => el.dataset.kit);
  check(activeKit === 'trap', `kit not persisted: ${activeKit}`);
  const bpmVal = await page.$eval('#bpmInput', (el) => el.value);
  check(bpmVal === '240', `bpm not persisted: ${bpmVal}`);
  const activeStyle = await page.$eval('.style-chip.active', (el) => el.dataset.style);
  check(activeStyle === 'full', `style not persisted: ${activeStyle}`);
  console.log('✓ settings persist across reload (kit, BPM, beat style)');

  step = 'mic restart after reload';
  await page.click('#micBtn');
  await page.waitForFunction(() => document.getElementById('statusText').textContent.includes('Listening'), null, { timeout: 5000 });
  await page.click('#micBtn');
  console.log('✓ mic start/stop after reload');

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
