import { csv } from './if-count-io.ts';

export interface ColonyExportRow {
  file: string; group: string; replicate: string; included: boolean;
  count: number | null; autoCount: number | null; reviewed: boolean; manual: boolean;
  coveragePct: number | null; error: string; hash: string; roi: string; parameters: string; createdAt: string;
}

const validCount = (value: number | null): value is number => value !== null && Number.isSafeInteger(value) && value >= 0;
const eligible = (row: ColonyExportRow) => row.included && !row.error.trim() && !!row.group.trim() && validCount(row.count);

/** Use explicit user order, followed by unlisted groups in first-appearance order. */
export function colonyGroupNames(rows: readonly { group: string }[], order: readonly string[] = []): string[] {
  const names = [...new Set(rows.map(row => row.group.trim()).filter(Boolean))];
  const preferred = [...new Set(order.map(name => name.trim()))].filter(name => names.includes(name));
  return [...preferred, ...names.filter(name => !preferred.includes(name))];
}

function status(row: ColonyExportRow): string {
  if (row.error.trim()) return validCount(row.count) ? '失败（保留旧计数）' : '失败';
  if (!row.included) return '已排除';
  if (row.count === null) return '未计算';
  if (!validCount(row.count)) return '无效计数';
  if (!row.group.trim()) return '未分组';
  return row.reviewed ? '已复核' : '待复核';
}

/** All wells remain auditable, including excluded, failed and uncomputed wells. */
export function colonyCsv(rows: ColonyExportRow[]): string {
  return csv([
    ['文件', '组别', '重复编号', '纳入', '克隆数', '自动克隆数', '人工修正', '已复核', '染色覆盖率_%', '计数状态', '纳入Prism', '错误', '源SHA256', '孔区域', '计数参数', '计算时间'],
    ...rows.map(row => [row.file, row.group, row.replicate, row.included,
      validCount(row.count) ? row.count : null, validCount(row.autoCount) ? row.autoCount : null,
      row.manual, row.reviewed,
      row.coveragePct !== null && Number.isFinite(row.coveragePct) && row.coveragePct >= 0 && row.coveragePct <= 100 ? row.coveragePct : null,
      status(row), eligible(row), row.error, row.hash, row.roi, row.parameters, row.createdAt]),
  ]);
}

function groupedCounts(rows: ColonyExportRow[], order?: readonly string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const row of rows) if (row.included && row.group.trim()) {
    const group = row.group.trim();
    if (!groups.has(group)) groups.set(group, []);
    if (eligible(row)) groups.get(group)!.push(row.count!);
  }
  return new Map(colonyGroupNames([...groups.keys()].map(group => ({ group })), order).filter(group => groups.get(group)!.length).map(group => [group, groups.get(group)!]));
}

function tsvHeader(value: string): string {
  const safe = /^[\s\uFEFF]*[=+\-@]/.test(value) ? `'${value}` : value;
  return /["\t\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** Independent group columns; row alignment does not encode matching or pairing. */
export function prismTsv(rows: ColonyExportRow[], order?: readonly string[]): string {
  const groups = [...groupedCounts(rows, order)];
  if (!groups.length) return '';
  const lines = [groups.map(([group]) => tsvHeader(group)).join('\t')];
  const length = Math.max(...groups.map(([, counts]) => counts.length));
  for (let i = 0; i < length; i++) lines.push(groups.map(([, counts]) => counts[i] === undefined ? '' : String(counts[i])).join('\t'));
  return lines.join('\r\n');
}

export function colonySummary(rows: ColonyExportRow[], order?: readonly string[]): { group: string; n: number; mean: number; sd: number | null }[] {
  return [...groupedCounts(rows, order)].map(([group, counts]) => {
    let mean = 0, sumSquared = 0;
    counts.forEach((count, i) => { const delta = count - mean; mean += delta / (i + 1); sumSquared += delta * (count - mean); });
    return { group, n: counts.length, mean, sd: counts.length > 1 ? Math.sqrt(sumSquared / (counts.length - 1)) : null };
  });
}
