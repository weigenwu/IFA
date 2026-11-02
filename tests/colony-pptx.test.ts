import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { colonyPptx } from '../lib/colony-pptx.ts';

// A transparent 1 x 1 PNG exercises embedded image bytes without a browser canvas.
const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNgAAIAAAUAAarVyFEAAAAASUVORK5CYII=';
const image = (name: string) => ({ name, dataUrl });
const xml = (files: Record<string, Uint8Array>, path: string) => new TextDecoder().decode(files[path]);

test('PPTX stores ordered groups as native text, one editable line and independent PNG picture objects', async () => {
  const output = await colonyPptx({ title: 'JIMT & 克隆', canvasColor: '#f4f1ec', lineWidth: 4, notes: 'Source SHA256: abc123; display only',
    groups: [{ name: 'C', images: [image('c1'), image('c2')] }, { name: 'A', images: [image('a1')] }, { name: 'B', images: [image('b1')] }] });
  const files = unzipSync(new Uint8Array(output)), slide = xml(files, 'ppt/slides/slide1.xml');
  assert.equal((slide.match(/<p:pic>/g) ?? []).length, 4);
  assert.equal((slide.match(/<a:prstGeom prst="line"/g) ?? []).length, 1);
  assert.deepEqual([...slide.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(match => match[1]), ['JIMT &amp; 克隆', 'C', 'A', 'B']);
  assert.match(slide, /<a:ln w="38100"/); // 4 px at 96 dpi = 3 pt.
  assert.match(slide, /<a:srgbClr val="F4F1EC"/);
  assert.match(slide, /descr="c1"/);
  const media = Object.keys(files).filter(path => /^ppt\/media\/.*\.png$/.test(path));
  assert.ok(media.length >= 1);
  assert.deepEqual(Buffer.from(files[media[0]]), Buffer.from(dataUrl.split(',')[1], 'base64'));
  assert.match(xml(files, 'ppt/notesSlides/notesSlide1.xml'), /Source SHA256: abc123; display only/);
});

test('zero line width omits the line and a large one-slide layout fits within 50 inches', async () => {
  const groups = Array.from({ length: 16 }, (_, i) => ({ name: `组${i + 1}`, images: [image(`well${i}`)] }));
  const files = unzipSync(new Uint8Array(await colonyPptx({ title: '可编辑', groups, canvasColor: '#000000', lineWidth: 0 })));
  const slide = xml(files, 'ppt/slides/slide1.xml'), presentation = xml(files, 'ppt/presentation.xml');
  assert.doesNotMatch(slide, /<a:prstGeom prst="line"/);
  assert.equal((slide.match(/<p:pic>/g) ?? []).length, 16);
  assert.match(slide, /<a:srgbClr val="FFFFFF"/);
  const dimensions = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(presentation)!;
  assert.equal(Number(dimensions[1]), 50 * 914400);
  assert.ok(Number(dimensions[2]) > 0 && Number(dimensions[2]) <= 50 * 914400);
  assert.equal(Object.keys(files).filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path)).length, 1);
});
