import test from 'node:test';
import assert from 'node:assert/strict';
import { assertScratchResize, resolveScratchBaseline, resizeScratchFrame } from '../lib/scratch-resolution.ts';

test('resolution reference is the unique 0H with the same folder and field name', () => {
  const baseline = { path: 'sh-NC/左下线_0H.tif', key: 'zero' };
  const other = { path: 'sh-NC/右下线_0H.tif', key: 'other' };
  assert.equal(resolveScratchBaseline('sh-NC\\左下线_48H.tif', [other, baseline]), baseline);
  assert.equal(resolveScratchBaseline(baseline.path, [baseline]), baseline);
  assert.throws(() => resolveScratchBaseline('sh-NC/左下线_48H.tif', [other]), /缺少/);
  assert.throws(() => resolveScratchBaseline('sh-NC/左下线_48H.tif', [{ path: 'sh-C/左下线_0H.tif' }]), /缺少/);
  assert.throws(() => resolveScratchBaseline('sh-NC/左下线_48H.tif', [baseline, { path: 'sh-NC/左下线_0H.png' }]), /不唯一/);
  assert.throws(() => resolveScratchBaseline('sh-NC/左下线.tif', [baseline]), /未识别时间/);
});

test('resolution changes preserve aspect ratio and reject crops or invalid sizes', () => {
  assert.doesNotThrow(() => assertScratchResize(2448, 2048, 1224, 1024));
  assert.doesNotThrow(() => assertScratchResize(1224, 1024, 2448, 2048));
  assert.throws(() => assertScratchResize(2448, 2047, 1224, 1024), /宽高比例不同/);
  for (const invalid of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => assertScratchResize(invalid, 1024, 1224, 1024), /尺寸无效/);
  const frame = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
  assert.equal(resizeScratchFrame(frame, { width: 2, height: 2 }), frame);
  assert.throws(() => resizeScratchFrame({ ...frame, data: new Uint8ClampedArray(4) }, frame), /像素与尺寸不一致/);
});
