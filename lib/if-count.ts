import type { NumericArray } from './analysis';
import { analyzeEdu } from './edu.ts';

export interface Point { x: number; y: number }
export interface Region { id: string; name: string; kind: 'tissue' | 'region'; points: Point[] }
export interface Parameters {
  nucleusThreshold: number; aThreshold: number; bThreshold: number;
  minArea: number; maxArea: number; median: boolean; excludeEdge: boolean;
  radius: number; minPositiveFraction: number;
}
export interface Cell {
  id: number; x: number; y: number; area: number;
  regionId: string | null; regionName: string;
  aMean: number; bMean: number; aFraction: number; bFraction: number; overlapFraction: number;
  aPositive: boolean; bPositive: boolean; doublePositive: boolean; excluded: boolean; manual: boolean;
}
export interface RegionSummary {
  id: string; name: string; areaPx: number; total: number;
  aPositive: number; bPositive: number; doublePositive: number;
  aPct: number | null; doubleOfAPct: number | null;
}
export interface Result { cells: Cell[]; regions: RegionSummary[]; warnings: string[] }

const EPSILON = 1e-8;
const ALL = { id: '__all__', name: '全图' };
const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const onSegment = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) <= EPSILON
  && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
  && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;

/** Coordinates describe image edges; pixel (x, y) has center (x + .5, y + .5). */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (onSegment(a, b, point)) return true;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function intersect(a: Point, b: Point, c: Point, d: Point) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > EPSILON && abD < -EPSILON) || (abC < -EPSILON && abD > EPSILON))
    && ((cdA > EPSILON && cdB < -EPSILON) || (cdA < -EPSILON && cdB > EPSILON))
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function validateRegions(regions: Region[], width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > 0x7fffffff) throw new Error('图像宽高必须是有效正整数。');
  const ids = new Set<string>();
  let tissues = 0;
  for (const region of regions) {
    if (!region.id?.trim() || ids.has(region.id) || region.id === ALL.id) throw new Error('区域编号不能为空或重复。');
    ids.add(region.id);
    if (!region.name?.trim()) throw new Error('请填写区域名称。');
    if (region.kind !== 'region' && region.kind !== 'tissue') throw new Error('区域类型无效。');
    if (region.kind === 'tissue' && ++tissues > 1) throw new Error('每张图只能设置一个组织外轮廓。');
    const points = region.points.filter((point, i) => !i || point.x !== region.points[i - 1].x || point.y !== region.points[i - 1].y);
    if (points.length > 1 && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y) points.pop();
    if (points.length < 3) throw new Error(`区域“${region.name}”至少需要 3 个不同顶点。`);
    let signedArea = 0;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || a.x < 0 || a.y < 0 || a.x > width || a.y > height) {
        throw new Error(`区域“${region.name}”的顶点必须位于图像内。`);
      }
      signedArea += a.x * b.y - b.x * a.y;
      for (let j = i + 2; j < points.length; j++) {
        if (i === 0 && j === points.length - 1) continue;
        if (intersect(a, b, points[j], points[(j + 1) % points.length])) throw new Error(`区域“${region.name}”边界交叉，请重新描边。`);
      }
    }
    if (Math.abs(signedArea) < EPSILON) throw new Error(`区域“${region.name}”面积为零。`);
  }
}

function regionIndex(point: Point, regions: Region[]): number {
  const tissue = regions.findIndex(region => region.kind === 'tissue');
  if (tissue >= 0 && !pointInPolygon(point, regions[tissue].points)) return -1;
  const inner = regions.findIndex(region => region.kind === 'region' && pointInPolygon(point, region.points));
  return inner >= 0 ? inner : tissue;
}

/** Scanline fill avoids a polygon edge test for every image pixel. */
function visitPolygonPixels(points: Point[], width: number, height: number, visit: (pixel: number) => void) {
  const minY = Math.max(0, Math.ceil(Math.min(...points.map(p => p.y)) - .5 - EPSILON));
  const maxY = Math.min(height - 1, Math.floor(Math.max(...points.map(p => p.y)) - .5 + EPSILON));
  const span = (left: number, right: number, y: number) => {
    const first = Math.max(0, Math.ceil(left - .5 - EPSILON));
    const last = Math.min(width - 1, Math.floor(right - .5 + EPSILON));
    for (let x = first; x <= last; x++) visit(y * width + x);
  };
  for (let y = minY; y <= maxY; y++) {
    const center = y + .5;
    const crossings: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[j], b = points[i];
      if ((a.y > center) !== (b.y > center)) crossings.push(a.x + (center - a.y) * (b.x - a.x) / (b.y - a.y));
      // Includes horizontal edges and local extrema lying exactly on a pixel row.
      if (Math.abs(a.y - center) < EPSILON) span(a.x, a.x, y);
      if (Math.abs(a.y - center) < EPSILON && Math.abs(b.y - center) < EPSILON) span(Math.min(a.x, b.x), Math.max(a.x, b.x), y);
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) span(crossings[i], crossings[i + 1], y);
  }
}

function summarize(cells: Cell[], regions: Region[], width: number, height: number) {
  const summaries: RegionSummary[] = (regions.length ? regions : [ALL]).map(region => ({
    id: region.id, name: region.name, areaPx: 0, total: 0, aPositive: 0, bPositive: 0,
    doublePositive: 0, aPct: null, doubleOfAPct: null,
  }));
  let overlaps = false;
  if (!regions.length) summaries[0].areaPx = width * height;
  else {
    const owner = new Int32Array(width * height).fill(-1);
    const tissue = regions.findIndex(region => region.kind === 'tissue');
    if (tissue >= 0) visitPolygonPixels(regions[tissue].points, width, height, pixel => { owner[pixel] = tissue; });
    regions.forEach((region, index) => {
      if (region.kind === 'tissue') return;
      visitPolygonPixels(region.points, width, height, pixel => {
        if (tissue >= 0 && owner[pixel] === -1) return;
        if (owner[pixel] === tissue || owner[pixel] === -1) owner[pixel] = index;
        else if (owner[pixel] !== index) overlaps = true;
      });
    });
    for (const index of owner) if (index >= 0) summaries[index].areaPx++;
  }
  for (const cell of cells) {
    if (cell.excluded) continue;
    const index = regions.length ? regionIndex(cell, regions) : 0;
    if (index < 0) continue;
    const summary = summaries[index];
    summary.total++;
    summary.aPositive += Number(cell.aPositive);
    summary.bPositive += Number(cell.bPositive);
    summary.doublePositive += Number(cell.aPositive && cell.bPositive);
  }
  for (const summary of summaries) {
    summary.aPct = summary.total ? 100 * summary.aPositive / summary.total : null;
    summary.doubleOfAPct = summary.aPositive ? 100 * summary.doublePositive / summary.aPositive : null;
  }
  return { summaries, overlaps };
}

/** Recomputes region assignment from centroids and honors manual classifications/exclusions. */
export function summarizeIf(cells: Cell[], regions: Region[], width: number, height: number): RegionSummary[] {
  validateRegions(regions, width, height);
  return summarize(cells, regions, width, height).summaries;
}

export function analyzeIf(nucleus: NumericArray, a: NumericArray, b: NumericArray, width: number, height: number,
  parameters: Parameters, regions: Region[]): Result {
  validateRegions(regions, width, height);
  if (!Number.isFinite(parameters.aThreshold) || !Number.isFinite(parameters.bThreshold)) throw new Error('标记强度阈值必须为有限数值。');
  if (!Number.isInteger(parameters.radius) || parameters.radius < 0 || parameters.radius > 30) throw new Error('核周范围必须为 0–30 的整数像素。');
  if (!Number.isFinite(parameters.minPositiveFraction) || parameters.minPositiveFraction <= 0 || parameters.minPositiveFraction > 1) {
    throw new Error('阳性像素比例必须大于 0 且不超过 1。');
  }
  if (b.length !== width * height) throw new Error('GFP 通道像素数与图像宽高不一致。');
  for (const value of b) if (!Number.isFinite(value)) throw new Error('GFP 通道包含非有限像素值。');
  const segmented = analyzeEdu(nucleus, a, width, height, {
    ...parameters, eduThreshold: parameters.aThreshold,
  });
  const { labels, nuclei } = segmented;
  const owner = labels.slice();
  if (parameters.radius) {
    const distance = new Float32Array(labels.length).fill(Infinity);
    const offsets: { dx: number; dy: number; distance: number }[] = [];
    for (let dy = -parameters.radius; dy <= parameters.radius; dy++) {
      for (let dx = -parameters.radius; dx <= parameters.radius; dx++) {
        const squared = dx * dx + dy * dy;
        if (squared && squared <= parameters.radius ** 2) offsets.push({ dx, dy, distance: squared });
      }
    }
    for (let pixel = 0; pixel < labels.length; pixel++) {
      const id = labels[pixel];
      if (!id) continue;
      const x = pixel % width, y = Math.floor(pixel / width);
      if (x > 0 && y > 0 && x < width - 1 && y < height - 1
        && labels[pixel - 1] === id && labels[pixel + 1] === id
        && labels[pixel - width] === id && labels[pixel + width] === id) continue;
      for (const offset of offsets) {
        const nx = x + offset.dx, ny = y + offset.dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const target = ny * width + nx;
        if (labels[target]) continue;
        if (offset.distance < distance[target] || (offset.distance === distance[target] && id < owner[target])) {
          distance[target] = offset.distance;
          owner[target] = id;
        }
      }
    }
  }
  const counts = new Uint32Array(nuclei.length + 1);
  for (const id of owner) if (id) counts[id]++;
  const measurements = nuclei.map(() => ({ aMean: 0, bMean: 0, aAbove: 0, bAbove: 0, both: 0 }));
  for (let pixel = 0; pixel < owner.length; pixel++) {
    const id = owner[pixel];
    if (!id) continue;
    const measurement = measurements[id - 1];
    measurement.aMean += a[pixel] / counts[id];
    measurement.bMean += b[pixel] / counts[id];
    const aAbove = a[pixel] > parameters.aThreshold, bAbove = b[pixel] > parameters.bThreshold;
    measurement.aAbove += Number(aAbove);
    measurement.bAbove += Number(bAbove);
    measurement.both += Number(aAbove && bAbove);
  }
  const cells: Cell[] = nuclei.map((n, index) => {
    const measured = measurements[index];
    const point = { x: n.x + .5, y: n.y + .5 };
    const region = regions.length ? regions[regionIndex(point, regions)] : ALL;
    const aFraction = measured.aAbove / counts[n.id], bFraction = measured.bAbove / counts[n.id];
    const aPositive = aFraction >= parameters.minPositiveFraction, bPositive = bFraction >= parameters.minPositiveFraction;
    return { id: n.id, ...point, area: n.area, regionId: region?.id ?? null, regionName: region?.name ?? '未分区',
      aMean: measured.aMean, bMean: measured.bMean, aFraction, bFraction, overlapFraction: measured.both / counts[n.id],
      aPositive, bPositive, doublePositive: aPositive && bPositive, excluded: false, manual: false };
  });
  const { summaries, overlaps } = summarize(cells, regions, width, height);
  const warnings = [...segmented.warnings,
    '双阳性指同一核关联范围内 AF647 与 GFP 均达阈值，不等同于严格像素共定位；核周范围不是实际细胞边界。'];
  if (overlaps) warnings.push('区域有重叠，按区域列表先后顺序归属，同一细胞和像素只计入一个区域。');
  if (cells.some(cell => cell.regionId === null)) warnings.push('未分区或组织外的细胞不计入区域汇总，逐细胞结果中保留。');
  return { cells, regions: summaries, warnings };
}
