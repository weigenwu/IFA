import assert from 'node:assert/strict';
import test from 'node:test';
import { findWhiteRuler, restoreWhiteRuler } from '../lib/edu-display.ts';
import type { LoadedImage } from '../lib/image';

type Image = Pick<LoadedImage, 'width' | 'height' | 'channels' | 'sourceFiles'>;
function image(width = 320, height = 200): Image {
  return { width, height, sourceFiles: ['merge.tif'], channels: ['red', 'green', 'blue'].map(id => ({ id, label: id, sourceColor: id, data: new Uint8Array(width * height), maxValue: 255, bitDepth: 8, integer: true })) };
}
function pixel(input: Image, x: number, y: number, rgb: number[]) {
  input.channels.forEach((channel, i) => { channel.data[y * input.width + x] = rgb[i]; });
}
function annotation(input: Image, dx = 0) {
  const expected = new Map<number, number>();
  const gray = (x: number, y: number, value: number) => { pixel(input, x + dx, y, [value, value, value]); expected.set(y * input.width + x + dx, value); };
  for (let y = 194; y <= 198; y++) for (let x = 260; x <= 318; x++) gray(x, y, 255);
  gray(259, 195, 64); // Original antialias pixel touching the bar.
  for (let y = 177; y <= 183; y++) for (let x = 270; x <= 273; x++) gray(x, y, 255);
  gray(269, 179, 128);
  for (let y = 177; y <= 183; y++) for (let x = 291; x <= 293; x++) gray(x, y, 255);
  gray(294, 180, 32);
  return expected;
}

test('white ruler, text and original gray edges restore exactly in all three displays without changing source pixels', () => {
  const input = image(), expected = annotation(input), raw = input.channels.map(channel => channel.data.slice());
  const ruler = findWhiteRuler(input)!;
  assert.ok(ruler); assert.equal(ruler.sourceRgb, 'merge.tif');
  assert.deepEqual(Array.from(ruler.indices), [...expected.keys()].sort((a, b) => a - b));
  ruler.indices.forEach((at, i) => assert.equal(ruler.values[i], expected.get(at)));
  assert.deepEqual(ruler.bounds, { x: 259, y: 177, width: 60, height: 22 });
  for (const mode of ['DAPI', 'RED', 'Merge']) {
    const rgba = new Uint8ClampedArray(input.width * input.height * 4);
    for (let at = 0; at < input.width * input.height; at++) rgba.set(mode === 'DAPI' ? [0, 0, 90, 255] : mode === 'RED' ? [90, 0, 0, 255] : [90, 0, 90, 255], at * 4);
    const before = rgba.slice(); restoreWhiteRuler(rgba, ruler);
    for (let at = 0; at < input.width * input.height; at++) {
      if (expected.has(at)) assert.deepEqual(Array.from(rgba.slice(at * 4, at * 4 + 4)), [expected.get(at), expected.get(at), expected.get(at), 255]);
      else assert.deepEqual(rgba.slice(at * 4, at * 4 + 4), before.slice(at * 4, at * 4 + 4));
    }
  }
  input.channels.forEach((channel, i) => assert.deepEqual(channel.data, raw[i]));
});

test('red, blue and magenta cells, unseeded gray components and out-of-annotation white spots are never painted white', () => {
  const input = image(), expected = annotation(input);
  const excluded = [[280, 185, [255, 0, 0]], [285, 185, [0, 0, 255]], [300, 185, [255, 0, 255]], [305, 185, [80, 80, 80]], [220, 175, [255, 255, 255]], [20, 20, [255, 255, 255]]] as const;
  for (const [x, y, rgb] of excluded) pixel(input, x, y, [...rgb]);
  const ruler = findWhiteRuler(input)!;
  assert.ok(ruler); assert.equal(ruler.indices.length, expected.size);
  for (const [x, y] of excluded) assert.ok(!ruler.indices.includes(y * input.width + x));
});

test('a solid bright neutral cell next to the ruler is excluded rather than restored as text', () => {
  const input = image(256, 128), cell: number[] = [];
  for (let y = 120; y <= 123; y++) for (let x = 200; x <= 250; x++) pixel(input, x, y, [255, 255, 255]);
  for (let y = 96; y <= 114; y++) for (let x = 216; x <= 234; x++) if ((x - 225) ** 2 + (y - 105) ** 2 <= 81) {
    pixel(input, x, y, [255, 255, 255]); cell.push(y * input.width + x);
  }
  const ruler = findWhiteRuler(input)!;
  assert.ok(ruler); assert.equal(ruler.indices.length, 204);
  assert.deepEqual(ruler.bounds, { x: 200, y: 120, width: 51, height: 4 });
  assert.ok(cell.every(at => !ruler.indices.includes(at)));
  const rgba = new Uint8ClampedArray(input.width * input.height * 4);
  cell.forEach(at => rgba.set([200, 0, 180, 255], at * 4));
  restoreWhiteRuler(rgba, ruler);
  cell.forEach(at => assert.deepEqual(Array.from(rgba.slice(at * 4, at * 4 + 4)), [200, 0, 180, 255]));
});

test('grayscale, OIR-style channels, missing green and cross-file RGB combinations cannot establish a white annotation', () => {
  const input = image(); annotation(input);
  assert.equal(findWhiteRuler({ ...input, channels: [{ ...input.channels[0], id: 'signal' }] }), null);
  assert.equal(findWhiteRuler({ ...input, channels: input.channels.filter(channel => channel.id !== 'green') }), null);
  assert.equal(findWhiteRuler({ ...input, channels: input.channels.map((channel, i) => ({ ...channel, id: `ch0${i}` })) }), null);
  assert.equal(findWhiteRuler({ ...input, sourceFiles: ['r.tif', 'g.tif', 'b.tif'], channels: input.channels.map((channel, i) => ({ ...channel, id: `file-${i + 1}-${channel.id}` })) }), null);
  assert.equal(findWhiteRuler({ ...input, sourceFiles: ['r.tif', 'g.tif', 'b.tif'] }), null);
});

test('no long thin filled bar and ambiguous multiple bars both refuse restoration', () => {
  const textOnly = image();
  for (let y = 189; y <= 198; y++) for (let x = 307; x <= 316; x++) pixel(textOnly, x, y, [255, 255, 255]);
  assert.equal(findWhiteRuler(textOnly), null);
  const hollow = image();
  for (let x = 260; x <= 318; x++) { pixel(hollow, x, 194, [255, 255, 255]); pixel(hollow, x, 198, [255, 255, 255]); }
  for (let y = 194; y <= 198; y++) { pixel(hollow, 260, y, [255, 255, 255]); pixel(hollow, 318, y, [255, 255, 255]); }
  assert.equal(findWhiteRuler(hollow), null);
  const multiple = image(); annotation(multiple);
  for (let y = 189; y <= 191; y++) for (let x = 260; x <= 318; x++) pixel(multiple, x, y, [255, 255, 255]);
  assert.equal(findWhiteRuler(multiple), null);
});

test('complete RGB groups from separate files may agree but different annotation masks are rejected', () => {
  const a = image(), b = image(); annotation(a); annotation(b, -3);
  const combine = (second: Image): Image => ({ ...a, sourceFiles: ['a.tif', 'b.tif'], channels: [...a.channels.map(channel => ({ ...channel, id: `file-1-${channel.id}` })), ...second.channels.map(channel => ({ ...channel, id: `file-2-${channel.id}` }))] });
  assert.equal(findWhiteRuler(combine(b)), null);
  const agreed = findWhiteRuler(combine(a));
  assert.ok(agreed); assert.deepEqual(agreed.indices, findWhiteRuler(a)!.indices);
  assert.equal(findWhiteRuler({ ...a, channels: [...a.channels, a.channels[0]] }), null);
});

test('native full-scale normalization preserves annotation gray values and malformed overlays fail before writing', () => {
  const input = image(); annotation(input);
  const sixteenBit = { ...input, channels: input.channels.map(channel => ({ ...channel, data: Uint16Array.from(channel.data, value => value * 257), maxValue: 65535, bitDepth: 16 })) };
  assert.deepEqual(findWhiteRuler(sixteenBit), findWhiteRuler(input));
  assert.equal(findWhiteRuler({ ...input, width: 0 }), null);
  assert.equal(findWhiteRuler({ ...input, channels: input.channels.map(channel => ({ ...channel, maxValue: 0 })) }), null);
  const rgba = new Uint8ClampedArray(16).fill(23), before = rgba.slice(), ruler = findWhiteRuler(input)!;
  restoreWhiteRuler(rgba, null); assert.deepEqual(rgba, before);
  assert.throws(() => restoreWhiteRuler(rgba, ruler), /尺寸/); assert.deepEqual(rgba, before);
});
