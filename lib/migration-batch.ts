export type MigrationMode = 'scratch' | 'transwell';

export interface MigrationCsvRow {
  path: string;
  width?: number;
  height?: number;
  paramsJson: string;
  sourceHash?: string;
  algorithmVersion?: string;
  status?: string;
  roiTopPct?: number;
  roiBottomPct?: number;
  areaPx?: number | null;
  meanWidthPx?: number | null;
  autoCount?: number;
  correctedCount?: number;
  stainedAreaPx?: number;
  coveragePct?: number;
  clusterCount?: number;
  reviewed: boolean;
  manualEdited: boolean;
  pairConfirmed?: boolean;
  warnings: string[];
  error?: string;
}

/** Filename pairing is a suggestion; it does not establish registration or biological groups. */
export function parseScratchFile(path: string) {
  const normalized = path.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  const parent = normalized.slice(0, Math.max(0, slash));
  const stem = normalized.slice(slash + 1).replace(/\.[^.]+$/, '');
  const time = stem.match(/(?:_|-|\s)(\d+(?:\.\d+)?)\s*(?:h|hr|hours?)$/i);
  return { parent, series: time ? stem.slice(0, time.index) : stem, timeHours: time ? Number(time[1]) : null };
}

export function scratchClosure(row: MigrationCsvRow, rows: MigrationCsvRow[]) {
  const no = (status: string, baselinePath: string | null = null) => ({ closurePct: null, baselinePath, status });
  const current = parseScratchFile(row.path);
  if (current.timeHours === null) return no('未识别时间');
  if (row.error || row.areaPx == null || !Number.isFinite(row.areaPx) || row.areaPx < 0) return no('当前面积无效');
  const candidates = rows.filter(other => {
    const parsed = parseScratchFile(other.path);
    return parsed.parent === current.parent && parsed.series === current.series && parsed.timeHours === 0;
  });
  if (!candidates.length) return no('缺少0H');
  if (candidates.length > 1) return no('0H匹配不唯一');
  const baseline = candidates[0];
  if (baseline.error || baseline.areaPx == null || !Number.isFinite(baseline.areaPx) || baseline.areaPx <= 0) return no('0H面积无效', baseline.path);
  if (!row.width || !row.height || row.width !== baseline.width || row.height !== baseline.height) return no('图像尺寸不一致', baseline.path);
  if (row.algorithmVersion !== baseline.algorithmVersion) return no('算法版本不一致', baseline.path);
  if (row.paramsJson !== baseline.paramsJson || row.roiTopPct !== baseline.roiTopPct || row.roiBottomPct !== baseline.roiBottomPct) return no('分析参数或ROI不一致', baseline.path);
  return {
    closurePct: (baseline.areaPx - row.areaPx) / baseline.areaPx * 100,
    baselinePath: baseline.path,
    status: current.timeHours === 0 ? '基线' : row.pairConfirmed ? '同一视野已确认' : '文件名配对待核对',
  };
}

function csvCell(value: unknown) {
  let text = value == null || (typeof value === 'number' && !Number.isFinite(value)) ? '' : String(value);
  // Keep filenames and editable labels inert when opened in spreadsheet applications.
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function makeMigrationCsv(mode: MigrationMode, rows: MigrationCsvRow[]) {
  const common = ['文件路径', '源文件_SHA256', '算法版本', '宽_px', '高_px', '状态', '已复核', '人工修正', '分析参数_JSON', '提示'];
  const columns = mode === 'scratch'
    ? ['同名视野', '时间_h', '伤口面积_px2', '平均宽度_px', 'ROI上缘_%', 'ROI下缘_%', '0H文件', '闭合率_%', '配对状态']
    : ['自动估计数', '修正后估计数', '染色面积_px2', '染色覆盖率_%', '大团块数'];
  const lines = [common.concat(columns).map(csvCell).join(',')];
  for (const row of rows) {
    const values: unknown[] = [row.path, row.sourceHash, row.algorithmVersion, row.width, row.height, row.error ? `失败：${row.error}` : row.status || '完成', row.reviewed ? '是' : '否', row.manualEdited ? '是' : '否', row.paramsJson, row.warnings.join('；')];
    if (mode === 'scratch') {
      const parsed = parseScratchFile(row.path);
      const closure = scratchClosure(row, rows);
      values.push(parsed.series, parsed.timeHours, row.error ? null : row.areaPx, row.error ? null : row.meanWidthPx, row.roiTopPct, row.roiBottomPct, closure.baselinePath, closure.closurePct, closure.status);
    } else {
      values.push(...(row.error ? [null, null, null, null, null] : [row.autoCount, row.correctedCount, row.stainedAreaPx, row.coveragePct, row.clusterCount]));
    }
    lines.push(values.map(csvCell).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
