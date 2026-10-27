import type { Cck8Row } from './cck8';

type RecordRow = { cells: string[]; sourceRow: number };
type Field = 'plate' | 'time' | 'group' | 'sample' | 'well' | 'role' | 'od' | 'reference' | 'excluded';

const aliases: Record<string, Field> = {
  plate: 'plate', batch: 'plate', '批次': 'plate', '板号': 'plate',
  time: 'time', '时间': 'time', '时间点': 'time',
  group: 'group', '组别': 'group',
  sample: 'sample', sampleid: 'sample', '样本': 'sample', '样本id': 'sample',
  well: 'well', '孔位': 'well',
  role: 'role', type: 'role', '类型': 'role',
  od: 'od', od450: 'od', '吸光度': 'od',
  reference: 'reference', referenceod: 'reference', '参考od': 'reference',
  excluded: 'excluded', '排除': 'excluded',
};

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// Read the first nonblank record so commas inside quoted headers do not select CSV.
function delimiterOf(text: string): ',' | '\t' {
  let quoted = false;
  let tabs = 0;
  let content = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index++;
      else quoted = !quoted;
      content = true;
    } else if (!quoted && (char === '\r' || char === '\n')) {
      if (content || tabs) break;
    } else if (!quoted && char === '\t') tabs++;
    else if (char.trim()) content = true;
  }
  return tabs ? '\t' : ',';
}

/** Strict CSV/Excel TSV; cell contents and physical source line numbers stay intact. */
function readRecords(input: string): RecordRow[] {
  const text = input.replace(/^\uFEFF/, '');
  const delimiter = delimiterOf(text);
  const records: RecordRow[] = [];
  let cells: string[] = [];
  let value = '';
  let quoted = false;
  let closedQuote = false;
  let hasContent = false;
  let line = 1;
  let sourceRow = 1;
  const finish = () => {
    cells.push(value);
    // Delimiters and quoted empty cells count as records, even with no numeric data.
    if (hasContent) records.push({ cells, sourceRow });
    cells = [];
    value = '';
    hasContent = false;
    closedQuote = false;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const newline = char === '\r' || char === '\n';
    const crlf = char === '\r' && text[index + 1] === '\n';
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { value += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else {
        value += crlf ? '\r\n' : char;
        if (newline) { line++; if (crlf) index++; }
      }
    } else if (char === delimiter) {
      cells.push(value);
      value = '';
      closedQuote = false;
      hasContent = true;
    } else if (newline) {
      finish();
      line++;
      sourceRow = line;
      if (crlf) index++;
    } else if (closedQuote) {
      throw new Error(`第 ${line} 行：闭合引号后只能是分隔符或换行。`);
    } else if (char === '"') {
      if (value !== '') throw new Error(`第 ${line} 行：未加引号的单元格中含有引号，请用双引号包裹并将内部引号写为两个双引号。`);
      quoted = true;
      hasContent = true;
    } else {
      value += char;
      if (char.trim()) hasContent = true;
    }
  }
  if (quoted) throw new Error(`第 ${sourceRow} 行：引号未闭合。`);
  finish();
  return records;
}

function parseRole(value: string, sourceRow: number): Cck8Row['role'] {
  switch (value.trim().toLowerCase()) {
    case '': case 'sample': case '样本': case '实验': return 'sample';
    case 'control': case '对照': return 'control';
    case 'blank': case '空白': return 'blank';
    default: throw new Error(`第 ${sourceRow} 行：无法识别类型“${value}”，请填写 sample/样本/实验、control/对照或 blank/空白。`);
  }
}

function parseExcluded(value: string, sourceRow: number): boolean {
  switch (value.trim().toLowerCase()) {
    case '': case '0': case 'false': case 'no': case 'n': case '否': case '保留': return false;
    case '1': case 'true': case 'yes': case 'y': case '是': case '排除': return true;
    default: throw new Error(`第 ${sourceRow} 行：无法识别排除标记“${value}”，请填写 true/false、1/0 或 是/否。`);
  }
}

export function parseCck8Input(text: string, source: string, mode: 'grouped' | 'plate'): { rows: Cck8Row[]; warnings: string[] } {
  const records = readRecords(text);
  if (!records.length) throw new Error('输入为空，请粘贴或导入 CSV/TSV 数据。');
  const plate = source.split(/[\\/]/).pop() || '导入数据';
  const rows: Cck8Row[] = [];
  const warnings: string[] = [];
  const append = (record: RecordRow, values: Partial<Cck8Row>) => {
    if (rows.length >= 10000) throw new Error('导入超过 10000 个孔，请拆分文件后导入。');
    const well = values.well ?? '';
    rows.push({
      id: JSON.stringify([source, record.sourceRow, well, rows.length]),
      source, sourceRow: record.sourceRow, plate, time: '', group: '', sample: '', well,
      role: 'sample', od: '', reference: '', excluded: false, ...values,
    });
  };

  if (mode === 'plate') {
    if (records.length === 9) {
      const header = records[0].cells;
      const columns = header.length === 13 && ['', 'well', 'row', '孔位', '行'].includes(normalized(header[0])) ? header.slice(1) : header;
      if (columns.length !== 12 || columns.some((cell, index) => cell.trim() !== String(index + 1))) {
        throw new Error('96 孔板的可选列标题必须按顺序为 1–12。');
      }
      records.shift();
    }
    if (records.length !== 8) throw new Error('96 孔板必须恰好有 8 行 × 12 列读数，可附加 1–12 列标题和 A–H 行标签。');
    const labeled = records[0].cells.length === 13;
    for (const [rowIndex, record] of records.entries()) {
      const letter = String.fromCharCode(65 + rowIndex);
      if (record.cells.length !== (labeled ? 13 : 12)) throw new Error(`第 ${record.sourceRow} 行：96 孔板每行必须恰好有 12 个读数，行标签格式须一致。`);
      if (labeled && record.cells[0].trim().toUpperCase() !== letter) throw new Error(`第 ${record.sourceRow} 行：行标签应为 ${letter}，须按 A–H 排列。`);
      record.cells.slice(labeled ? 1 : 0).forEach((od, index) => append(record, { well: `${letter}${index + 1}`, od }));
    }
    return { rows, warnings };
  }

  const header = records[0].cells;
  const fields = new Map<Field, number>();
  const seen = new Set<string>();
  const replicates: { index: number; name: string }[] = [];
  const unknown: string[] = [];
  for (const [index, name] of header.entries()) {
    const key = normalized(name);
    if (!key) throw new Error(`第 ${records[0].sourceRow} 行：第 ${index + 1} 列标题为空。`);
    if (seen.has(key)) throw new Error(`重复列标题：“${name}”。`);
    seen.add(key);
    const field = Object.hasOwn(aliases, key) ? aliases[key] : undefined;
    if (field) {
      if (fields.has(field)) throw new Error(`重复字段：“${name}”与另一列表示同一个 ${field} 字段。`);
      fields.set(field, index);
    } else if (/^(?:重复|rep|replicate)[1-9]\d*$/.test(key)) {
      replicates.push({ index, name: name.trim() });
    } else unknown.push(name);
  }
  if (!fields.has('group')) throw new Error('无法识别分组表：必须包含 group/组别 列。');
  if (fields.has('od') && replicates.length) throw new Error('格式不一致：OD 长表列和重复宽表列不能同时出现。');
  if (!fields.has('od') && !replicates.length) throw new Error('无法识别分组表：需要 OD/OD450/吸光度 列，或 rep1/rep2/重复1/重复2 等复孔列。');
  if (replicates.length && fields.has('well')) throw new Error('宽表的孔位由复孔列标题确定，请移除 well/孔位 列或改用 OD 长表。');
  if (records.length === 1) throw new Error('表格只有标题，没有数据行。');
  if (unknown.length) warnings.push(`未导入不支持的列：${unknown.join('、')}。`);
  for (const record of records.slice(1)) {
    if (record.cells.length !== header.length) throw new Error(`第 ${record.sourceRow} 行有 ${record.cells.length} 列，标题有 ${header.length} 列；请保留缺失单元格的分隔符。`);
    const get = (field: Field) => {
      const index = fields.get(field);
      return index === undefined ? '' : record.cells[index];
    };
    const common = {
      plate: get('plate').trim() || plate,
      time: get('time'), group: get('group'), sample: get('sample'),
      role: parseRole(get('role'), record.sourceRow),
      reference: get('reference'), excluded: parseExcluded(get('excluded'), record.sourceRow),
    };
    if (replicates.length) {
      for (const replicate of replicates) append(record, { ...common, well: replicate.name, od: record.cells[replicate.index] });
    } else append(record, { ...common, well: get('well'), od: get('od') });
  }
  return { rows, warnings };
}

export const CCK8_TEMPLATE = [
  '批次\t时间\t组别\t样本\t孔位\t类型\tOD450\t参考OD\t排除',
  '模板板1\t24h\t\t\tA1\t空白\t0.100\t\t否',
  '模板板1\t24h\t\t\tA2\t空白\t0.110\t\t否',
  '模板板1\t24h\t对照\tC1\tB1\t对照\t1.100\t\t否',
  '模板板1\t24h\t对照\tC1\tB2\t对照\t1.120\t\t否',
  '模板板1\t24h\t对照\tC2\tB3\t对照\t1.080\t\t否',
  '模板板1\t24h\t对照\tC2\tB4\t对照\t1.100\t\t否',
  '模板板1\t24h\t处理组\tT1\tC1\t实验\t0.650\t\t否',
  '模板板1\t24h\t处理组\tT1\tC2\t实验\t0.670\t\t否',
  '模板板1\t24h\t处理组\tT2\tC3\t实验\t0.620\t\t否',
  '模板板1\t24h\t处理组\tT2\tC4\t实验\t0.640\t\t否',
].join('\r\n');

export const CCK8_DEMO = CCK8_TEMPLATE
  .replaceAll('模板板1', '模拟数据板（非实验数据）')
  .replaceAll('\t对照\tC', '\t模拟对照\t模拟C')
  .replaceAll('\t处理组\tT', '\t模拟处理组\t模拟T');
