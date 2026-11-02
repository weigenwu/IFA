import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeColony, DEFAULT_COLONY_PARAMETERS } from '../lib/colony.ts';
import type { RGBAFrame } from '../lib/migration';

function frame(rgb = [175, 150, 195]): RGBAFrame {
  const data = new Uint8ClampedArray(100 * 100 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { width: 100, height: 100, data };
}
function disk(f: RGBAFrame, cx: number, cy: number, radius: number, rgb = [40, 15, 120]) {
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if ((x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= radius ** 2) f.data.set([...rgb, 255], (y * f.width + x) * 4);
}
const roi = { cx: 50, cy: 50, r: 45 };
const params = { ...DEFAULT_COLONY_PARAMETERS, minArea: 10, maxArea: 200 };

test('purple background remains blank; colonies are separate from gray shadows, red marks, and small debris', () => {
  assert.equal(analyzeColony(frame(), roi, params).points.length, 0);
  const f = frame();
  disk(f, 30, 30, 4); disk(f, 65, 60, 5); disk(f, 60, 30, 5, [50, 50, 50]); disk(f, 30, 65, 5, [150, 15, 25]); disk(f, 45, 45, 1);
  const before = f.data.slice(), result = analyzeColony(f, roi, params);
  assert.deepEqual(result.points.map(p => [p.x, p.y]), [[30, 30], [65, 60]]);
  assert.deepEqual(f.data, before);
  assert.equal(result.stainedAreaPx, result.points.reduce((sum, p) => sum + p.area, 0) + 4);
  assert.equal(result.coveragePct, 100 * result.stainedAreaPx / result.roiAreaPx);
});

test('circle clips outside objects; edge exclusion and large clusters are explicit and not split', () => {
  const f = frame(); disk(f, 8, 50, 5); disk(f, 50, 50, 10); disk(f, 2, 2, 2);
  const result = analyzeColony(f, roi, params);
  assert.equal(result.points.length, 0);
  assert.ok(result.warnings.some(w => w.includes('超过最大面积')));
  assert.ok(result.warnings.some(w => w.includes('触及分析圆')));
  assert.equal(analyzeColony(f, roi, { ...params, excludeEdge: false }).points.length, 1);
  assert.equal(analyzeColony(f, roi, { ...params, maxArea: 400 }).points.length, 1);
});

test('count uses a background-relative score and actual pixel area across background colors', () => {
  for (const background of [[240, 240, 240], [180, 160, 200], [120, 100, 140]]) {
    const f = frame(background); disk(f, 50, 50, 4);
    const result = analyzeColony(f, roi, params);
    assert.equal(result.points.length, 1);
    let area = 0; for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if ((x + .5 - 50) ** 2 + (y + .5 - 50) ** 2 <= 45 ** 2) area++;
    assert.equal(result.roiAreaPx, area);
  }
});

test('invalid input cannot silently become a zero count', () => {
  const f = frame();
  assert.throws(() => analyzeColony(f, { ...roi, r: 51 }, params), /分析圆/);
  assert.throws(() => analyzeColony(f, roi, { ...params, stainThreshold: NaN }), /阈值/);
  assert.throws(() => analyzeColony(f, roi, { ...params, maxArea: 2 }), /面积/);
  f.data[3] = 0; assert.throws(() => analyzeColony(f, roi, params), /透明/);
});
