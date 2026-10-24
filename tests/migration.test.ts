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

test('scratch ignores a large floating texture island without making a long inward notch', () => {
  const clean = wound(), debris = wound();
  // This island is much wider and taller than the old 2 * radius row filter.
  for (let y = 24; y < 96; y++) for (let x = 66; x < 87; x++) {
    const gray = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 110 : 230;
    pixel(debris, x, y, [gray, gray, gray]);
  }
  const parameters = { ...DEFAULT_SCRATCH_PARAMETERS, windowRadius: 3, textureThreshold: 10, minGapWidth: 10, rowStep: 4 };
  const raw = debris.data.slice(), expected = analyzeScratch(clean, parameters), actual = analyzeScratch(debris, parameters);
  assert.equal(actual.valid, true);
  assert.deepEqual(actual.boundaries, expected.boundaries);
  assert.equal(actual.areaPx, expected.areaPx);
  assert.deepEqual(debris.data, raw);
  assert.ok(actual.qc.some(message => message.includes('无足够侧边连接')));
});

test('scratch keeps a broad projection attached to the cell sheet and genuine uneven edges', () => {
  const input = wound();
  for (let y = 24; y < 96; y++) for (let x = 40; x < 66 + Math.floor(y / 16) % 2 * 4; x++) {
    const gray = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 110 : 230;
    pixel(input, x, y, [gray, gray, gray]);
  }
  const result = analyzeScratch(input, { ...DEFAULT_SCRATCH_PARAMETERS, windowRadius: 3, textureThreshold: 10, minGapWidth: 10, rowStep: 4 });
  assert.equal(result.valid, true);
  const middle = result.boundaries.filter(p => p.y >= 40 && p.y <= 80);
  assert.ok(middle.every(p => p.left >= 66), JSON.stringify(middle));
  assert.ok(new Set(middle.map(p => p.left)).size > 1, 'real edge variation must remain');
  assert.ok(result.boundaries[0].left < 50);
  assert.ok(result.boundaries.every(p => p.left >= 0 && p.right > p.left && p.right <= input.width));
});

test('weak cellular texture can attach a real front patch without reconnecting an independent gap island', () => {
  const input = frame(320, 180, 180);
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
    const patch = y >= 45 && y < 135 && x >= 120 && x < 170;
    if (x < 70 || x >= 250 || patch) {
      const gray = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 120 : 240; pixel(input, x, y, [gray, gray, gray]);
    }
  }
  const parameters = { ...DEFAULT_SCRATCH_PARAMETERS, windowRadius: 3, textureThreshold: 10, minGapWidth: 10, rowStep: 4 };
  const detached = analyzeScratch(input, parameters);
  assert.ok(detached.boundaries.filter(p => p.y >= 60 && p.y <= 120).every(p => p.left < 80));
  for (let y = 45; y < 135; y++) for (let x = 60; x < 120; x++) {
    const gray = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 173 : 187; pixel(input, x, y, [gray, gray, gray]);
  }
  const connected = analyzeScratch(input, parameters);
  assert.equal(connected.valid, true);
  assert.ok(connected.boundaries.filter(p => p.y >= 60 && p.y <= 120).every(p => p.left >= 170));
  for (let y = 60; y < 120; y++) for (let x = 202; x < 222; x++) {
    const gray = (Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 120 : 240; pixel(input, x, y, [gray, gray, gray]);
  }
  assert.deepEqual(analyzeScratch(input, parameters).boundaries, connected.boundaries);
});

test('scratch texture connectivity tolerates brightness shifts and usable low contrast, but rejects flat fields', () => {
  const parameters = { ...DEFAULT_SCRATCH_PARAMETERS, windowRadius: 3, textureThreshold: 10, minGapWidth: 10, rowStep: 4 };
  const source = wound(), expected = analyzeScratch(source, parameters);
  for (const transform of [(v: number) => v - 65, (v: number) => v + 20, (v: number) => Math.round((v - 170) * 0.45 + 170)]) {
    const input = { ...source, data: source.data.slice() };
    for (let i = 0; i < input.data.length; i++) if (i % 4 !== 3) input.data[i] = transform(input.data[i]);
    const raw = input.data.slice(), actual = analyzeScratch(input, parameters);
    assert.equal(actual.valid, true);
    assert.ok(Math.abs(actual.meanWidthPx! - expected.meanWidthPx!) <= 6);
    assert.ok(actual.boundaries.every(p => p.right > p.left && p.left >= 0 && p.right <= input.width));
    assert.deepEqual(input.data, raw);
  }
  const flat = analyzeScratch(frame(160, 120, 170), parameters);
  assert.equal(flat.valid, false); assert.equal(flat.areaPx, null);
});

test('central texture touching top and bottom is not a side-connected front; connected closure is not fabricated as zero', () => {
  const island = wound();
  for (let y = 0; y < island.height; y++) for (let x = 66; x < 87; x++) {
    const gray = (x + y) % 2 ? 110 : 230; pixel(island, x, y, [gray, gray, gray]);
  }
  const parameters = { ...DEFAULT_SCRATCH_PARAMETERS, windowRadius: 3, textureThreshold: 10, minGapWidth: 10, rowStep: 4 };
  assert.deepEqual(analyzeScratch(island, parameters).boundaries, analyzeScratch(wound(), parameters).boundaries);
  const bridge = wound();
  for (let y = 30; y < 90; y++) for (let x = 40; x < 110; x++) {
    const gray = (x + y) % 2 ? 110 : 230; pixel(bridge, x, y, [gray, gray, gray]);
  }
  const closed = analyzeScratch(bridge, parameters);
  assert.equal(closed.valid, false); assert.equal(closed.areaPx, null); assert.deepEqual(closed.boundaries, []);
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
