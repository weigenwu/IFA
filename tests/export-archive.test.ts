import assert from 'node:assert/strict';
import test from 'node:test';

import { unzipSync } from 'fflate';

import { createStoredZip, safeFilePart } from '../lib/export-archive.ts';

test('export names remain readable while unsafe path characters are removed', () => {
  assert.equal(safeFilePart('Alexa Fluor 488 / 绿色'), 'Alexa Fluor 488 _ 绿色');
  assert.equal(safeFilePart('  ..  '), 'image');
  assert.equal(safeFilePart('CON'), '_CON');
});

test('stored ZIP contains each requested export without changing its bytes', async () => {
  const archive = await createStoredZip([
    { name: '00_Merge.png', data: new Uint8Array([1, 2, 3]) },
    { name: '01_DAPI.png', data: new Uint8Array([4, 5]) },
  ]);
  const files = unzipSync(new Uint8Array(archive));
  assert.deepEqual(Object.keys(files), ['00_Merge.png', '01_DAPI.png']);
  assert.deepEqual(Array.from(files['00_Merge.png']), [1, 2, 3]);
  assert.deepEqual(Array.from(files['01_DAPI.png']), [4, 5]);
});

test('duplicate ZIP names are rejected before download', async () => {
  await assert.rejects(() => createStoredZip([
    { name: 'same.png', data: new Uint8Array([1]) },
    { name: 'same.png', data: new Uint8Array([2]) },
  ]), /重复/);
});
