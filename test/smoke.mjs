/**
 * Browser smoke test — drives the app in headless Chromium.
 *
 * The UI is currently minimal: Record → waveform → Play. Context A uses
 * Chrome's fake microphone (a pulsing tone that genuinely exercises the
 * onset → classify → synth pipeline). Context B force-denies getUserMedia
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
  const ctxA = await browser.newContext({ permissions: ['microphone'] });
  const pageA = await ctxA.newPage();
  wirePage(pageA);
  await pageA.goto(base, { waitUntil: 'load' });
  await pageA.waitForTimeout(300);

  step = 'A: minimal UI';
  for (const sel of ['#micBtn', '.pad', '.chip', '#bpmInput', '#exportBtn', '#timeline', '#debugChk', '#tuneBtn']) {
    check((await pageA.$(sel)) === null, `${sel} should be hidden in the minimal UI`);
  }
  for (const sel of ['#recBtn', '#origBtn', '#playBtn', '#waveform']) {
    check((await pageA.$(sel)) !== null, `${sel} missing`);
  }
  check(await pageA.$eval('#playBtn', (el) => el.disabled), 'Drums should start disabled');
  check(await pageA.$eval('#origBtn', (el) => el.disabled), 'Original should start disabled');
  console.log('✓ minimal UI: Record, waveform, Original, Drums');

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
  check(sampleCount >= 15, `only ${sampleCount} sample fetches observed`);
  console.log(`✓ real sampled kit loaded (${sampleCount} sample files fetched)`);

  step = 'A: record during playback starts a re-take';
  await pageA.click('#recBtn');
  await waitStatus(pageA, /Recording — beatbox now/);
  await pageA.waitForTimeout(1500);
  await pageA.click('#recBtn');
  await waitStatus(pageA, /▶ Drums/);
  console.log('✓ playback, and Record-while-playing re-takes cleanly');
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
  if (errors.length) for (const e of errors) console.error(' ', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
