import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCck8, serializeCck8Csv, type Cck8Row } from '../lib/cck8.ts';

function row(id: string, fields: Partial<Cck8Row> = {}): Cck8Row {
  return { id, source: '原始.csv', sourceRow: 2, plate: 'P1', time: '24h', group: '药物', sample: '', well: id,
    role: 'sample', od: '0.6', reference: '', excluded: false, ...fields };
}
const measured = { blankMode: 'measured' as const };
const corrected = { blankMode: 'already-corrected' as const };
const close = (actual: number | null, expected: number) => {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-10, `${actual} != ${expected}`);
};

test('reference subtraction, scoped blank correction, and control normalization preserve raw input', () => {
  const input = [
    row('B1', { role: 'blank', group: '', od: '.20', reference: '.10' }),
    row('B2', { role: 'blank', group: '', od: '.40', reference: '.10' }),
    row('C1', { role: 'control', group: '对照', od: '1.20', reference: '.10' }),
    row('C2', { role: 'control', group: '对照', od: '1.40', reference: '.10' }),
    row('A1', { od: '0.80', reference: '.10' }),
  ];
  const before = structuredClone(input);
  const result = analyzeCck8(input, measured);
  const well = result.rows[4];
  close(well.signal, 0.7);
  close(well.blankMean, 0.2);
  close(well.corrected, 0.5);
  close(well.controlMean, 1);
  close(well.viability, 50);
  assert.equal(well.od, '0.80');
  assert.equal(well.source, '原始.csv');
  assert.equal(well.sourceRow, 2);
  assert.equal(result.rows[0].corrected, null);
  assert.equal(result.rows[0].viability, null);
  assert.deepEqual(input, before);
});

test('plate/time boundaries and specific blanks prevent cross-scope or invalid-blank fallback', () => {
  const input = [
    row('B', { role: 'blank', group: '', od: '0.1' }),
    row('BD', { role: 'blank', od: '0.2' }),
    row('BX', { role: 'blank', group: '坏空白组', od: 'bad' }),
    row('C', { role: 'control', group: '对照', od: '1.1' }),
    row('A', { od: '0.7' }), row('X', { group: '坏空白组' }),
    row('P2', { plate: 'P2' }), row('T2', { time: '48h' }),
  ];
  const result = analyzeCck8(input, measured);
  close(result.rows[4].viability, 50);
  for (const index of [5, 6, 7]) {
    assert.equal(result.rows[index].blankMean, null);
    assert.equal(result.rows[index].viability, null);
  }
  assert.equal(result.rows[6].controlMean, null);
  assert.equal(result.rows[7].controlMean, null);
});

test('negative values and values over 100 remain visible; absent or nonpositive denominators stay null', () => {
  const result = analyzeCck8([
    row('B', { role: 'blank', group: '', od: '0.2' }),
    row('C', { role: 'control', od: '1.2' }),
    row('N', { od: '0.1' }), row('H', { od: '1.7' }),
    row('C0', { plate: 'zero', role: 'control', od: '0' }), row('Z', { plate: 'zero' }),
    row('CN', { plate: 'negative', role: 'control', od: '-1' }), row('M', { plate: 'negative' }),
  ], measured);
  close(result.rows[2].viability, -10);
  close(result.rows[3].viability, 150);
  assert.match(result.rows[2].qc.join(' '), /负值/);
  const noBlankNeeded = analyzeCck8(result.rows.slice(4), corrected);
  for (const well of noBlankNeeded.rows) assert.equal(well.viability, null);
  assert.equal(noBlankNeeded.rows[1].controlMean, 0);
  assert.equal(noBlankNeeded.rows[3].controlMean, -1);
  assert.equal(analyzeCck8([row('only')], corrected).rows[0].viability, null);
});

test('missing, malformed, nonfinite, and excluded readings never become zero or enter control means', () => {
  const invalid = ['', ' ', 'Undetermined', '1.2abc', '0x10', 'Infinity', 'NaN', '1e999'];
  const result = analyzeCck8([
    row('C', { role: 'control', od: '1e0' }),
    row('CX', { role: 'control', od: '500', excluded: true }),
    ...invalid.map((od, index) => row(`I${index}`, { od })), row('valid', { od: ' +.5 ' }),
  ], corrected);
  for (const well of result.rows.slice(1, -1)) {
    assert.equal(well.signal, null);
    assert.equal(well.viability, null);
    assert.ok(well.qc.length);
  }
  close(result.rows.at(-1)!.viability, 50);
  assert.equal(result.summaries[0].validWells, 2);
  assert.equal(result.summaries[0].invalidWells, invalid.length);
  assert.equal(result.summaries[0].excludedWells, 1);
});

test('reference policy is local to plate/time and missing references invalidate affected wells', () => {
  const result = analyzeCck8([
    row('C', { role: 'control', od: '1.1', reference: '0.1' }),
    row('A', { od: '0.6', reference: '0.1' }), row('missing'), row('bad', { reference: '0.2x' }),
    row('C2', { plate: 'P2', role: 'control', od: '1' }), row('A2', { plate: 'P2', od: '.5' }),
    row('X2', { plate: 'P2', reference: '0.8', excluded: true }),
  ], corrected);
  close(result.rows[1].viability, 50);
  for (const well of result.rows.slice(2, 4)) {
    assert.equal(well.signal, null);
    assert.equal(well.viability, null);
    assert.match(well.qc.join(' '), /参考 OD/);
  }
  close(result.rows[5].viability, 50);
  const missingControlReference = analyzeCck8([row('C', { role: 'control' }), row('A', { reference: '.1' })], corrected);
  assert.equal(missingControlReference.rows[1].viability, null);
});

test('biological summary averages technical wells first and uses n-1 SD on sample means', () => {
  const result = analyzeCck8([
    row('C', { group: '对照', role: 'control', od: '1' }),
    row('A1', { sample: 'S1', od: '.2' }), row('A2', { sample: 'S1', od: '.4' }),
    row('A3', { sample: 'S1', od: '.6' }), row('B1', { sample: 'S2', od: '.8' }),
    row('bad', { sample: '', od: '' }),
  ], corrected);
  const group = result.summaries.find(item => item.group === '药物')!;
  assert.equal(group.unit, 'biological samples');
  assert.equal(group.n, 2);
  assert.equal(group.validWells, 4);
  assert.equal(group.invalidWells, 1);
  close(group.mean, 60);
  close(group.sd, Math.sqrt(800));
  close(group.meanCorrected, .6);
  assert.deepEqual(result.samples.map(sample => sample.wellCount), [3, 1]);
  close(result.samples[0].mean, 40);
  close(result.samples[0].sd, 20);
  assert.equal(result.samples[1].sd, null);
});

test('partially named samples are explicitly summarized as technical wells without biological n', () => {
  const result = analyzeCck8([
    row('C', { group: '对照', role: 'control', od: '1' }),
    row('A1', { sample: 'S1', od: '.2' }), row('A2', { sample: 'S1', od: '.4' }), row('B1', { sample: '', od: '.9' }),
  ], corrected);
  const group = result.summaries.find(item => item.group === '药物')!;
  assert.equal(group.unit, 'technical wells');
  assert.equal(group.n, 3);
  close(group.mean, 50);
  assert.match(group.qc.join(' '), /样本 ID 部分缺失/);
  assert.equal(result.samples[0].wellCount, 2);
  assert.equal(result.summaries[0].sd, null);
});

test('unmapped plate or group never contributes values, blanks, controls, or unnamed summaries', () => {
  const result = analyzeCck8([
    row('B', { role: 'blank', group: '', od: '.1' }),
    row('C', { role: 'control', group: '对照', od: '1.1' }),
    row('unmapped', { group: '  ', od: '.5' }),
    row('unmapped-control', { role: 'control', group: '', od: '100' }),
    row('unmapped-blank', { role: 'blank', group: '', plate: ' ', od: '100' }),
    row('no-plate', { plate: '', od: '.5' }),
    row('A', { od: '.6' }),
  ], measured);
  for (const well of result.rows.slice(2, 6)) {
    assert.deepEqual([well.signal, well.blankMean, well.corrected, well.controlMean, well.viability], [null, null, null, null, null]);
    assert.match(well.qc.join(' '), /未映射/);
  }
  close(result.rows[6].viability, 50);
  assert.ok(result.summaries.every(group => group.plate !== '' && group.group !== ''));
  assert.equal(result.summaries.find(group => group.group === '药物')!.totalWells, 1);
});

test('multiple control group names block the whole scope until a single control group is assigned', () => {
  const input = [
    row('C1', { role: 'control', group: 'vehicle A', od: '1' }),
    row('C2', { role: 'control', group: 'vehicle B', od: 'bad' }),
    row('A', { od: '.5' }),
    row('C3', { time: '48h', role: 'control', group: 'vehicle A', od: '2' }),
    row('B', { time: '48h', od: '1' }),
  ];
  const result = analyzeCck8(input, corrected);
  for (const well of result.rows.slice(0, 3)) {
    assert.equal(well.controlMean, null);
    assert.equal(well.viability, null);
    assert.match(well.qc.join(' '), /多个对照组/);
  }
  close(result.rows[4].viability, 50);
  input[1].excluded = true;
  close(analyzeCck8(input, corrected).rows[2].viability, 50);
});

test('control denominator gives independent samples equal weight despite unequal technical replication', () => {
  const result = analyzeCck8([
    row('C11', { role: 'control', group: '对照', sample: 'C1', od: '.2' }),
    row('C12', { role: 'control', group: '对照', sample: 'C1', od: '.4' }),
    row('C13', { role: 'control', group: '对照', sample: 'C1', od: '.6' }),
    row('C21', { role: 'control', group: '对照', sample: 'C2', od: '.8' }),
    row('CBad', { role: 'control', group: '对照', sample: '', od: '' }),
    row('A', { od: '.3' }),
  ], corrected);
  close(result.rows[5].controlMean, .6);
  close(result.rows[5].viability, 50);
  close(result.summaries.find(group => group.group === '对照')!.mean, 100);
  assert.match(result.rows[5].qc.join(' '), /等权平均样本/);
});

test('partially named controls use the technical mean with explicit QC', () => {
  const result = analyzeCck8([
    row('C11', { role: 'control', group: '对照', sample: 'C1', od: '.2' }),
    row('C12', { role: 'control', group: '对照', sample: 'C1', od: '.4' }),
    row('C2', { role: 'control', group: '对照', sample: '', od: '.9' }),
    row('A', { od: '.25' }),
  ], corrected);
  close(result.rows[3].controlMean, .5);
  close(result.rows[3].viability, 50);
  assert.match(result.rows[3].qc.join(' '), /对照样本 ID 部分缺失.*技术孔均值/);
});

test('corrected OD without controls retains samples-first growth summaries independent of viability', () => {
  const input = [
    row('B', { role: 'blank', group: '', od: '.1' }),
    row('A1', { sample: 'S1', od: '.3' }), row('A2', { sample: 'S1', od: '.5' }),
    row('A3', { sample: 'S1', od: '.7' }), row('B1', { sample: 'S2', od: '.9' }),
    row('bad', { od: '' }), row('excluded', { od: '999', excluded: true }),
  ];
  const result = analyzeCck8(input, measured);
  const group = result.summaries[0];
  assert.equal(group.mean, null);
  assert.equal(group.sd, null);
  assert.equal(group.n, 0);
  assert.equal(group.correctedN, 2);
  assert.equal(group.correctedWells, 4);
  assert.equal(group.correctedUnit, 'biological samples');
  close(group.meanCorrected, .6);
  close(group.sdCorrected, Math.sqrt(.08));
  assert.ok(result.rows.every(well => well.viability === null));
  assert.deepEqual(result.samples, []);

  input[4].sample = '';
  const mixed = analyzeCck8(input, measured).summaries[0];
  assert.equal(mixed.correctedUnit, 'technical wells');
  assert.equal(mixed.correctedN, 4);
  close(mixed.meanCorrected, .5);
  close(mixed.sdCorrected, Math.sqrt(.2 / 3));
  assert.match(mixed.qc.join(' '), /校正 OD.*样本 ID 部分缺失/);
});

test('duplicate physical sample, blank and control wells invalidate every conflicting row across sources', () => {
  for (const role of ['sample', 'blank', 'control'] as const) {
    const input = [
      row('blank', { role: 'blank', group: '', well: 'H12', od: '.1' }),
      row('control', { role: 'control', group: '对照', well: 'H11', od: '1.1' }),
      row('first', { role, group: role === 'blank' ? '药物' : role === 'control' ? '对照' : '药物', well: 'A1', od: '.5', source: 'one.csv' }),
      row('second', { role, group: role === 'blank' ? '药物' : role === 'control' ? '对照' : '药物', well: ' a001 ', od: '.7', source: 'two.csv' }),
      row('other', { well: 'A2', od: '.6' }),
    ];
    const result = analyzeCck8(input, measured);
    for (const well of result.rows.slice(2, 4)) {
      assert.deepEqual([well.signal, well.blankMean, well.corrected, well.controlMean, well.viability], [null, null, null, null, null]);
      assert.match(well.qc.join(' '), /物理孔 A1 重复.*全部冲突行/);
    }
    if (role === 'blank') {
      // Invalid specific blanks still prevent silently borrowing the common blank.
      assert.equal(result.rows[4].blankMean, null);
      assert.equal(result.rows[4].viability, null);
    } else close(result.rows[4].viability, 50);
    input[3].excluded = true;
    const resolved = analyzeCck8(input, measured);
    assert.equal(resolved.rows[2].signal, .5);
    assert.ok(!resolved.rows[2].qc.some(issue => issue.includes('物理孔 A1 重复')));
    assert.equal(resolved.rows[3].signal, null);
  }
});

test('physical-well uniqueness is scoped to plate/time and does not apply to arbitrary replicate labels', () => {
  const result = analyzeCck8([
    row('P1T1', { well: 'h012', od: '.2' }),
    row('P2T1', { plate: 'P2', well: 'H12', od: '.4' }),
    row('P1T2', { time: '48h', well: 'H12', od: '.6' }),
    row('R1', { well: 'rep1', od: '.8' }), row('R2', { well: 'rep1', od: '1' }),
  ], corrected);
  assert.deepEqual(result.rows.map(well => well.corrected), [.2, .4, .6, .8, 1]);
  assert.ok(!result.qc.some(issue => issue.includes('物理孔')));
});

test('all-excluded / empty groups and overflow cannot fabricate finite results', () => {
  assert.deepEqual(analyzeCck8([], measured), { rows: [], summaries: [], samples: [], qc: [] });
  const excluded = analyzeCck8([row('X', { excluded: true })], corrected);
  assert.equal(excluded.summaries[0].n, 0);
  assert.equal(excluded.summaries[0].mean, null);
  assert.equal(excluded.summaries[0].invalidWells, 0);
  const overflow = analyzeCck8([
    row('C', { role: 'control', od: '1e-300' }), row('X', { od: '1e300' }),
  ], corrected);
  assert.equal(overflow.rows[1].viability, null);
  assert.match(overflow.rows[1].qc.join(' '), /有限数值范围/);
});

test('CSV preserves text, quotes, BOM/CRLF and neutralizes whitespace-prefixed formulas, not numeric negatives', () => {
  const csv = serializeCck8Csv([
    ['组,"A"', '=HYPERLINK("bad")', ' \t+SUM(1,2)', '\n@evil', ' -2', '-1'],
    [-2, 50.5, null, undefined, Number.NaN, Number.POSITIVE_INFINITY],
  ]);
  assert.equal(csv, '\uFEFF"组,""A""","\'=HYPERLINK(""bad"")","\' \t+SUM(1,2)","\'\n@evil","\' -2","\'-1"\r\n"-2","50.5","","","",""\r\n');
});
