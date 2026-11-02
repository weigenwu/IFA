import assert from 'node:assert/strict';
import test from 'node:test';
import { colonyCsv, colonySummary, prismTsv, type ColonyExportRow } from '../lib/colony-export.ts';

const well = (patch: Partial<ColonyExportRow> = {}): ColonyExportRow => ({
  file: 'plate.jpg', group: 'A', replicate: '1', included: true, count: 4, autoCount: 4,
  reviewed: false, manual: false, coveragePct: 1, error: '', hash: 'source-hash', roi: '{"x":10}', parameters: '{"threshold":20}', createdAt: '2026-11-02T00:00:00Z', ...patch,
});

test('Prism retains zero, first group appearance and unequal group lengths without inferring paired rows', () => {
  const rows = [well({ group: 'B', count: 0, replicate: '3' }), well({ count: 9 }), well({ group: 'B', count: 7, replicate: '2' })];
  const before = structuredClone(rows);
  assert.equal(prismTsv(rows), 'B\tA\r\n0\t9\r\n7\t');
  assert.deepEqual(rows, before);
  assert.equal(prismTsv([well({ count: null }), ...rows]), 'A\tB\r\n9\t0\r\n\t7');
});

test('missing, invalid, excluded, failed and unnamed wells never become zero or enter summaries', () => {
  const skipped = [well({ count: null }), well({ count: NaN }), well({ count: -1 }), well({ count: .5 }), well({ count: Infinity }),
    well({ included: false }), well({ error: 'read failed', count: 17 }), well({ group: '  ' })];
  assert.equal(prismTsv(skipped), '');
  assert.deepEqual(colonySummary(skipped), []);
  const exported = colonyCsv(skipped);
  assert.equal(exported.split('\r\n').length, skipped.length + 1);
  for (const state of ['未计算', '无效计数', '已排除', '失败（保留旧计数）', '未分组']) assert.ok(exported.includes(`"${state}"`));
  assert.ok(exported.includes('"17","4"'));
  assert.ok(exported.includes('"NA","4"'));
  assert.equal(prismTsv([...skipped, well({ count: 0 })]), 'A\r\n0');
});

test('Prism and CSV neutralize formula headers while retaining tabs, quotes and newlines as one field', () => {
  const rows = [well({ group: '=SUM(A1)' }), well({ group: ' +cmd' }), well({ group: 'a\tb"c\nd', file: '=bad.jpg' })];
  assert.equal(prismTsv(rows), '\'=SUM(A1)\t\'+cmd\t"a\tb""c\nd"\r\n4\t4\t4');
  const exported = colonyCsv(rows);
  assert.ok(exported.startsWith('\uFEFF"文件"'));
  assert.ok(exported.includes('"\'=bad.jpg"'));
  assert.ok(exported.includes('"\'=SUM(A1)"'));
  assert.ok(exported.includes('"a\tb""c\nd"'));
});

test('summary uses per-well sample SD and one-well groups have missing SD', () => {
  const rows = [well({ count: 2 }), well({ count: 4 }), well({ count: 6 }), well({ group: ' B ', count: 0 }), well({ count: 100, error: 'failed rerun' })];
  assert.deepEqual(colonySummary(rows), [{ group: 'A', n: 3, mean: 4, sd: 2 }, { group: 'B', n: 1, mean: 0, sd: null }]);
  const exported = colonyCsv([well({ count: 5, autoCount: 4, manual: true, reviewed: true })]);
  assert.ok(exported.includes('"5","4","true","true","1","已复核","true"'));
});
