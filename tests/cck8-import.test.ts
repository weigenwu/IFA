import assert from 'node:assert/strict';
import test from 'node:test';
import { CCK8_DEMO, CCK8_TEMPLATE, parseCck8Input } from '../lib/cck8-import.ts';

const grouped = (text: string, source = '原始.csv') => parseCck8Input(text, source, 'grouped');
const grid = () => Array.from({ length: 8 }, (_, row) => Array.from({ length: 12 }, (_, column) => `${row}.${column}`));

test('CSV supports BOM, CRLF, quoted commas/escaped quotes/multiline and physical source rows', () => {
  const input = '\uFEFF\r\ngroup,OD450,sample,time,reference,role,excluded\r\n"药物,""A""\r\n第二行", 0.50 ,S1,24h,Undetermined,实验,否\r\n\r\n对照,1,C1,24h,0.1,CONTROL,TRUE\r\n';
  const { rows } = grouped(input, 'C:\\导出\\原始.csv');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].group, '药物,"A"\r\n第二行');
  assert.equal(rows[0].od, ' 0.50 ');
  assert.equal(rows[0].reference, 'Undetermined');
  assert.equal(rows[0].sourceRow, 3);
  assert.equal(rows[1].sourceRow, 6);
  assert.equal(rows[0].source, 'C:\\导出\\原始.csv');
  assert.equal(rows[0].plate, '原始.csv');
  assert.equal(rows[0].role, 'sample');
  assert.equal(rows[1].role, 'control');
  assert.equal(rows[1].excluded, true);
  assert.equal(rows[0].id, grouped(input, 'C:\\导出\\原始.csv').rows[0].id);
});

test('TSV accepts Chinese aliases and raw missing, malformed, formula-like numeric values', () => {
  const { rows } = grouped('组别\t吸光度\t参考OD\t类型\t孔位\n药物\t\tbad\t\tA1\n药物\tUndetermined\t\t样本\tA2\n=HYPERLINK("x")\t+SUM(1,2)\tNaN\t实验\tA3'.replace('=HYPERLINK("x")', '"=HYPERLINK(""x"")"'));
  assert.deepEqual(rows.map(row => row.od), ['', 'Undetermined', '+SUM(1,2)']);
  assert.deepEqual(rows.map(row => row.reference), ['bad', '', 'NaN']);
  assert.equal(rows[2].group, '=HYPERLINK("x")');
  assert.equal(rows[0].time, '');
  assert.equal(rows[0].sample, '');
  assert.ok(rows.every(row => row.role === 'sample'));
});

test('wide import preserves every replicate, including partial and wholly missing readings', () => {
  const input = '组别\t时间\t批次\t样本\t类型\t重复1\t重复2\t重复3\n\t24h\tP1\t\t空白\t.1\t\t.2\n药物\t24h\tP1\tS1\t实验\t\t\t\n';
  const { rows } = grouped(input);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map(row => row.od), ['.1', '', '.2', '', '', '']);
  assert.deepEqual(rows.map(row => row.well), ['重复1', '重复2', '重复3', '重复1', '重复2', '重复3']);
  assert.deepEqual(rows.map(row => row.sourceRow), [2, 2, 2, 3, 3, 3]);
  assert.ok(rows.slice(0, 3).every(row => row.role === 'blank' && row.group === ''));
  assert.ok(rows.slice(3).every(row => row.sample === 'S1'));
  assert.equal(new Set(rows.map(row => row.id)).size, 6);
  assert.deepEqual(grouped('group,rep1,rep2\n药物,.1,').rows.map(row => row.od), ['.1', '']);
});

test('delimiter-only records are retained; only completely blank lines are ignored', () => {
  const { rows } = grouped('group,od\n\n,\n  \n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].od, '');
  assert.equal(rows[0].sourceRow, 3);
  assert.equal(grouped('group\tod\n\t\n').rows.length, 1);
});

test('strict CSV rejects incomplete quotes, stray quotes and characters after closing quotes', () => {
  for (const input of ['group,od\n"药物,.5', 'group,od\n药"物,.5', 'group,od\n"药物"x,.5', 'group,od\n"药物" ,.5']) {
    assert.throws(() => grouped(input), /引号/);
  }
  assert.throws(() => grouped('group\tod\n"药物\t.5'), /引号未闭合/);
});

test('duplicate headers, conflicting formats, unsupported roles and irregular widths are errors', () => {
  const cases: [string, RegExp][] = [
    ['group,OD,od\n药物,.5,.5', /重复列标题/],
    ['group,组别,OD\n药物,药物,.5', /重复字段/],
    ['group,rep1,REP1\n药物,.5,.5', /重复列标题/],
    ['group,,OD\n药物,,.5', /标题为空/],
    ['group,OD,rep1\n药物,.5,.5', /不能同时/],
    ['group,well,rep1\n药物,A1,.5', /宽表的孔位/],
    ['group,OD,role\n药物,.5,treatment', /无法识别类型/],
    ['group,OD,excluded\n药物,.5,maybe', /无法识别排除/],
    ['group,OD\n药物,.5,more', /有 3 列/],
    ['group,rep1,rep2\n药物,.5', /有 2 列/],
    ['OD\n.5', /必须包含/],
    ['group,number\n药物,.5', /需要 OD/],
    ['group,od', /只有标题/],
    ['\uFEFF\r\n ', /输入为空/],
  ];
  for (const [input, message] of cases) assert.throws(() => grouped(input), message);
});

test('unknown columns are reported and inherited object names cannot masquerade as fields', () => {
  const { rows, warnings } = grouped('group,od,note,__proto__,constructor\n药物,.5,备注,x,y');
  assert.equal(rows[0].od, '.5');
  assert.match(warnings.join(' '), /note.*__proto__.*constructor/);
});

test('source basename including extension separates files; explicit plates and numeric spelling survive', () => {
  const input = 'group,od,plate\n药物,1e-2,\n药物,000.50,P2';
  const first = grouped(input, '/readings/one.csv').rows;
  const second = grouped(input, '/readings/one.tsv').rows;
  assert.equal(first[0].plate, 'one.csv');
  assert.equal(second[0].plate, 'one.tsv');
  assert.equal(first[1].plate, 'P2');
  assert.deepEqual(first.map(row => row.od), ['1e-2', '000.50']);
  assert.notEqual(first[0].id, second[0].id);
});

test('96-well grid maps A1 through H12, keeps raw values and does not infer groups or roles', () => {
  const cells = grid();
  cells[0][0] = '';
  cells[0][1] = 'Undetermined';
  cells[7][11] = '=SUM(1;2)';
  const rows = parseCck8Input(cells.map(row => row.join('\t')).join('\n'), 'plate.tsv', 'plate').rows;
  assert.equal(rows.length, 96);
  assert.equal(rows[0].well, 'A1');
  assert.equal(rows[0].od, '');
  assert.equal(rows[1].od, 'Undetermined');
  assert.equal(rows[12].well, 'B1');
  assert.equal(rows[95].well, 'H12');
  assert.equal(rows[95].od, '=SUM(1;2)');
  assert.ok(rows.every(row => row.group === '' && row.role === 'sample' && row.plate === 'plate.tsv'));
  assert.equal(rows[95].sourceRow, 8);
  assert.equal(new Set(rows.map(row => row.id)).size, 96);
});

test('96-well optional headers and labels are checked, with original source row mapping', () => {
  const numbers = Array.from({ length: 12 }, (_, index) => String(index + 1));
  for (const labeled of [false, true]) {
    const body = grid().map((row, index) => labeled ? [String.fromCharCode(65 + index), ...row] : row);
    const header = labeled ? ['', ...numbers] : numbers;
    const result = parseCck8Input([header, ...body].map(row => row.join(',')).join('\r\n'), 'plate.csv', 'plate');
    assert.equal(result.rows.length, 96);
    assert.equal(result.rows[0].sourceRow, 2);
    assert.equal(result.rows[95].sourceRow, 9);
  }
  const labeled = grid().map((row, index) => [String.fromCharCode(65 + index), ...row]);
  assert.equal(parseCck8Input(labeled.map(row => row.join('\t')).join('\n'), 'plate.tsv', 'plate').rows.length, 96);
  labeled[2][0] = 'D';
  assert.throws(() => parseCck8Input(labeled.map(row => row.join('\t')).join('\n'), 'plate.tsv', 'plate'), /行标签应为 C/);
});

test('plate mode rejects missing or additional cells/rows instead of silently reshaping', () => {
  const parse = (cells: string[][]) => parseCck8Input(cells.map(row => row.join('\t')).join('\n'), 'p.tsv', 'plate');
  assert.throws(() => parse(grid().slice(1)), /8 行/);
  const missing = grid(); missing[4].pop();
  assert.throws(() => parse(missing), /12 个读数/);
  const extra = grid(); extra[4].push('.9');
  assert.throws(() => parse(extra), /12 个读数/);
  assert.throws(() => parse([Array(12).fill('bad'), ...grid()]), /列标题/);
  const emptyRow = grid(); emptyRow[4] = Array(12).fill('');
  assert.equal(parse(emptyRow).rows.length, 96);
});

test('output is capped at 10000 wells including flattened wide-table replicates', () => {
  const input = 'group,od\n' + Array(10000).fill('药物,.5').join('\n');
  assert.equal(grouped(input).rows.length, 10000);
  assert.throws(() => grouped(input + '\n药物,.5'), /10000/);
  assert.throws(() => grouped('group,rep1,rep2,rep3\n' + Array(3334).fill('药物,.1,.2,.3').join('\n')), /10000/);
});

test('template and visibly synthetic demo contain scoped blanks, controls and identified samples', () => {
  for (const text of [CCK8_TEMPLATE, CCK8_DEMO]) {
    const { rows, warnings } = grouped(text);
    assert.equal(warnings.length, 0);
    assert.deepEqual(new Set(rows.map(row => row.role)), new Set(['blank', 'control', 'sample']));
    assert.ok(rows.every(row => row.time === '24h'));
    assert.ok(rows.filter(row => row.role !== 'blank').every(row => row.sample !== ''));
    assert.ok(rows.filter(row => row.role === 'blank').every(row => row.group === ''));
  }
  assert.match(CCK8_DEMO, /模拟数据板（非实验数据）/);
});
