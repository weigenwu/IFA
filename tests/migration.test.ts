import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeScratch, analyzeTranswell, measureScratch, DEFAULT_SCRATCH_PARAMETERS, DEFAULT_TRANSWELL_PARAMETERS, type RGBAFrame } from '../lib/migration.ts';

function frame(width = 160, height = 120, value = 245): RGBAFrame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = data[i + 1] = data[i + 2] = value; data[i + 3] = 255; }
  return { width, height, data };
}
function pixel(input: RGBAFrame, x: number, y: number, rgb: number[]) {
  input.data.set([...rgb, 255], (y * input.width + x) * 4);
}
function disk(input: RGBAFrame, x: number, y: number, radius: number, rgb: number[], innerRadius = 0) {
  for (let yy = Math.max(0, y - radius); yy <= Math.min(input.height - 1, y + radius); yy++) for (let xx = Math.max(0, x - radius); xx <= Math.min(input.width - 1, x + radius); xx++) {
    const distance = (xx - x) ** 2 + (yy - y) ** 2;
    if (distance <= radius ** 2 && distance >= innerRadius ** 2) pixel(input, xx, yy, rgb);
  }
}
function wound(): RGBAFrame {
  const input = frame(160, 120, 190);
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
    if (x < 40 || x >= 110) { const gray = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 110 : 230; pixel(input, x, y, [gray, gray, gray]); }
  }
  return input;
}

test('scratch detects a central low-texture gap, preserves raw pixels, and respects ROI geometry', () => {
  const input = wound(), raw = input.data.slice();
  const result = analyzeScratch(input, { ...DEFAULT_SCRATCH_PARAMETERS, windowRadius: 3, textureThreshold: 10, minGapWidth: 10, roiTopPct: 10, roiBottomPct: 90 });
  assert.equal(result.valid, true);
  assert.equal(result.boundaries[0].y, 12);
  assert.equal(result.boundaries.at(-1)!.y, 108);
  assert.equal(result.roiAreaPx, 160 * 96);
  assert.ok(Math.abs(result.meanWidthPx! - 70) <= 10, `measured ${result.meanWidthPx}`);
  assert.equal(result.areaPx, result.meanWidthPx! * 96);
  assert.deepEqual(input.data, raw);
});

test('empty or unidentifiable scratch is not falsely reported as complete closure', () => {
  const input = frame();
  const empty = analyzeScratch(input, DEFAULT_SCRATCH_PARAMETERS);
  assert.equal(empty.valid, false); assert.equal(empty.areaPx, null); assert.equal(empty.meanWidthPx, null); assert.deepEqual(empty.boundaries, []);
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) { const gray = (x + y) % 2 ? 40 : 230; pixel(input, x, y, [gray, gray, gray]); }
  assert.equal(analyzeScratch(input, DEFAULT_SCRATCH_PARAMETERS).valid, false);
});

test('manual scratch boundaries use trapezoidal pixel geometry and allow explicitly edited zero gap', () => {
  const result = measureScratch([{ y: 10, left: 20, right: 40 }, { y: 60, left: 20, right: 60 }, { y: 110, left: 20, right: 40 }], 160, 120);
  assert.equal(result.areaPx, 3000); assert.equal(result.meanWidthPx, 30); assert.equal(result.roiAreaPx, 16000); assert.equal(result.gapPct, 18.75);
  assert.equal(measureScratch([{ y: 0, left: 30, right: 30 }, { y: 120, left: 30, right: 30 }], 160, 120).areaPx, 0);
  assert.throws(() => measureScratch([{ y: 0, left: 40, right: 30 }, { y: 120, left: 30, right: 40 }], 160, 120), /左边界/);
  assert.throws(() => measureScratch([{ y: 10, left: 30, right: 40 }, { y: 10, left: 30, right: 40 }], 160, 120), /严格递增/);
});

test('transwell detects stained cells while rejecting gray pore rings, red artifacts, and tiny specks', () => {
  const input = frame(100, 80);
  disk(input, 20, 20, 8, [55, 40, 150]); disk(input, 50, 50, 8, [140, 40, 150]);
  disk(input, 75, 20, 7, [50, 50, 50], 4); disk(input, 80, 60, 7, [150, 40, 40]);
  pixel(input, 5, 60, [30, 20, 180]);
  const raw = input.data.slice();
  const result = analyzeTranswell(input, { ...DEFAULT_TRANSWELL_PARAMETERS, minArea: 20 });
  assert.equal(result.points.length, 2); assert.equal(result.clusterCount, 0);
  assert.ok(result.points.some(p => Math.hypot(p.x - 20, p.y - 20) <= 1));
  assert.ok(result.points.some(p => Math.hypot(p.x - 50, p.y - 50) <= 1));
  assert.equal(result.mask[20 * 100 + 75], 0); assert.equal(result.mask[60 * 100 + 80], 0);
  assert.equal(result.stainedAreaPx, result.mask.reduce((a, b) => a + b, 0));
  assert.equal(result.coveragePct, result.stainedAreaPx / 8000 * 100);
  assert.deepEqual(input.data, raw);
});

test('transwell dense connected region yields separated distance peaks with cluster QC', () => {
  const input = frame(100, 80);
  disk(input, 35, 40, 12, [50, 30, 140]); disk(input, 55, 40, 12, [50, 30, 140]);
  const result = analyzeTranswell(input, { ...DEFAULT_TRANSWELL_PARAMETERS, minArea: 20, clusterArea: 300, peakDistance: 14 });
  assert.equal(result.clusterCount, 1); assert.equal(result.points.length, 2);
  assert.ok(result.qc.some(message => message.includes('距离峰')));
  assert.ok(result.points.every(p => result.mask[p.y * input.width + p.x] === 1));
});

test('blank stain and edge exclusion remain well defined', () => {
  const input = frame(100, 80);
  const blank = analyzeTranswell(input, DEFAULT_TRANSWELL_PARAMETERS);
  assert.equal(blank.points.length, 0); assert.equal(blank.stainedAreaPx, 0); assert.equal(blank.coveragePct, 0);
  disk(input, 0, 30, 15, [40, 30, 180]);
  assert.equal(analyzeTranswell(input, { ...DEFAULT_TRANSWELL_PARAMETERS, excludeEdge: true }).points.length, 0);
});

test('malformed dimensions, transparency, nonfinite and invalid parameter ranges are rejected', () => {
  const input = frame();
  assert.throws(() => analyzeScratch({ ...input, width: 0 }, DEFAULT_SCRATCH_PARAMETERS), /宽高/);
  assert.throws(() => analyzeScratch({ ...input, data: input.data.slice(4) }, DEFAULT_SCRATCH_PARAMETERS), /RGBA/);
  assert.throws(() => analyzeScratch(input, { ...DEFAULT_SCRATCH_PARAMETERS, textureThreshold: NaN }), /纹理阈值/);
  assert.throws(() => analyzeScratch(input, { ...DEFAULT_SCRATCH_PARAMETERS, roiTopPct: 80, roiBottomPct: 10 }), /底部/);
  assert.throws(() => analyzeTranswell(input, { ...DEFAULT_TRANSWELL_PARAMETERS, stainThreshold: Infinity }), /颜色差/);
  assert.throws(() => analyzeTranswell(input, { ...DEFAULT_TRANSWELL_PARAMETERS, peakDistance: 0 }), /间距/);
  assert.throws(() => analyzeTranswell(input, { ...DEFAULT_TRANSWELL_PARAMETERS, clusterArea: 1 }), /大簇面积/);
  input.data[3] = 0;
  assert.throws(() => analyzeTranswell(input, DEFAULT_TRANSWELL_PARAMETERS), /透明/);
});
