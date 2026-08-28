import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateColocalization, intensityStats, lineProfile, type ChannelData } from '../lib/analysis.ts';
import { collapsePseudocolor } from '../lib/image.ts';

const channel = (id: string, values: number[], maxValue = Math.max(...values, 1)): ChannelData => ({
  id,
  label: id,
  data: new Float64Array(values),
  maxValue,
  bitDepth: 64,
  integer: false,
});

const coloc = (a: number[], b: number[], thresholdPercent = 0) => calculateColocalization(
  channel('a', a), channel('b', b), a.length, 1, null, 'manual', thresholdPercent, thresholdPercent,
);

test('perfect correlation and overlap', () => {
  const result = coloc([0, 1, 2, 3], [0, 2, 4, 6]);
  assert.ok(Math.abs(result.pearson - 1) < 1e-12);
  assert.ok(Math.abs(result.tm1 - 1) < 1e-12);
  assert.ok(Math.abs(result.tm2 - 1) < 1e-12);
});

test('anti-correlation and strict threshold boundary', () => {
  const result = coloc([0, 1, 2, 3], [3, 2, 1, 0], 100 / 3);
  assert.ok(Math.abs(result.pearson + 1) < 1e-12);
  assert.equal(result.tm1, 0);
  assert.equal(result.tm2, 0);
});

test('correlation and co-occurrence remain distinct', () => {
  const result = coloc([0, 0, 2, 2], [0, 2, 0, 2]);
  assert.ok(Math.abs(result.pearson) < 1e-12);
  assert.equal(result.tm1, 0.5);
  assert.equal(result.tm2, 0.5);
});

test('Manders direction is asymmetric', () => {
  const result = coloc([9, 1, 0, 0], [1, 0, 1, 1]);
  assert.ok(Math.abs(result.tm1 - 0.9) < 1e-12);
  assert.ok(Math.abs(result.tm2 - 1 / 3) < 1e-12);
});

test('constant channel returns NA Pearson', () => {
  assert.ok(Number.isNaN(coloc([5, 5, 5], [1, 2, 3]).pearson));
});

test('intensity background correction keeps signed CTCF', () => {
  const stats = intensityStats(channel('a', [10, 10, 10, 10], 255), 4, 1, null, 2);
  assert.equal(stats.sum, 40);
  assert.equal(stats.correctedMean, 8);
  assert.equal(stats.ctcf, 32);
});

test('horizontal line profile samples a known gradient', () => {
  const gradient = Array.from({ length: 25 }, (_, index) => index % 5);
  const profile = lineProfile(channel('a', gradient), channel('b', gradient), 5, 5, { x1: 0, y1: 2, x2: 4, y2: 2 }, 1, 0);
  assert.deepEqual(profile.rawA, [0, 1, 2, 3, 4]);
  assert.deepEqual(profile.rawB, [0, 1, 2, 3, 4]);
});

test('single-signal pseudocolor collapses instead of becoming fake channels', () => {
  const rgb: ChannelData[] = [
    { id: 'r', label: 'R', data: new Uint8Array([0, 100, 200]), maxValue: 255, bitDepth: 8, integer: true },
    { id: 'g', label: 'G', data: new Uint8Array([0, 80, 160]), maxValue: 255, bitDepth: 8, integer: true },
    { id: 'b', label: 'B', data: new Uint8Array([0, 0, 0]), maxValue: 255, bitDepth: 8, integer: true },
  ];
  const signal = collapsePseudocolor(rgb);
  assert.equal(signal?.id, 'signal');
  assert.deepEqual(Array.from(signal?.data ?? []), [0, 100, 200]);
});

test('independent RGB signals are not collapsed', () => {
  const rgb: ChannelData[] = [
    { id: 'r', label: 'R', data: new Uint8Array([0, 1, 0, 1]), maxValue: 255, bitDepth: 8, integer: true },
    { id: 'g', label: 'G', data: new Uint8Array([0, 0, 1, 1]), maxValue: 255, bitDepth: 8, integer: true },
    { id: 'b', label: 'B', data: new Uint8Array([1, 0, 0, 1]), maxValue: 255, bitDepth: 8, integer: true },
  ];
  assert.equal(collapsePseudocolor(rgb), null);
});

test('12-bit saturation uses 4095 rather than Uint16 container maximum', () => {
  const raw12: ChannelData = { id: 'raw12', label: '12-bit', data: new Uint16Array([0, 4094, 4095, 4095]), maxValue: 4095, bitDepth: 12, integer: true };
  assert.equal(intensityStats(raw12, 4, 1, null).saturationPct, 50);
});
