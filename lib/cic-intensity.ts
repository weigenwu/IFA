import type { ChannelData, IntensityStats } from './analysis.ts';

export type CicPoint = { x: number; y: number };
export type CicPolygon = CicPoint[];
export interface CicRois {
  inner: CicPolygon;
  outer: CicPolygon;
  background: CicPolygon;
  innerExclusions: CicPolygon[];
  outerExclusions: CicPolygon[];
}
export interface CicMetadata {
  imageHash: string;
  fileName: string;
  channelId: string;
  channelLabel: string;
  marker: string;
  experimentId: string;
  fieldId: string;
  pairId: string;
  innerLabel: string;
  outerLabel: string;
  provenance?: {
    sourceFiles: string[];
    format: string;
    pageCount: number;
    displayOnly: boolean;
    warnings: string[];
    bitDepth: number;
    maxValue: number;
    pixelSizeUm: number | null;
  };
}
export type CicRawStats = Pick<IntensityStats, 'pixels' | 'mean' | 'sd' | 'sum' | 'min' | 'max'>;
export type CicCellStats = Omit<IntensityStats, 'median' | 'saturationPct'> & { saturationPct: number | null };
export interface CicMeasurement {
  version: 1;
  recordKey: string;
  metadata: CicMetadata;
  rois: CicRois;
  width: number;
  height: number;
  inner: CicCellStats;
  outer: CicCellStats;
  background: CicRawStats;
  difference: number;
  ratio: number | null;
  warnings: string[];
}
export interface CicExperimentSummary {
  experimentId: string;
  marker: string;
  channelId: string;
  channelLabel: string;
  innerLabel: string;
  outerLabel: string;
  pairCount: number;
  fieldCount: number;
  innerMean: number;
  outerMean: number;
  difference: number;
}

const equalPoint = (a: CicPoint, b: CicPoint) => a.x === b.x && a.y === b.y;
const cross = (a: CicPoint, b: CicPoint, c: CicPoint) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function onSegment(a: CicPoint, b: CicPoint, p: CicPoint) {
  return cross(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}
function properCross(a: CicPoint, b: CicPoint, c: CicPoint, d: CicPoint) {
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}
function intersects(a: CicPoint, b: CicPoint, c: CicPoint, d: CicPoint) {
  return properCross(a,b,c,d) || onSegment(a,b,c) || onSegment(a,b,d) || onSegment(c,d,a) || onSegment(c,d,b);
}
function inside(p: CicPoint, polygon: CicPolygon) {
  let hit = false;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    if (onSegment(a, b, p)) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (b.x-a.x)*(p.y-a.y)/(b.y-a.y)) hit = !hit;
  }
  return hit;
}
function assertSize(width: number, height: number) {
  if (![width, height, width * height].every(v => Number.isSafeInteger(v) && v > 0)) throw new Error('无效的图像尺寸。');
}
export function validateCicPolygon(polygon: CicPolygon, width: number, height: number, label = '轮廓'): CicPolygon {
  assertSize(width, height);
  if (!Array.isArray(polygon) || polygon.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
    || p.x < 0 || p.y < 0 || p.x > width || p.y > height)) throw new Error(label + '包含越界或无效坐标。');
  const points = polygon.map(({x,y}) => ({x,y}));
  if (points.length > 1 && equalPoint(points[0], points[points.length - 1])) points.pop();
  if (points.length < 3) throw new Error(label + '至少需要三个不同的顶点。');
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    if (equalPoint(a,b) || onSegment(a,b,c) || onSegment(b,c,a)) throw new Error(label + '含重复顶点或折返边。');
    area += a.x * b.y - a.y * b.x;
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (intersects(a, b, points[j], points[(j+1) % points.length])) throw new Error(label + '存在自交，请重新圈选。');
    }
  }
  if (area === 0) throw new Error(label + '面积为零。');
  return points;
}

function containedIn(child: CicPolygon, parent: CicPolygon) {
  // At a concave vertex an edge can leave and re-enter without any proper crossing.
  // Split such edges at the vertex and inspect each open interval.
  return child.every((a, i) => {
    if (!inside(a, parent)) return false;
    const b = child[(i + 1) % child.length], dx = b.x - a.x, dy = b.y - a.y;
    const knots = [0, 1];
    for (let j = 0; j < parent.length; j++) {
      const c = parent[j], d = parent[(j+1) % parent.length];
      if (properCross(a,b,c,d)) return false;
      if (onSegment(a,b,c)) knots.push(Math.abs(dx) > Math.abs(dy) ? (c.x-a.x)/dx : (c.y-a.y)/dy);
    }
    knots.sort((x,y) => x-y);
    return knots.slice(1).every((t,j) => {
      if (t === knots[j]) return true;
      const mid = (t + knots[j])/2;
      return inside({x:a.x + mid*dx, y:a.y + mid*dy},parent);
    });
  });
}

function validateRois(raw: CicRois, width: number, height: number): CicRois {
  if (!raw || !Array.isArray(raw.innerExclusions) || !Array.isArray(raw.outerExclusions)) throw new Error('配对区域格式不正确。');
  const valid = (p: CicPolygon, label: string) => validateCicPolygon(p, width, height, label);
  const inner = valid(raw.inner,'内细胞'), outer = valid(raw.outer,'外细胞'), background = valid(raw.background,'背景');
  if (!containedIn(inner,outer)) throw new Error('内细胞必须完全位于外细胞轮廓内。');
  const touching = background.some((a,i) => outer.some((b,j) => intersects(a,background[(i+1)%background.length],b,outer[(j+1)%outer.length])));
  if (touching || inside(background[0],outer) || inside(outer[0],background)) throw new Error('背景与外细胞轮廓相交，请另选无细胞背景。');
  function exclusions(list: CicPolygon[], parent: CicPolygon, name: string) {
    return list.map(p => {
      const poly = valid(p, name + '排除区');
      if (!containedIn(poly, parent)) throw new Error(name + '排除区必须位于相应细胞的轮廓内。');
      return poly;
    });
  }
  return {inner,outer,background,innerExclusions:exclusions(raw.innerExclusions,inner,'内细胞'),outerExclusions:exclusions(raw.outerExclusions,outer,'外细胞')};
}

type Span = [number, number];
function rowSpans(polygon: CicPolygon, y: number): Span[] {
  const center = y + 0.5;
  const hits: number[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i+1) % polygon.length];
    if ((a.y > center) !== (b.y > center)) hits.push(a.x + (center-a.y)*(b.x-a.x)/(b.y-a.y));
  }
  hits.sort((a,b) => a-b);
  const spans: Span[] = [];
  for (let i = 0; i < hits.length; i += 2) {
    const start = Math.ceil(hits[i] - 0.5), end = Math.ceil(hits[i+1] - 0.5);
    if (start < end) spans.push([start,end]);
  }
  return spans;
}

function sampleRegion(channel: ChannelData, width: number, polygon: CicPolygon, exclusions: CicPolygon[], label: string) {
  const ys = polygon.map(p => p.y);
  const first = Math.ceil(Math.min(...ys) - .5), stop = Math.ceil(Math.max(...ys) - .5);
  let pixels = 0, mean = 0, m2 = 0, sum = 0, min = Infinity, max = -Infinity, saturated = 0;
  const canCheckSaturation = channel.integer && Number.isFinite(channel.maxValue) && channel.maxValue > 0;
  const hasPixels = exclusions.map(() => false);
  for (let y = first; y < stop; y++) {
    const spans = rowSpans(polygon,y);
    const holes = exclusions.flatMap((p,idx) => {
      const row = rowSpans(p,y);
      if (row.length) hasPixels[idx] = true;
      return row;
    }).sort((a,b) => a[0]-b[0]);
    let hole = 0;
    for (const [start,end] of spans) {
      for (let x = start; x < end; x++) {
        while (hole < holes.length && holes[hole][1] <= x) hole++;
        if (hole < holes.length && holes[hole][0] <= x) {
          x = holes[hole][1] - 1;
          continue;
        }
        const value = channel.data[y * width + x];
        if (!Number.isFinite(value)) throw new Error(label + '含非有限像素值。');
        pixels++;
        sum += value;
        const delta = value - mean;
        mean += delta / pixels;
        m2 += delta * (value - mean);
        min = Math.min(min,value);
        max = Math.max(max,value);
        if (canCheckSaturation && value >= channel.maxValue) saturated++;
      }
    }
  }
  if (hasPixels.some(hit => !hit)) throw new Error(label + '的排除区没有覆盖任何像素中心。');
  if (!pixels) throw new Error(label + '没有可用像素，请检查轮廓及排除区。');
  const sd = pixels > 1 ? Math.sqrt(Math.max(m2,0)/(pixels-1)) : 0;
  if (![sum, mean, sd].every(Number.isFinite)) throw new Error(label + '统计量超出有效数值范围。');
  return {raw:{pixels, mean, sd, sum, min, max}, saturationPct:canCheckSaturation ? 100*saturated/pixels : null};
}

const idFields = ['imageHash','fileName','channelId','channelLabel','marker','experimentId','fieldId','pairId','innerLabel','outerLabel'] as const;
const asObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const strList = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positiveInt = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v > 0;
function readMetadata(value: unknown): CicMetadata {
  if (!asObject(value)) throw new Error('缺少配对记录信息。');
  const meta = {} as CicMetadata;
  for (const key of idFields) {
    const item = value[key];
    if (typeof item !== 'string' || !item.trim()) throw new Error('请填写完整记录信息（' + key + '）。');
    meta[key] = item.trim();
  }
  const p = value.provenance;
  if (p !== undefined) {
    if (!asObject(p) || !strList(p.sourceFiles) || typeof p.format !== 'string' || !positiveInt(p.pageCount)
      || typeof p.displayOnly !== 'boolean' || !strList(p.warnings) || !positiveInt(p.bitDepth) || !finite(p.maxValue)
      || !(p.pixelSizeUm === null || (finite(p.pixelSizeUm) && p.pixelSizeUm > 0))) throw new Error('图像来源或标定信息无效。');
    meta.provenance = {sourceFiles:[...p.sourceFiles],format:p.format,pageCount:p.pageCount,displayOnly:p.displayOnly,
      warnings:[...p.warnings],bitDepth:p.bitDepth,maxValue:p.maxValue,pixelSizeUm:p.pixelSizeUm};
  }
  return meta;
}
export function cicRecordKey(meta: Pick<CicMetadata, 'imageHash'|'pairId'|'channelId'>): string {
  return JSON.stringify([meta.imageHash.trim(),meta.pairId.trim(),meta.channelId.trim()]);
}
export function analyzeCicPair(input: {
  channel: ChannelData; width: number; height: number; rois: CicRois; metadata: CicMetadata;
}): CicMeasurement {
  const {channel,width,height} = input;
  assertSize(width,height);
  const metadata = readMetadata(input.metadata);
  if (channel.data.length !== width*height || channel.id !== metadata.channelId) throw new Error('定量通道与图像或记录不匹配。');
  const rois = validateRois(input.rois,width,height);
  const background = sampleRegion(channel,width,rois.background,[],'背景').raw;
  function corrected(poly: CicPolygon, holes: CicPolygon[], label: string): CicCellStats {
    const {raw,saturationPct} = sampleRegion(channel,width,poly,holes,label);
    const ctcf = raw.sum - raw.pixels * background.mean;
    const correctedMean = raw.mean - background.mean;
    if (![ctcf, correctedMean].every(Number.isFinite)) throw new Error(label + '校正强度超出有效数值范围。');
    return {...raw,backgroundMean:background.mean,backgroundSd:background.sd,correctedMean,ctcf,saturationPct};
  }
  const inner = corrected(rois.inner,rois.innerExclusions,'内细胞');
  const outer = corrected(rois.outer,[rois.inner,...rois.outerExclusions],'外细胞');
  const warnings = [...(metadata.provenance?.warnings ?? [])];
  const difference = inner.correctedMean - outer.correctedMean;
  if (!Number.isFinite(difference)) throw new Error('校正强度差超出有效数值范围。');
  const quotient = inner.correctedMean / outer.correctedMean;
  const ratio = inner.correctedMean > 0 && outer.correctedMean > 0 && Number.isFinite(quotient) ? quotient : null;
  if (ratio === null) warnings.push('校正均值非正或比值超出范围，内/外比值留空。');
  if ((inner.saturationPct ?? 0) > 0 || (outer.saturationPct ?? 0) > 0) warnings.push('细胞区域含饱和像素。');
  return {version:1,recordKey:cicRecordKey(metadata),metadata,rois,width,height,inner,outer,background,difference,ratio,warnings};
}

export function upsertCicRecord(records: CicMeasurement[], record: CicMeasurement): CicMeasurement[] {
  const idx = records.findIndex(r => r.recordKey === record.recordKey);
  if (idx < 0) return [...records,record];
  return records.map((r,i) => i === idx ? record : r);
}
export function summarizeCicExperiments(records: CicMeasurement[]): CicExperimentSummary[] {
  const groups = new Map<string, {summary: CicExperimentSummary; fields: Set<string>}>();
  for (const r of records) {
    const {experimentId,marker,channelId,innerLabel,outerLabel,fieldId} = r.metadata;
    const key = JSON.stringify([experimentId,marker,channelId,innerLabel,outerLabel]);
    let group = groups.get(key);
    if (!group) {
      const summary = {experimentId,marker,channelId,channelLabel:marker,innerLabel,outerLabel,pairCount:0,fieldCount:0,innerMean:0,outerMean:0,difference:0};
      group = {summary,fields:new Set<string>()};
      groups.set(key,group);
    }
    group.fields.add(fieldId);
    const s = group.summary;
    s.fieldCount = group.fields.size;
    s.pairCount++;
    s.innerMean += (r.inner.correctedMean - s.innerMean) / s.pairCount;
    s.outerMean += (r.outer.correctedMean - s.outerMean) / s.pairCount;
    s.difference += (r.difference - s.difference) / s.pairCount;
  }
  return Array.from(groups.values(), g => g.summary);
}

type CsvCell = string | number | null;
function csvRows(rows: CsvCell[][]): string {
  function escape(cell: CsvCell) {
    if (cell === null) return '';
    if (typeof cell === 'number') return String(cell);
    const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(cell) ? "'" + cell : cell;
    return '"' + safe.replaceAll('"','""') + '"';
  }
  return '\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
const rawFields = ['pixels','mean','sd','sum','min','max'] as const;
const cellFields = [...rawFields,'backgroundMean','backgroundSd','correctedMean','ctcf','saturationPct'] as const;
export function cicRecordsCsv(records: CicMeasurement[]): string {
  const headers = [...idFields,'width','height',...rawFields.map(k => 'background_'+k),
    ...cellFields.map(k => 'inner_'+k),...cellFields.map(k => 'outer_'+k),'difference','ratio','warnings',
    'sourceFiles','format','pageCount','displayOnly','bitDepth','maxValue','pixelSizeUm'];
  return csvRows([headers,...records.map(r => {
    const p = r.metadata.provenance;
    return [...idFields.map(k => r.metadata[k]),r.width,r.height,...rawFields.map(k => r.background[k]),
      ...cellFields.map(k => r.inner[k]),...cellFields.map(k => r.outer[k]),r.difference,r.ratio,r.warnings.join(' | '),
      p?.sourceFiles.join(' | ') ?? '',p?.format ?? '',p?.pageCount ?? null,p ? String(p.displayOnly) : '',
      p?.bitDepth ?? null,p?.maxValue ?? null,p?.pixelSizeUm ?? null];
  })]);
}
export function cicSummaryCsv(summaries: CicExperimentSummary[]): string {
  const columns = ['experimentId','marker','channelId','channelLabel','innerLabel','outerLabel','pairCount','fieldCount','innerMean','outerMean','difference'] as const;
  return csvRows([[...columns],...summaries.map(s => columns.map(k => s[k]))]);
}

export function cicProjectJson(records: CicMeasurement[]): string {
  return JSON.stringify({format:'fluoroscope-cic-pairs',version:1,records},null,2);
}
function readRaw(value: unknown): CicRawStats {
  if (!asObject(value)) throw new Error('项目中的像素统计量无效。');
  const {pixels, mean, sd, sum, min, max} = value;
  if (!positiveInt(pixels) || !finite(mean) || !finite(sd) || sd < 0 || !finite(sum) || !finite(min)
    || !finite(max) || min > max) throw new Error('项目中的像素统计量无效。');
  return {pixels,mean,sd,sum,min,max};
}
function readCell(value: unknown): CicCellStats {
  const raw = readRaw(value);
  if (!asObject(value)) throw new Error('无效的细胞统计量。');
  const {backgroundMean,backgroundSd,correctedMean,ctcf,saturationPct} = value;
  if (!finite(backgroundMean) || !finite(backgroundSd) || backgroundSd < 0 || !finite(correctedMean)
    || !finite(ctcf) || !(saturationPct === null || (finite(saturationPct) && saturationPct >= 0 && saturationPct <= 100))) {
    throw new Error('项目中的校正强度或饱和度无效。');
  }
  return {...raw,backgroundMean,backgroundSd,correctedMean,ctcf,saturationPct};
}
export function parseCicProjectJson(text: string): CicMeasurement[] {
  const project: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!asObject(project) || project.format !== 'fluoroscope-cic-pairs' || project.version !== 1 || !Array.isArray(project.records)) {
    throw new Error('请选择 CIC 配对分析导出的项目 JSON。');
  }
  const keys = new Set<string>();
  return project.records.map((entry: unknown) => {
    if (!asObject(entry) || entry.version !== 1 || !positiveInt(entry.width) || !positiveInt(entry.height)
      || !asObject(entry.rois) || !strList(entry.warnings)) throw new Error('项目中的配对记录不完整。');
    const metadata = readMetadata(entry.metadata);
    const recordKey = cicRecordKey(metadata);
    if (recordKey !== entry.recordKey || keys.has(recordKey)) throw new Error('项目中存在重复或不一致的配对编号。');
    keys.add(recordKey);
    const {width,height} = entry;
    const rois = validateRois(entry.rois as unknown as CicRois,width,height);
    const inner = readCell(entry.inner), outer = readCell(entry.outer), background = readRaw(entry.background);
    const quotient = inner.correctedMean / outer.correctedMean;
    const ratio = inner.correctedMean > 0 && outer.correctedMean > 0 && Number.isFinite(quotient) ? quotient : null;
    const difference = inner.correctedMean - outer.correctedMean;
    if (entry.difference !== difference || !finite(difference) || entry.ratio !== ratio || [inner,outer].some(cell =>
      cell.backgroundMean !== background.mean || cell.backgroundSd !== background.sd ||
      cell.correctedMean !== cell.mean - background.mean || cell.ctcf !== cell.sum - cell.pixels * background.mean
    ) || inner.pixels + outer.pixels + background.pixels > width * height) throw new Error('配对记录中的校正结果不一致。');
    return {version:1,recordKey,metadata,rois,width,height,inner,outer,background,difference,ratio,warnings:[...entry.warnings]};
  });
}
