import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateColonyBackground, recolorColonyBackground } from '../lib/colony-display.ts';
import type { RGBAFrame } from '../lib/migration';

const roi = { cx: 5, cy: 5, r: 4 };
function frame(rgb = [170, 150, 190]): RGBAFrame {
  const data = new Uint8ClampedArray(10 * 10 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return { data, width: 10, height: 10 };
}
const at = (x: number, y: number) => (y * 10 + x) * 4;

test('uniform purple background maps to white and retains dark-to-background ratios without mutating source', () => {
  const source = frame(); source.data.set([40, 15, 120, 255], at(5, 5));
  const original = source.data.slice(), { data, background } = recolorColonyBackground(source, roi, '#ffffff');
  assert.deepEqual(background, [170, 150, 190]);
  assert.deepEqual([...data.slice(at(3, 3), at(3, 3) + 4)], [255, 255, 255, 255]);
  assert.deepEqual([...data.slice(at(5, 5), at(5, 5) + 4)], [60, 26, 161, 255]);
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(data[at(5, 5) + c] / 255 - original[at(5, 5) + c] / background[c]) <= .5 / 255);
  assert.deepEqual(source.data, original);
});

test('outside-circle and nonopaque bytes stay untouched and do not affect the background median', () => {
  const source = frame(); source.data.set([3, 4, 5, 0], at(4, 4)); source.data.set([250, 12, 40, 128], at(6, 5));
  const original = source.data.slice(), output = recolorColonyBackground(source, roi, '#e0e8f0');
  assert.deepEqual(output.background, [170, 150, 190]);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if ((x + .5 - 5) ** 2 + (y + .5 - 5) ** 2 > 16 || original[at(x, y) + 3] !== 255) {
    assert.deepEqual(output.data.slice(at(x, y), at(x, y) + 4), original.slice(at(x, y), at(x, y) + 4));
  }
  assert.deepEqual(source.data, original);
});

test('a shared native background override applies the same gains instead of estimating the preview again', () => {
  const source = frame(), background: [number, number, number] = [160, 140, 180];
  const result = recolorColonyBackground(source, roi, '#c0d2d8', background);
  assert.deepEqual([...result.data.slice(at(5, 5), at(5, 5) + 4)], [204, 225, 228, 255]);
  assert.deepEqual(result.background, background); assert.notEqual(result.background, background);
  assert.deepEqual([...recolorColonyBackground(source, roi, '#000000').data.slice(at(5, 5), at(5, 5) + 4)], [0, 0, 0, 255]);
  const zeroChannel = frame([0, 150, 190]);
  assert.deepEqual([...recolorColonyBackground(zeroChannel, roi, '#80ffff').data.slice(at(5, 5), at(5, 5) + 4)], [128, 255, 255, 255]);
});

test('bad color or geometry and absent opaque background fail explicitly', () => {
  const source = frame();
  assert.throws(() => recolorColonyBackground(source, roi, 'white'), /颜色/);
  assert.throws(() => recolorColonyBackground(source, roi, '#ffffff', [0, NaN, 0]), /RGB/);
  assert.throws(() => estimateColonyBackground(source, { ...roi, r: 6 }), /展示圆/);
  for (let i = 3; i < source.data.length; i += 4) source.data[i] = 0;
  assert.throws(() => estimateColonyBackground(source, roi), /不透明/);
});
