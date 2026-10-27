export type Cck8Row = {
  id: string;
  source: string;
  sourceRow: number;
  plate: string;
  time: string;
  group: string;
  sample: string;
  well: string;
  role: 'sample' | 'control' | 'blank';
  od: string;
  reference: string;
  excluded: boolean;
};

export type Cck8ResultRow = Cck8Row & {
  signal: number | null;
  blankMean: number | null;
  corrected: number | null;
  controlMean: number | null;
  viability: number | null;
  qc: string[];
};

export type Cck8SampleSummary = {
  plate: string;
  time: string;
  group: string;
  sample: string;
  wellCount: number;
  mean: number;
  sd: number | null;
  meanCorrected: number;
};

export type Cck8GroupSummary = {
  plate: string;
  time: string;
  group: string;
  totalWells: number;
  validWells: number;
  excludedWells: number;
  invalidWells: number;
  unit: 'biological samples' | 'technical wells';
  n: number;
  mean: number | null;
  sd: number | null;
  /** Corrected OD summaries remain available without a usable viability denominator. */
  meanCorrected: number | null;
  sdCorrected: number | null;
  correctedN: number;
  correctedWells: number;
  correctedUnit: 'biological samples' | 'technical wells';
  qc: string[];
};

export type Cck8Analysis = {
  rows: Cck8ResultRow[];
  summaries: Cck8GroupSummary[];
  /** Sample-level summaries use viability-eligible wells; corrected-only results are in summaries. */
  samples: Cck8SampleSummary[];
  qc: string[];
};

function parseDecimal(raw: string): number | null {
  const text = raw.trim();
  // Decimal/scientific notation only: never coerce blanks, hex, or partial numbers.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function canonical96Well(raw: string): string | null {
  const match = raw.trim().match(/^([a-h])\s*0*(1[0-2]|[1-9])$/i);
  return match ? `${match[1].toUpperCase()}${Number(match[2])}` : null;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  const value = values.reduce((sum, item) => sum + item / values.length, 0);
  return Number.isFinite(value) ? value : null;
}

function sampleSd(values: number[]): number | null {
  const average = mean(values);
  if (values.length < 2 || average === null) return null;
  const differences = values.map(value => value - average);
  const scale = differences.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
  if (scale === 0) return 0;
  const sd = scale * Math.sqrt(differences.reduce((sum, value) => sum + (value / scale) ** 2, 0) / (values.length - 1));
  return Number.isFinite(sd) ? sd : null;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

/** Each plate/time scope has its own blanks, reference policy, and control denominator. */
export function analyzeCck8(rows: Cck8Row[], options: { blankMode: 'measured' | 'already-corrected' }): Cck8Analysis {
  const result: Cck8Analysis = {
    rows: rows.map(row => ({ ...row, signal: null, blankMean: null, corrected: null, controlMean: null, viability: null, qc: [] })),
    summaries: [], samples: [], qc: [],
  };
  const scopes = groupBy(result.rows, row => JSON.stringify([row.plate.trim(), row.time.trim()]));
  for (const scope of scopes.values()) {
    const duplicates = new Set<Cck8ResultRow>();
    const physicalWells = groupBy(scope.filter(row => !row.excluded), row => canonical96Well(row.well) ?? '');
    for (const [well, conflicts] of physicalWells) {
      if (!well || conflicts.length < 2) continue;
      for (const row of conflicts) {
        duplicates.add(row);
        row.qc.push(`同板同时间点物理孔 ${well} 重复（${conflicts.length} 行），全部冲突行不参与计算；请排除重复行`);
      }
    }
    const mapped = scope.filter(row => row.plate.trim() !== '' && (row.role === 'blank' || row.group.trim() !== ''));
    const included = mapped.filter(row => !row.excluded);
    const usesReference = included.some(row => row.reference.trim() !== '');
    for (const row of scope) {
      if (row.excluded) {
        row.qc.push('已手动排除，不参与计算');
        continue;
      }
      if (!row.plate.trim()) row.qc.push('板号缺失，未映射的孔不参与计算');
      if (row.role !== 'blank' && !row.group.trim()) row.qc.push('组别缺失，未映射的孔不参与计算');
      if (!row.plate.trim() || (row.role !== 'blank' && !row.group.trim()) || duplicates.has(row)) continue;
      const od = parseDecimal(row.od);
      const reference = usesReference ? parseDecimal(row.reference) : 0;
      if (od === null) row.qc.push(row.od.trim() ? 'OD 无效，须为有限十进制数值' : 'OD 缺失');
      if (reference === null) row.qc.push('同板同时间点已使用参考波长，本孔参考 OD 缺失或无效');
      if (od === null || reference === null) continue;
      const signal = od - reference;
      if (!Number.isFinite(signal)) row.qc.push('OD 减参考 OD 超出有限数值范围');
      else row.signal = signal;
    }

    const blankGroups = groupBy(included.filter(row => row.role === 'blank'), row => row.group.trim());
    for (const row of included) {
      if (row.role === 'blank' || duplicates.has(row)) continue;
      if (options.blankMode === 'already-corrected') {
        row.blankMean = 0;
      } else {
        // A supplied group blank takes precedence even when all its readings are invalid.
        const blanks = blankGroups.get(row.group.trim()) ?? blankGroups.get('') ?? [];
        row.blankMean = mean(blanks.flatMap(blank => blank.signal === null ? [] : [blank.signal]));
        if (row.blankMean === null) row.qc.push('同板同时间点缺少有效匹配空白，未计算校正 OD');
        else if (blanks.some(blank => blank.signal === null)) row.qc.push('匹配空白中存在无效孔，空白均值仅使用有效孔');
      }
      if (row.signal !== null && row.blankMean !== null) {
        const corrected = row.signal - row.blankMean;
        if (!Number.isFinite(corrected)) row.qc.push('空白校正结果超出有限数值范围');
        else {
          row.corrected = corrected;
          if (corrected < 0) row.qc.push('校正 OD 为负值，保留原值');
        }
      }
    }

    const controls = included.filter(row => row.role === 'control');
    const ambiguousControls = new Set(controls.map(row => row.group.trim())).size > 1;
    const validControls = controls.filter(row => row.corrected !== null);
    const namedControls = validControls.filter(row => row.sample.trim() !== '');
    const biologicalControls = validControls.length > 0 && namedControls.length === validControls.length;
    const controlValues = biologicalControls
      ? [...groupBy(validControls, row => row.sample.trim()).values()].map(wells => mean(wells.map(row => row.corrected!))!)
      : validControls.map(row => row.corrected!);
    const controlMean = ambiguousControls ? null : mean(controlValues);
    for (const row of included) {
      if (row.role === 'blank' || duplicates.has(row)) continue;
      if (ambiguousControls) {
        row.qc.push('同板同时间点存在多个对照组，缺少配对关系；未计算活力');
        continue;
      }
      row.controlMean = controlMean;
      if (controlMean === null || controlMean <= 0) {
        row.qc.push('同板同时间点的对照均值缺失或不大于 0，未计算活力');
        continue;
      }
      if (controls.some(control => control.corrected === null)) row.qc.push('对照中存在无效孔，对照均值仅使用有效孔');
      if (biologicalControls) row.qc.push('对照先平均同一样本技术复孔，再等权平均样本');
      else if (namedControls.length > 0) row.qc.push('对照样本 ID 部分缺失，归一化对照采用技术孔均值');
      if (row.corrected === null) continue;
      const viability = row.corrected / controlMean * 100;
      if (!Number.isFinite(viability)) row.qc.push('活力结果超出有限数值范围');
      else {
        row.viability = viability;
        if (viability > 100) row.qc.push('活力大于 100%，保留原值');
      }
    }

    const groups = groupBy(mapped.filter(row => row.role !== 'blank'), row => row.group.trim());
    for (const [group, groupRows] of groups) {
      const first = groupRows[0];
      const location = { plate: first.plate.trim(), time: first.time.trim(), group };
      const valid = groupRows.filter(row => row.viability !== null);
      const named = valid.filter(row => row.sample.trim() !== '');
      const sampleGroups = groupBy(named, row => row.sample.trim());
      const samples = [...sampleGroups].map(([sample, wells]): Cck8SampleSummary => ({
        ...location, sample, wellCount: wells.length,
        mean: mean(wells.map(row => row.viability!))!,
        sd: sampleSd(wells.map(row => row.viability!)),
        meanCorrected: mean(wells.map(row => row.corrected!))!,
      }));
      result.samples.push(...samples);
      const biological = valid.length > 0 && named.length === valid.length;
      const values = biological ? samples.map(sample => sample.mean) : valid.map(row => row.viability!);
      const correctedRows = groupRows.filter(row => row.corrected !== null);
      const correctedNamed = correctedRows.filter(row => row.sample.trim() !== '');
      const correctedBiological = correctedRows.length > 0 && correctedNamed.length === correctedRows.length;
      const correctedValues = correctedBiological
        ? [...groupBy(correctedRows, row => row.sample.trim()).values()].map(wells => mean(wells.map(row => row.corrected!))!)
        : correctedRows.map(row => row.corrected!);
      const excludedWells = groupRows.filter(row => row.excluded).length;
      const qc: string[] = [];
      if (!valid.length) qc.push('无可计算活力的有效孔');
      else if (!biological) qc.push('按技术孔汇总，孔数不能作为生物学重复数');
      if (named.length > 0 && named.length < valid.length) qc.push('样本 ID 部分缺失；本组按技术孔汇总');
      if (biological) qc.push('先平均同一样本技术复孔；生物学独立性需由实验设计确认');
      if (values.length < 2) qc.push('汇总单位少于 2，样本 SD 留空');
      if (correctedNamed.length > 0 && correctedNamed.length < correctedRows.length) qc.push('校正 OD 有效孔的样本 ID 部分缺失；按技术孔汇总');
      if (correctedValues.length < 2) qc.push('校正 OD 汇总单位少于 2，SD 留空');
      result.summaries.push({
        ...location, totalWells: groupRows.length, validWells: valid.length, excludedWells,
        invalidWells: groupRows.length - valid.length - excludedWells,
        unit: biological ? 'biological samples' : 'technical wells', n: values.length,
        mean: mean(values), sd: sampleSd(values), meanCorrected: mean(correctedValues),
        sdCorrected: sampleSd(correctedValues), correctedN: correctedValues.length, correctedWells: correctedRows.length,
        correctedUnit: correctedBiological ? 'biological samples' : 'technical wells', qc,
      });
    }
  }
  const messages = new Set<string>();
  for (const row of [...result.rows, ...result.summaries]) {
    const scope = `${row.plate.trim() || '未标注板'} / ${row.time.trim() || '未标注时间'} / ${row.group.trim() || '未标注组'}`;
    for (const issue of row.qc) messages.add(`${scope}：${issue}`);
  }
  result.qc = [...messages];
  return result;
}

/** UTF-8 BOM, CRLF, and inert text cells for Excel-compatible local exports. */
export function serializeCck8Csv(cells: (string | number | null | undefined)[][]): string {
  const lines = cells.map(row => row.map(value => {
    let text = value == null || (typeof value === 'number' && !Number.isFinite(value)) ? '' : String(value);
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
