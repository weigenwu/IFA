import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBatchChannels, nativeEduParameters, batchRecordAction, type ChannelReference } from '../lib/edu-batch.ts';
import type { ChannelData } from '../lib/analysis.ts';
import type { EduParameters } from '../lib/edu.ts';
const channel = (id: string, label = id, color?: string): ChannelData => ({ id, label, sourceColor: color, data: new Uint8Array(1), maxValue: 255, bitDepth: 8, integer: true });
const reference: ChannelReference = { channels: [{ id: 'page-1', label: 'DAPI' }, { id: 'page-2', label: 'EdU' }], nucleus: 0, edu: 1, confirmed: true };
test('batch RGB channel identities follow each file rather than channel order', () => {
  assert.deepEqual(resolveBatchChannels({ channels: [channel('red'), channel('blue'), channel('green')] }, reference), [1, 0]);
  assert.deepEqual(resolveBatchChannels({ channels: [channel('ch00', 'DAPI', 'blue'), channel('ch01', 'EdU', 'red')] }, reference), [0, 1]);
  assert.deepEqual(resolveBatchChannels({ channels: [channel('ch00', 'EdU', 'red'), channel('ch01', 'DAPI', 'blue')] }, reference), [1, 0]);
});
test('duplicate RGB components are rejected, even if current mapping was confirmed', () => {
  assert.throws(() => resolveBatchChannels({ channels: [channel('r1', 'R', 'red'), channel('r2', 'R', 'red'), channel('b', 'B', 'blue')] }, reference), /不唯一/);
});
test('grayscale batch requires explicit confirmation plus exact channel identity and labels', () => {
  const channels = [channel('page-1', 'DAPI'), channel('page-2', 'EdU')];
  assert.deepEqual(resolveBatchChannels({ channels }, reference), [0, 1]);
  assert.throws(() => resolveBatchChannels({ channels }, { ...reference, confirmed: false }), /尚未确认/);
  assert.throws(() => resolveBatchChannels({ channels: [channel('page-1', 'EdU'), channel('page-2', 'DAPI')] }, reference), /不同/);
  assert.throws(() => resolveBatchChannels({ channels: [channel('other', 'DAPI'), channels[1]] }, reference), /不同/);
});
test('batch scales thresholds per native channel full scale', () => {
  const parameters: EduParameters = { nucleusThreshold: 25.5, eduThreshold: 51, minArea: 2, maxArea: 100, median: false, excludeEdge: false, minPositiveFraction: 0.2 };
  const native = nativeEduParameters({ channels: [{ ...channel('blue'), maxValue: 65535 }, channel('red')] }, [0, 1], parameters);
  assert.equal(native.nucleusThreshold, 6553.5); assert.equal(native.eduThreshold, 51);
});
test('batch reuses matching signatures and protects confirmed or manually edited different results', () => {
  assert.equal(batchRecordAction(undefined, 'new'), 'compute');
  assert.equal(batchRecordAction({ signature: 'same', reviewed: true, revisions: {} }, 'same'), 'reuse');
  assert.equal(batchRecordAction({ signature: 'old', reviewed: false, revisions: {} }, 'new'), 'compute');
  assert.equal(batchRecordAction({ signature: 'old', reviewed: true, revisions: {} }, 'new'), 'protect');
  assert.equal(batchRecordAction({ signature: 'old', reviewed: false, revisions: { 1: 'positive' } }, 'new'), 'protect');
});

test('cleanup batch maps frozen settings per native channel without changing its snapshot', async () => {
  const { cleanupWorkerRequest } = await import('../lib/edu-batch.ts');
  const frozen = Object.freeze({ redFloor: 51, blueFloor: 25.5, redMinArea: 12, blueMinArea: 1, protectNuclear: true, onlyNuclear: false, nucleusThreshold: 51, nucleusMinArea: 45 });
  const image = { channels: [{ ...channel('blue'), maxValue: 65535 }, channel('red')], width: 1, height: 1 };
  const request = cleanupWorkerRequest(image, [0, 1], frozen);
  assert.equal(request.blueFloor, 6553.5); assert.equal(request.redOptions.floor, 51); assert.equal(request.redOptions.nucleusThreshold, 13107);
  assert.equal(request.nucleus, image.channels[0].data); assert.equal(request.edu, image.channels[1].data);
  assert.equal(frozen.redFloor, 51);
});
test('cleanup manifest distinguishes successful, failed and unprocessed fields without old queue entries', async () => {
  const { cleanupBatchSummary } = await import('../lib/edu-batch.ts');
  const partial = cleanupBatchSummary(['a', 'b', 'c'], ['a'], [{ field: 'b', reason: 'bad TIFF' }], true);
  assert.deepEqual([partial.requested, partial.completed, partial.failed, partial.stopped, partial.partial], [3, 1, 1, true, true]);
  assert.deepEqual(partial.unprocessedFields, ['c']); assert.deepEqual(partial.completedFields, ['a']);
  const complete = cleanupBatchSummary(['a'], ['a'], [], false);
  assert.equal(complete.partial, false); assert.deepEqual(complete.unprocessedFields, []);
});
