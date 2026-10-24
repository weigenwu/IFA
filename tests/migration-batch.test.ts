import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScratchFile, scratchClosure, makeMigrationCsv, type MigrationCsvRow } from '../lib/migration-batch.ts';

const row = (path: string, areaPx: number | null): MigrationCsvRow => ({ path, width: 1224, height: 1024, paramsJson: '{"threshold":6}', roiTopPct: 0, roiBottomPct: 100, areaPx, reviewed: false, manualEdited: false, warnings: [] });

test('scratch time pairing preserves parent directory and unrecognized names', () => {
  assert.deepEqual(parseScratchFile('1\\2\\左中上线_24H.tif'), { parent: '1/2', series: '左中上线', timeHours: 24 });
  assert.equal(parseScratchFile('transwell/10x_1.tif').timeHours, null);
  const baseline = row('1/1/位置_0H.tif', 100);
  const later = row('1/1/位置_24H.tif', 40);
  assert.equal(scratchClosure(later, [baseline, later]).closurePct, 60);
  assert.equal(scratchClosure(later, [row('1/2/位置_0H.tif', 100), later]).closurePct, null);
  assert.equal(scratchClosure(later, [baseline, row('1/1/位置_0H.png', 100), later]).closurePct, null);
});

test('closure needs valid matched baseline and preserves negative values', () => {
  const baseline = row('1/位置_0H.tif', 100);
  const later = row('1/位置_24H.tif', 150);
  assert.equal(scratchClosure(later, [baseline]).closurePct, -50);
  assert.equal(scratchClosure(later, [{ ...baseline, areaPx: 0 }]).closurePct, null);
  assert.equal(scratchClosure(later, [{ ...baseline, areaPx: null }]).closurePct, null);
  assert.equal(scratchClosure(later, [{ ...baseline, width: 500 }]).closurePct, null);
  assert.equal(scratchClosure(later, [{ ...baseline, paramsJson: '{}' }]).closurePct, null);
  assert.equal(scratchClosure({ ...later, algorithmVersion: 'v2' }, [{ ...baseline, algorithmVersion: 'v1' }]).closurePct, null);
  assert.equal(scratchClosure({ ...later, pairConfirmed: true }, [baseline]).status, '同一视野已确认');
});

test('CSV retains errors, missing measurements, corrections and safe filenames', () => {
  const output = makeMigrationCsv('transwell', [{ ...row('=danger, "file".tif', null), autoCount: 20, correctedCount: 23, stainedAreaPx: 200, coveragePct: 0.02, manualEdited: true }, { ...row('bad.tif', null), error: '无法读取', autoCount: 7 }]);
  assert.ok(output.startsWith('\uFEFF'));
  assert.ok(output.includes(`"'=danger, ""file"".tif"`));
  assert.ok(output.includes('"20","23","200","0.02"'));
  assert.ok(output.includes('失败：无法读取'));
  assert.ok(!output.includes('"7"'));
  const empty = makeMigrationCsv('scratch', [row('位置_24H.tif', null)]);
  assert.ok(!empty.includes('NaN'));
  assert.ok(empty.includes('当前面积无效'));
});
