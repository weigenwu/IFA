import assert from 'node:assert/strict';
import test from 'node:test';

import { fromArrayBuffer } from 'geotiff';

import type { ChannelData } from '../lib/analysis.ts';
import type { LoadedImage } from '../lib/image.ts';
import { encodePseudocolorTiff, renderRoiPseudocolor, resolveDisplayRange, ROI_TIFF_DESCRIPTION } from '../lib/roi-export.ts';

const channel = (id: string, values: number[]): ChannelData => ({
  id,
  label: id,
  data: new Uint8Array(values),
  maxValue: 255,
  bitDepth: 8,
  integer: true,
});

const image = (width: number, height: number, channels: ChannelData[]): LoadedImage => ({
  fileName: 'synthetic.oir',
  sourceFiles: ['synthetic.oir'],
  format: 'test',
  width,
  height,
  channels,
  hash: 'test',
  pageCount: channels.length,
  pixelSizeUm: null,
  displayOnly: false,
  warnings: [],
});

test('ROI render returns the exact clamped source rectangle at original resolution', () => {
  const source = image(4, 3, [channel('a', Array.from({ length: 12 }, (_, index) => index))]);
  const rendered = renderRoiPseudocolor({
    image: source,
    channels: [{ id: 'a', color: 'red' }],
    roi: { x: 3.6, y: 2.6, width: -3.2, height: -1.4 },
  });
  assert.deepEqual(rendered.sourceRoi, { x: 0, y: 1, width: 4, height: 2 });
  assert.equal(rendered.width, 4);
  assert.equal(rendered.height, 2);
  assert.equal(rendered.rgb.length, 4 * 2 * 3);
});

test('single-channel view and black point affect pseudocolor pixels only', () => {
  const gradient = Array.from({ length: 16 }, (_, index) => index);
  const source = image(4, 4, [channel('a', gradient), channel('b', gradient)]);
  const ordinary = renderRoiPseudocolor({
    image: source,
    channels: [{ id: 'a', color: 'red' }, { id: 'b', color: 'green' }],
    view: 'a',
    blackPointPercent: 0,
  });
  const blackRaised = renderRoiPseudocolor({
    image: source,
    channels: [{ id: 'a', color: 'red' }, { id: 'b', color: 'green' }],
    view: 'a',
    blackPointPercent: 50,
  });
  const pixelEight = 8 * 3;
  assert.ok(ordinary.rgb[pixelEight] > blackRaised.rgb[pixelEight]);
  assert.equal(ordinary.rgb[pixelEight + 1], 0);
  assert.equal(ordinary.rgb[pixelEight + 2], 0);
});

test('display background floor suppresses weak pixels without mutating source data', () => {
  const values = [0, 2, 4, 6, 8, 10, 12, 14, 16];
  const source = image(3, 3, [channel('a', values)]);
  const before = Array.from(source.channels[0].data);
  const rendered = renderRoiPseudocolor({
    image: source,
    channels: [{ id: 'a', color: 'green', displayFloor: 10 }],
  });
  assert.deepEqual(Array.from(rendered.rgb.slice(4 * 3, 4 * 3 + 3)), [0, 0, 0]);
  assert.deepEqual(Array.from(rendered.rgb.slice(5 * 3, 5 * 3 + 3)), [0, 0, 0]);
  assert.ok(rendered.rgb[7 * 3 + 1] > 0);
  assert.deepEqual(Array.from(source.channels[0].data), before);
});

test('explicit per-channel display window is linear and shared by ROI export', () => {
  const signal = channel('a', [0, 10, 20, 30, 40]);
  assert.deepEqual(resolveDisplayRange(signal, 5, 1, { displayMin: 10, displayMax: 30 }), { low: 10, high: 30, range: 20 });
  const rendered = renderRoiPseudocolor({
    image: image(5, 1, [signal]),
    channels: [{ id: 'a', color: 'red', displayMin: 10, displayMax: 30 }],
  });
  assert.deepEqual(Array.from(rendered.rgb), [0, 0, 0, 0, 0, 0, 128, 0, 0, 255, 0, 0, 255, 0, 0]);
});

test('Olympus base pseudocolors use pure additive channel LUTs', () => {
  const source = image(4, 4, [channel('signal', Array.from({ length: 16 }, (_, index) => index))]);
  const expected = {
    blue: [0, 0, 1],
    green: [0, 1, 0],
    red: [1, 0, 0],
    cyan: [0, 1, 1],
    magenta: [1, 0, 1],
    yellow: [1, 1, 0],
    gray: [1, 1, 1],
  } as const;
  for (const [color, components] of Object.entries(expected)) {
    const rendered = renderRoiPseudocolor({
      image: source,
      channels: [{ id: 'signal', color: color as keyof typeof expected }],
      view: 'overlay',
    });
    const rgb = Array.from(rendered.rgb.slice(8 * 3, 8 * 3 + 3));
    const signal = Math.max(...rgb);
    assert.ok(signal > 0, `${color} should contain signal`);
    assert.deepEqual(rgb, components.map(component => component * signal), `${color} must not mix unintended RGB components`);
  }
});

test('optional scale bar is drawn at its requested pixel length with a label', () => {
  const source = image(100, 50, [channel('a', new Array(5000).fill(0))]);
  const rendered = renderRoiPseudocolor({
    image: source,
    channels: [{ id: 'a', color: 'gray' }],
    pixelSizeUm: 0.1,
    scaleBarUm: 2,
  });
  assert.deepEqual(rendered.scaleBar, { rendered: true, label: '2 µm', requestedUm: 2, pixelLength: 20 });
  let whitePixels = 0;
  for (let offset = 0; offset < rendered.rgb.length; offset += 3) {
    if (rendered.rgb[offset] === 255 && rendered.rgb[offset + 1] === 255 && rendered.rgb[offset + 2] === 255) whitePixels++;
  }
  assert.ok(whitePixels >= 40, 'white bar and label should be burned into RGB pixels');
});

test('Merge and every single-channel export share the exact ROI and scale bar', () => {
  const red = new Array(5000).fill(0); red[0] = 255;
  const green = new Array(5000).fill(0); green[1] = 255;
  const source = image(100, 50, [channel('red', red), channel('green', green)]);
  const common = {
    image: source,
    channels: [{ id: 'red', color: 'red' as const }, { id: 'green', color: 'green' as const }],
    roi: { x: 0, y: 0, width: 100, height: 50 },
    pixelSizeUm: 0.1,
    scaleBarUm: 2,
  };
  const merge = renderRoiPseudocolor({ ...common, view: 'overlay' });
  const redOnly = renderRoiPseudocolor({ ...common, view: 'channel:red' });
  const greenOnly = renderRoiPseudocolor({ ...common, view: 'channel:green' });

  for (const rendered of [merge, redOnly, greenOnly]) {
    assert.deepEqual(rendered.sourceRoi, { x: 0, y: 0, width: 100, height: 50 });
    assert.deepEqual(rendered.scaleBar, { rendered: true, label: '2 µm', requestedUm: 2, pixelLength: 20 });
  }
  assert.deepEqual(Array.from(merge.rgb.slice(0, 6)), [255, 0, 0, 0, 255, 0]);
  assert.deepEqual(Array.from(redOnly.rgb.slice(0, 6)), [255, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(greenOnly.rgb.slice(0, 6)), [0, 0, 0, 0, 255, 0]);
});

test('TIFF encoder writes readable interleaved 8-bit RGB and identifies pseudocolor data', async () => {
  const rendered = {
    rgb: new Uint8Array([
      255, 0, 0, 0, 255, 0, 0, 0, 255,
      10, 20, 30, 40, 50, 60, 70, 80, 90,
    ]),
    width: 3,
    height: 2,
    sourceRoi: { x: 0, y: 0, width: 3, height: 2 },
    blackPointPercent: 0,
    scaleBar: null,
  };
  const buffer = await encodePseudocolorTiff(rendered);
  const tiff = await fromArrayBuffer(buffer);
  const decoded = await tiff.getImage();
  assert.equal(decoded.getWidth(), 3);
  assert.equal(decoded.getHeight(), 2);
  assert.equal(decoded.getSamplesPerPixel(), 3);
  assert.deepEqual([decoded.getBitsPerSample(0), decoded.getBitsPerSample(1), decoded.getBitsPerSample(2)], [8, 8, 8]);
  assert.equal(String(await decoded.getFileDirectory().loadValue('ImageDescription')).replace(/\0+$/, ''), ROI_TIFF_DESCRIPTION);
  const pixels = await decoded.readRasters({ interleave: true }) as Uint8Array;
  assert.deepEqual(Array.from(pixels), Array.from(rendered.rgb));
});
