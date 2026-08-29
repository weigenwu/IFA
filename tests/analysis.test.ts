import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateColocalization, intensityStats, lineProfile, type ChannelData } from '../lib/analysis.ts';
import { collapsePseudocolor } from '../lib/image.ts';
import { parseOir } from '../lib/oir.ts';

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

const joinBytes = (...parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
};

const syntheticOirBlock = (uid: string, values: number[]) => {
  const name = new TextEncoder().encode(uid);
  const output = new Uint8Array(28 + name.length + values.length * 2);
  const view = new DataView(output.buffer);
  view.setUint32(0, name.length + 12, true);
  view.setUint32(4, 3, true);
  view.setUint32(16, name.length, true);
  output.set(name, 20);
  view.setUint32(20 + name.length, values.length * 2, true);
  values.forEach((value, index) => view.setUint16(28 + name.length + index * 2, value, true));
  return output;
};

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

test('FV3000 OIR pixels, metadata, and Z projection are read locally', () => {
  const text = new TextEncoder();
  const frame = text.encode('<?xml version="1.0"?><lsmframe:frameProperties><commonframe:imageDefinition><base:width>2</base:width><base:height>2</base:height><base:bitCounts>12</base:bitCounts></commonframe:imageDefinition></lsmframe:frameProperties>');
  const metadata = text.encode('<?xml version="1.0"?><root:metadata><commonphase:channel id="abc" order="1"><lsmimage:dyeName>DAPI</lsmimage:dyeName><commonphase:length><commonparam:x>0.25</commonparam:x></commonphase:length><commonphase:pixelUnit><commonphase:x>MICRO_METER</commonphase:x></commonphase:pixelUnit></commonphase:channel></root:metadata>');
  const raw = joinBytes(
    text.encode('OLYMPUSRAWFORMAT'), frame, metadata,
    syntheticOirBlock('z001_0_1_abc_0', [1, 100, 10, 4095]),
    syntheticOirBlock('z002_0_1_abc_0', [2, 50, 20, 4000]),
    syntheticOirBlock('z003_0_1_abc_0', [999]),
  );
  const parsed = parseOir(raw.buffer as ArrayBuffer);
  assert.equal(parsed.bitDepth, 12);
  assert.equal(parsed.pixelSizeUm, 0.25);
  assert.equal(parsed.sizeZ, 2);
  assert.equal(parsed.projection, 'max');
  assert.equal(parsed.discardedTrailingZ, 1);
  assert.equal(parsed.channels[0].label, 'DAPI');
  assert.deepEqual(Array.from(parsed.channels[0].data), [2, 100, 20, 4095]);
});

test('FV3000 OIR reports when metadata declares missing Z planes', () => {
  const text = new TextEncoder();
  const frame = text.encode('<?xml version="1.0"?><lsmframe:frameProperties><base:width>2</base:width><base:height>2</base:height><base:bitCounts>12</base:bitCounts></lsmframe:frameProperties>');
  const metadata = text.encode('<?xml version="1.0"?><root:metadata><commonparam:axis enable="true" paramEnable="true"><commonparam:axis>ZSTACK</commonparam:axis><commonparam:maxSize>2</commonparam:maxSize></commonparam:axis></root:metadata>');
  const raw = joinBytes(
    text.encode('OLYMPUSRAWFORMAT'), frame, metadata,
    syntheticOirBlock('z001_0_1_abc_0', [1, 2, 3, 4]),
    syntheticOirBlock('z002_0_1_abc_0', [5, 6, 7, 8]),
  );
  const parsed = parseOir(raw.buffer as ArrayBuffer);
  assert.equal(parsed.sizeZ, 2);
  assert.equal(parsed.declaredSizeZ, 3);
});
