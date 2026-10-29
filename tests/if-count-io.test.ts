import assert from 'node:assert/strict';
import test from 'node:test';
import { groupIfFiles, inferIfChannels, resolveIfChannels, captureIfChannelReference, mapIfChannels, csv } from '../lib/if-count-io.ts';
import type { ChannelData } from '../lib/analysis.ts';

const channel = (id: string, label = id, sourceColor?: string): ChannelData => ({ id, label, sourceColor, data: new Uint8Array(1), maxValue: 255, bitDepth: 8, integer: true });
function file(name: string, path = '') {
  const result = new File([], name);
  Object.defineProperty(result, 'webkitRelativePath', { value: path });
  return result;
}

test('groups only explicit suffixes and preserves distinct directories', () => {
  const groups = groupIfFiles([
    file('slice_GFP.tif', 'a/slice_GFP.tif'), file('slice_DAPI.tif', 'a/slice_DAPI.tif'), file('slice_AF647.tif', 'a/slice_AF647.tif'),
    file('slice_DAPI.tif', 'b/slice_DAPI.tif'), file('slice.jpg'), file('slice2.jpg'),
    file('field_ch00.ome.tif'), file('field_ch01.ome.tif'),
  ]);
  assert.deepEqual(groups.map(group => [group.name, group.files.length]), [['a/slice', 3], ['b/slice', 1], ['slice.jpg', 1], ['slice2.jpg', 1], ['field', 2]]);
  assert.equal(groups[0].files[0].name, 'slice_AF647.tif');
  assert.throws(() => groupIfFiles([file('same.tif'), file('same.tif')]), /路径重复/);
});

test('gray channels are never assigned by order and ambiguous markers remain unresolved', () => {
  const gray = { displayOnly: false, channels: [channel('page-1', '灰度'), channel('page-2', '通道 2'), channel('page-3', '通道 3')] };
  assert.deepEqual(inferIfChannels(gray), { nucleus: '', a: '', b: '' });
  const image = { displayOnly: false, channels: [channel('x', 'slice_DAPI'), channel('y', 'slice_AF647'), channel('z', 'GFP')] };
  assert.deepEqual(inferIfChannels(image), { nucleus: 'x', a: 'y', b: 'z' });
  assert.equal(inferIfChannels({ ...image, channels: [...image.channels, channel('other', 'Alexa Fluor 647')] }).a, '');
  assert.deepEqual(inferIfChannels({ displayOnly: false, channels: [channel('both', 'DAPI GFP')] }), { nucleus: '', a: '', b: '' });
  assert.throws(() => resolveIfChannels(gray, { nucleus: 'page-1', a: 'page-1', b: 'page-2' }), /不同通道/);
});

test('RGB inference is explicitly display-only and source-color based', () => {
  const channels = [channel('x', 'B', 'blue'), channel('y', 'G', 'green'), channel('z', 'R', 'red')];
  assert.deepEqual(inferIfChannels({ displayOnly: true, channels }), { nucleus: 'x', a: 'z', b: 'y' });
  assert.deepEqual(inferIfChannels({ displayOnly: false, channels }), { nucleus: '', a: '', b: '' });
  assert.equal(inferIfChannels({ displayOnly: true, channels: [...channels, channel('duplicate', 'R', 'red')] }).a, '');
});

test('batch mapping follows selected marker identity, not generated file index', () => {
  const first = { displayOnly: false, channels: [channel('file-1-gray', 'A_DAPI'), channel('file-2-gray', 'A_AF647'), channel('file-3-gray', 'A_GFP')] };
  const reference = captureIfChannelReference(first, inferIfChannels(first));
  const next = { displayOnly: false, channels: [channel('file-1-gray', 'B_GFP'), channel('file-2-gray', 'B_DAPI'), channel('file-3-gray', 'B_AF647')] };
  assert.deepEqual(mapIfChannels(next, reference), { nucleus: 'file-2-gray', a: 'file-3-gray', b: 'file-1-gray' });
  assert.throws(() => mapIfChannels({ ...next, channels: [...next.channels, channel('other', 'B_AF647')] }, reference), /不唯一/);
  assert.throws(() => mapIfChannels({ displayOnly: false, channels: [channel('file-1-gray', 'B'), channel('file-2-gray', 'C'), channel('file-3-gray', 'D')] }, reference), /身份/);
});

test('explicit chNN identities survive stems/order while unknown labels require exact match', () => {
  const first = { displayOnly: false, channels: [channel('f1', 'A_ch00'), channel('f2', 'A_ch01'), channel('f3', 'A_ch02')] };
  const reference = captureIfChannelReference(first, { nucleus: 'f2', a: 'f3', b: 'f1' });
  assert.deepEqual(mapIfChannels({ displayOnly: false, channels: [channel('g1', 'B_ch02'), channel('g2', 'B_ch00'), channel('g3', 'B_ch01')] }, reference), { nucleus: 'g3', a: 'g1', b: 'g2' });
  const unknown = { displayOnly: false, channels: [channel('1', 'gray 1'), channel('2', 'gray 2'), channel('3', 'gray 3')] };
  const unknownReference = captureIfChannelReference(unknown, { nucleus: '1', a: '2', b: '3' });
  assert.deepEqual(mapIfChannels(unknown, unknownReference), { nucleus: '1', a: '2', b: '3' });
  assert.throws(() => mapIfChannels({ ...unknown, channels: [channel('1', 'different'), ...unknown.channels.slice(1)] }, unknownReference), /身份/);
});

test('CSV preserves numbers, null and quoted text while neutralizing formulas', () => {
  assert.equal(csv([['文件', '=SUM(A1)', ' \t@evil', '-bad', 'a,"b"\nc', -2.5, null, true]]), '\uFEFF"文件","\'=SUM(A1)","\' \t@evil","\'-bad","a,""b""\nc","-2.5","NA","true"');
});
