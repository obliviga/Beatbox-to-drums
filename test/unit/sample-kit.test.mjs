import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAL_KIT_MANIFEST, layerIndex } from '../../js/sample-kit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('layerIndex maps velocity to the right layer', () => {
  const b = [0.2, 0.4, 0.6, 0.8];
  assert.equal(layerIndex(b, 0), 0);
  assert.equal(layerIndex(b, 0.2), 0);   // boundary belongs to the softer layer
  assert.equal(layerIndex(b, 0.21), 1);
  assert.equal(layerIndex(b, 0.5), 2);
  assert.equal(layerIndex(b, 0.8), 3);
  assert.equal(layerIndex(b, 0.81), 4);
  assert.equal(layerIndex(b, 1), 4);
});

test('manifest covers all three drums with five ordered layers each', () => {
  for (const drum of ['kick', 'snare', 'hat']) {
    const spec = REAL_KIT_MANIFEST[drum];
    assert.ok(spec, drum);
    assert.equal(spec.files.length, 5);
    assert.equal(spec.boundaries.length, 4);
    for (let i = 1; i < spec.boundaries.length; i++) {
      assert.ok(spec.boundaries[i] > spec.boundaries[i - 1], 'boundaries ascending');
    }
    // hardest layer must be reachable, softest must be used for whispers
    assert.equal(layerIndex(spec.boundaries, 1), 4);
    assert.equal(layerIndex(spec.boundaries, 0.05), 0);
  }
});

test('every sample file referenced by the manifest exists and is a valid WAV', async () => {
  for (const spec of Object.values(REAL_KIT_MANIFEST)) {
    for (const file of spec.files) {
      const buf = await readFile(path.join(ROOT, 'samples', 'real', file));
      assert.ok(buf.length > 10000, `${file} suspiciously small (${buf.length} bytes)`);
      assert.equal(buf.subarray(0, 4).toString(), 'RIFF', `${file} missing RIFF header`);
      assert.equal(buf.subarray(8, 12).toString(), 'WAVE', `${file} not a WAVE file`);
    }
  }
});
