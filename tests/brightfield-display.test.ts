import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BACKGROUND_SETTINGS, estimateBackground, normalizeBackground } from '../lib/brightfield-display.ts';
import type { RGBAFrame } from '../lib/migration.ts';

function field(rgb: number[], gain: number): RGBAFrame {
  const width = 120, height = 80, data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, isCell = x < 28 || x > 94;
    for (let c = 0; c < 3; c++) data[i + c] = (rgb[c] * (isCell ? (x + y) % 2 ? 0.65 : 0.4 : 1)) * gain;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

test('different exposures and color casts map empty background to the same target without changing source', () => {
  const settings = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, target: 235 };
  const dark = field([200, 210, 220], 0.6), light = field([200, 210, 220], 1);
  const original = dark.data.slice();
  const a = normalizeBackground(dark, settings), b = normalizeBackground(light, settings);
  assert.deepEqual(a.estimate.rgb, [120, 126, 132]);
  assert.deepEqual(b.estimate.rgb, [200, 210, 220]);
  const background = (40 * dark.width + 60) * 4;
  assert.deepEqual(Array.from(a.frame.data.slice(background, background + 3)), [235, 235, 235]);
  assert.deepEqual(Array.from(b.frame.data.slice(background, background + 3)), [235, 235, 235]);
  assert.deepEqual(dark.data, original);
  const cell = (40 * dark.width + 10) * 4;
  assert.ok(a.frame.data[cell] < a.frame.data[background]);
  assert.ok(Math.abs(a.frame.data[cell] - b.frame.data[cell]) <= 2);
  assert.equal(a.clippedFraction, 0);
});

test('disabled/black background preserves pixels; brightness-only mode uses one gain', () => {
  const source = field([180, 195, 210], 1);
  assert.equal(normalizeBackground(source, DEFAULT_BACKGROUND_SETTINGS).frame, source);
  const normalized = normalizeBackground(source, { enabled: true, target: 230, matchColor: false });
  assert.equal(normalized.gains[0], normalized.gains[1]);
  assert.equal(normalized.gains[1], normalized.gains[2]);
  const black = field([0, 0, 0], 1);
  assert.equal(estimateBackground(black).valid, false);
  assert.equal(normalizeBackground(black, { enabled: true, target: 235, matchColor: true }).frame, black);
});

test('clipping and invalid settings are reported instead of silently wrapping values', () => {
  const source = field([120, 120, 120], 1);
  source.data[0] = 255;
  const result = normalizeBackground(source, { enabled: true, target: 235, matchColor: true });
  assert.equal(result.frame.data[0], 255);
  assert.ok(result.clippedFraction > 0);
  assert.throws(() => normalizeBackground(source, { enabled: true, target: NaN, matchColor: true }));
  assert.throws(() => normalizeBackground({ ...source, width: -1 }, DEFAULT_BACKGROUND_SETTINGS));
});
