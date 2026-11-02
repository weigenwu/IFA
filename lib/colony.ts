import type { RGBAFrame } from './migration';

export interface ColonyCircle { cx: number; cy: number; r: number }
export interface ColonyParameters { stainThreshold: number; minArea: number; maxArea: number; excludeEdge: boolean }
export interface ColonyPoint { x: number; y: number; area: number }
export interface ColonyResult { points: ColonyPoint[]; stainedAreaPx: number; coveragePct: number; roiAreaPx: number; warnings: string[] }
export const DEFAULT_COLONY_PARAMETERS: ColonyParameters = { stainThreshold: 25, minArea: 20, maxArea: 10000, excludeEdge: true };

function validate(frame: RGBAFrame, roi: ColonyCircle, p: ColonyParameters) {
  const { width, height, data } = frame;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 0x7fffffff
    || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new Error('需要有效的 8-bit RGBA 图像。');
  if (![roi.cx, roi.cy, roi.r].every(Number.isFinite) || roi.r < 2 || roi.cx - roi.r < 0 || roi.cy - roi.r < 0
    || roi.cx + roi.r > width || roi.cy + roi.r > height) throw new Error('分析圆必须完整位于图像内，半径至少 2 px。');
  if (!Number.isFinite(p.stainThreshold) || p.stainThreshold <= 0 || p.stainThreshold > 255
    || !Number.isSafeInteger(p.minArea) || !Number.isSafeInteger(p.maxArea) || p.minArea < 1 || p.maxArea < p.minArea
    || typeof p.excludeEdge !== 'boolean') throw new Error('请检查染色阈值、最小/最大克隆面积及边缘排除设置。');
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) throw new Error('图像含透明像素，请导入不透明的原始照片。');
}

const purple = (green: number, blue: number) => blue > 0 ? Math.max(0, 255 * (blue - green) / blue) : 0;
function median(histogram: Uint32Array, count: number) {
  let sum = 0;
  for (let i = 0; i < histogram.length; i++) { sum += histogram[i]; if (sum >= Math.ceil(count / 2)) return i; }
  return 0;
}

/** One connected blue/purple object is one candidate colony; touching colonies are not split automatically. */
export function analyzeColony(frame: RGBAFrame, roi: ColonyCircle, parameters: ColonyParameters): ColonyResult {
  validate(frame, roi, parameters);
  const { width, height, data } = frame, length = width * height;
  const left = Math.max(0, Math.floor(roi.cx - roi.r)), right = Math.min(width - 1, Math.ceil(roi.cx + roi.r));
  const top = Math.max(0, Math.floor(roi.cy - roi.r)), bottom = Math.min(height - 1, Math.ceil(roi.cy + roi.r));
  const inside = (x: number, y: number) => (x + .5 - roi.cx) ** 2 + (y + .5 - roi.cy) ** 2 <= roi.r ** 2;
  const greens = new Uint32Array(256), chromas = new Uint32Array(256);
  // A fixed spatial sample estimates the background without changing the image.
  const step = Math.max(1, Math.ceil(Math.sqrt((right - left + 1) * (bottom - top + 1) / 50000)));
  let samples = 0;
  for (let y = top; y <= bottom; y += step) for (let x = left; x <= right; x += step) if (inside(x, y)) {
    const offset = (y * width + x) * 4, g = data[offset + 1], b = data[offset + 2];
    greens[g]++; chromas[Math.round(purple(g, b))]++; samples++;
  }
  const backgroundGreen = median(greens, samples), backgroundChroma = median(chromas, samples);
  const mask = new Uint8Array(length);
  let roiAreaPx = 0, stainedAreaPx = 0;
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) if (inside(x, y)) {
    roiAreaPx++;
    const at = y * width + x, offset = at * 4, r = data[offset], g = data[offset + 1], b = data[offset + 2];
    // Require both darker signal and a larger blue/purple fraction than the well background.
    const score = Math.min(backgroundGreen - g, purple(g, b) - backgroundChroma);
    if (b >= r - 15 && score >= parameters.stainThreshold) { mask[at] = 1; stainedAreaPx++; }
  }
  const queue = new Uint32Array(length), points: ColonyPoint[] = [];
  let small = 0, large = 0, edges = 0;
  for (let start = 0; start < length; start++) {
    if (!mask[start]) continue;
    let size = 1, sumX = 0, sumY = 0, edge = false;
    queue[0] = start; mask[start] = 0;
    for (let head = 0; head < size; head++) {
      const at = queue[head], x = at % width, y = Math.floor(at / width);
      sumX += x + .5; sumY += y + .5;
      // Detect actual contact with the circle perimeter, not a fixed-width discarded rim.
      if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) edge = true;
      for (let yy = Math.max(top, y - 1); yy <= Math.min(bottom, y + 1); yy++) for (let xx = Math.max(left, x - 1); xx <= Math.min(right, x + 1); xx++) {
        const next = yy * width + xx;
        if (mask[next]) { mask[next] = 0; queue[size++] = next; }
      }
    }
    if (size < parameters.minArea) { small++; continue; }
    if (size > parameters.maxArea) { large++; continue; }
    if (edge && parameters.excludeEdge) { edges++; continue; }
    points.push({ x: sumX / size, y: sumY / size, area: size });
  }
  const warnings = ['自动计数为染色连通区域估计；粘连克隆、碎片和孔壁需人工复核。', '覆盖率为圆内全部阈值染色像素，包含面积或触边筛选未计数的信号。'];
  if (large) warnings.push(`${large} 个区域超过最大面积，未计数；可能为孔壁或粘连大簇，请检查并手动补点。`);
  if (edges) warnings.push(`已排除 ${edges} 个触及分析圆边界的区域；请将圆放在孔底范围内。`);
  if (!points.length) warnings.push('未检出符合条件的克隆，请核对分析圆和阈值；空白图可为零。');
  if (stainedAreaPx / roiAreaPx > .35) warnings.push('染色覆盖较高，背景估计和粘连克隆计数可能不可靠，请人工复核。');
  if (small) warnings.push(`${small} 个小于最小面积的碎片未计数。`);
  return { points, stainedAreaPx, coveragePct: 100 * stainedAreaPx / roiAreaPx, roiAreaPx, warnings };
}
