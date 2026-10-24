export interface RGBAFrame { width: number; height: number; data: Uint8ClampedArray }
export interface ScratchParameters {
  textureThreshold: number; windowRadius: number; roiTopPct: number; roiBottomPct: number;
  centerXPct: number; minGapWidth: number; rowStep: number;
}
export interface ScratchBoundary { y: number; left: number; right: number }
export interface ScratchMeasurement {
  areaPx: number | null; meanWidthPx: number | null; roiAreaPx: number;
  gapPct: number | null; valid: boolean; qc: string[];
}
export interface ScratchResult extends ScratchMeasurement { boundaries: ScratchBoundary[] }
export interface TranswellParameters {
  stainThreshold: number; maxBrightness: number; minArea: number; peakDistance: number;
  minPeakRadius: number; clusterArea: number; excludeEdge: boolean;
}
export interface TranswellResult {
  mask: Uint8Array; points: Array<{ x: number; y: number }>;
  stainedAreaPx: number; coveragePct: number; clusterCount: number; qc: string[];
}
export const DEFAULT_SCRATCH_PARAMETERS: ScratchParameters = {
  textureThreshold: 8, windowRadius: 8, roiTopPct: 5, roiBottomPct: 95,
  centerXPct: 50, minGapWidth: 30, rowStep: 8,
};
export const SCRATCH_ALGORITHM_VERSION = 'texture-lateral-components-v2';
export const DEFAULT_TRANSWELL_PARAMETERS: TranswellParameters = {
  stainThreshold: 12, maxBrightness: 235, minArea: 80, peakDistance: 20,
  minPeakRadius: 4, clusterArea: 1200, excludeEdge: false,
};

function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 0x1fffffff) throw new Error('图像宽高必须为正整数，且像素数不能超过 536870911。');
}
function frameValid(frame: RGBAFrame) {
  dimensions(frame.width, frame.height);
  if (!(frame.data instanceof Uint8ClampedArray) || frame.data.length !== frame.width * frame.height * 4) throw new Error('需要与宽高一致的 8-bit RGBA 像素数组。');
  // Transparent padding has no measured brightness; require an opaque image.
  for (let i = 3; i < frame.data.length; i += 4) if (frame.data[i] !== 255) throw new Error('图像含透明像素，请先将有效视野导出为不透明 RGB 图像。');
}
function range(value: number, low: number, high: number, label: string, integer = false) {
  if (!Number.isFinite(value) || value < low || value > high || (integer && !Number.isInteger(value))) throw new Error(`${label}必须为 ${low}–${high} 范围内的${integer ? '整数' : '有限数值'}。`);
}
function emptyScratch(roiAreaPx: number, reason: string): ScratchResult {
  return { boundaries: [], areaPx: null, meanWidthPx: null, roiAreaPx, gapPct: null, valid: false, qc: [reason, '未把识别失败视为划痕完全闭合；请调整参数或手动描绘边界。'] };
}

/** Pixel-edge coordinates; trapezoidal area between edited traces, without physical-unit assumptions. */
export function measureScratch(boundaries: ScratchBoundary[], width: number, height: number): ScratchMeasurement {
  dimensions(width, height);
  if (!boundaries.length) return emptyScratch(width * height, '尚无可测量边界。');
  if (boundaries.length < 2) throw new Error('至少需要两行划痕边界。');
  let areaPx = 0;
  boundaries.forEach((boundary, i) => {
    range(boundary.y, 0, height, '边界 Y'); range(boundary.left, 0, width, '左边界'); range(boundary.right, 0, width, '右边界');
    if (boundary.left > boundary.right) throw new Error('左边界不能位于右边界右侧。');
    if (i) {
      const previous = boundaries[i - 1];
      if (boundary.y <= previous.y) throw new Error('边界行的 Y 坐标必须严格递增。');
      areaPx += (boundary.y - previous.y) * (boundary.right - boundary.left + previous.right - previous.left) / 2;
    }
  });
  const span = boundaries[boundaries.length - 1].y - boundaries[0].y;
  return { areaPx, meanWidthPx: areaPx / span, roiAreaPx: width * span, gapPct: areaPx / (width * span) * 100, valid: true, qc: [] };
}

/** Vertical gap between laterally connected cell sheets. No registration or time/group inference. */
export function analyzeScratch(frame: RGBAFrame, parameters: ScratchParameters): ScratchResult {
  frameValid(frame);
  const { width, height, data } = frame;
  range(parameters.textureThreshold, 0.1, 128, '纹理阈值'); range(parameters.windowRadius, 1, 100, '纹理窗口半径', true);
  range(parameters.roiTopPct, 0, 99.9, 'ROI 顶部百分比'); range(parameters.roiBottomPct, 0.1, 100, 'ROI 底部百分比');
  range(parameters.centerXPct, 1, 99, '划痕中心百分比'); range(parameters.minGapWidth, 1, width, '最小划痕宽度', true); range(parameters.rowStep, 1, height, '边界采样间隔', true);
  if (parameters.roiBottomPct <= parameters.roiTopPct) throw new Error('ROI 底部必须低于顶部。');
  const top = Math.floor(height * parameters.roiTopPct / 100), bottom = Math.ceil(height * parameters.roiBottomPct / 100);
  const roiArea = width * (bottom - top), stride = width + 1;
  const sum = new Float64Array(stride * (height + 1)), square = new Float64Array(sum.length);
  for (let y = 0; y < height; y++) {
    let row = 0, rowSquare = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      row += gray; rowSquare += gray * gray;
      const at = (y + 1) * stride + x + 1;
      sum[at] = sum[at - stride] + row; square[at] = square[at - stride] + rowSquare;
    }
  }
  const radius = parameters.windowRadius, center = width * parameters.centerXPct / 100;
  const texture = new Float64Array(width + 1), textured = new Uint8Array(width * height), support = new Uint8Array(textured.length);
  // Use the full 2D field before sampling rows: an island can be wider than the
  // texture window yet still be disconnected from both cell sheets.
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius), y1 = Math.min(height, y + radius + 1);
    texture[0] = 0;
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius), x1 = Math.min(width, x + radius + 1), n = (x1 - x0) * (y1 - y0);
      const a = y0 * stride + x0, b = y0 * stride + x1, c = y1 * stride + x0, d = y1 * stride + x1;
      const mean = (sum[d] - sum[b] - sum[c] + sum[a]) / n;
      const sd = Math.sqrt(Math.max(0, (square[d] - square[b] - square[c] + square[a]) / n - mean * mean));
      texture[x + 1] = texture[x] + sd;
    }
    for (let x = 0; x < width; x++) {
      const left = Math.max(0, x - radius), right = Math.min(width, x + radius + 1);
      const value = (texture[right] - texture[left]) / (right - left), at = y * width + x;
      textured[at] = Number(value > parameters.textureThreshold);
      // Weak texture connects true edge patches through lower-contrast cells.
      // It supports topology only: the reported edge still uses the user's
      // full threshold, so weak background alone cannot become a cell front.
      support[at] = Number(value > parameters.textureThreshold * 0.5);
    }
  }
  // A monolayer must have substantial vertical support in a lateral strip.
  // Top/bottom contact alone does not make a central debris island a front.
  // A component can touch both sides if a local cell bridge closes the gap;
  // retain it, but such rows still require a measurable gap below.
  const sheets = new Uint8Array(textured.length), sideWidth = Math.max(1, Math.ceil(width * 0.05));
  const minSpan = Math.max(2, Math.ceil((bottom - top) * 0.25));
  const minSheetArea = Math.max(2, Math.ceil(width * height * 0.002));
  let ignoredIslands = 0;
  components(support, width, height, (pixels, size) => {
    let leftMin = height, leftMax = -1, rightMin = height, rightMax = -1;
    for (let i = 0; i < size; i++) {
      const at = pixels[i], x = at % width, y = Math.floor(at / width);
      if (!textured[at]) continue;
      if (x < sideWidth) { leftMin = Math.min(leftMin, y); leftMax = Math.max(leftMax, y); }
      if (x >= width - sideWidth) { rightMin = Math.min(rightMin, y); rightMax = Math.max(rightMax, y); }
    }
    const sides = size < minSheetArea ? 0 : Number(leftMax - leftMin + 1 >= minSpan) | (Number(rightMax - rightMin + 1 >= minSpan) << 1);
    if (!sides) { ignoredIslands++; return; }
    for (let i = 0; i < size; i++) if (textured[pixels[i]]) sheets[pixels[i]] = sides;
  });
  const rows: Array<ScratchBoundary | null> = [], ys: number[] = [];
  for (let y = top; ; y = Math.min(bottom, y + parameters.rowStep)) {
    ys.push(y);
    const offset = Math.min(height - 1, y) * width;
    let candidate: ScratchBoundary | null = null, bestDistance = Infinity;
    for (let x = 0; x < width;) {
      if (sheets[offset + x]) { x++; continue; }
      const left = x; while (x < width && !sheets[offset + x]) x++;
      const right = x, distance = center < left ? left - center : center > right ? center - right : 0;
      if (left === 0 || right === width || right - left < parameters.minGapWidth || distance > width * 0.25) continue;
      if (!(sheets[offset + left - 1] & 1) || !(sheets[offset + right] & 2)) continue;
      if (distance < bestDistance || (distance === bestDistance && right - left > (candidate ? candidate.right - candidate.left : 0))) { candidate = { y, left, right }; bestDistance = distance; }
    }
    rows.push(candidate);
    if (y === bottom) break;
  }
  const missing = rows.filter(row => row === null).length;
  if (missing > rows.length * 0.2) return emptyScratch(roiArea, `${missing}/${rows.length} 个采样行未找到有双侧细胞纹理支持的间隙；图像可能低对比、完全闭合或方向不适合。`);
  const accepted = rows.flatMap((row, i) => row ? [i] : []);
  if (!accepted.length) return emptyScratch(roiArea, '未检出可靠划痕间隙。');
  const filled = rows.map((row, i): ScratchBoundary => {
    if (row) return row;
    const before = [...accepted].reverse().find(index => index < i) ?? accepted[0];
    const after = accepted.find(index => index > i) ?? accepted[accepted.length - 1];
    const a = rows[before]!, b = rows[after]!, fraction = before === after ? 0 : (ys[i] - a.y) / (b.y - a.y);
    return { y: ys[i], left: a.left + fraction * (b.left - a.left), right: a.right + fraction * (b.right - a.right) };
  });
  const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const boundaries = filled.map((row, i) => {
    const neighbors = filled.slice(Math.max(0, i - 1), Math.min(filled.length, i + 2));
    return { y: row.y, left: median(neighbors.map(p => p.left)), right: median(neighbors.map(p => p.right)) };
  });
  const measurement = measureScratch(boundaries, width, height);
  const qc = ['自动边界来自与左右侧细胞层相连的二维纹理区域；已排除独立纹理岛，仍需检查弱纹理、贴近前缘的碎屑与真实细胞桥。', '仅测量像素面积和宽度；未推断分组、时间对应或物理标定。'];
  if (ignoredIslands) qc.push(`已忽略 ${ignoredIslands} 个无足够侧边连接支持的纹理区域；该数量不是游离细胞计数。`);
  if (missing) qc.push(`${missing} 个缺失采样行已按相邻边界插值，需重点复核。`);
  return { ...measurement, boundaries, qc };
}

function components(mask: Uint8Array, width: number, height: number, visit: (queue: Uint32Array, size: number) => void) {
  const queue = new Uint32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    let size = 1; queue[0] = start; mask[start] = 0;
    for (let head = 0; head < size; head++) {
      const at = queue[head], x = at % width, y = Math.floor(at / width);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
        const next = yy * width + xx; if (mask[next]) { mask[next] = 0; queue[size++] = next; }
      }
    }
    visit(queue, size);
  }
}

/** Blue/purple chromatic seeds with connected dark cores; gray pore rings lack seed support. */
export function analyzeTranswell(frame: RGBAFrame, parameters: TranswellParameters): TranswellResult {
  frameValid(frame);
  const { width, height, data } = frame, length = width * height;
  range(parameters.stainThreshold, 1, 255, '染色颜色差阈值'); range(parameters.maxBrightness, 1, 255, '最高亮度');
  range(parameters.minArea, 1, length, '最小面积', true); range(parameters.peakDistance, 1, Math.max(width, height), '候选中心最小间距');
  range(parameters.minPeakRadius, 1, Math.max(width, height), '候选中心最小半径'); range(parameters.clusterArea, parameters.minArea, length, '大簇面积', true);
  if (typeof parameters.excludeEdge !== 'boolean') throw new Error('排除边缘必须为布尔值。');
  const candidates = new Uint8Array(length), seeds = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], brightness = (r + g + b) / 3;
    const bluePurple = Math.max(Math.min(b - r, b - g), Math.min(r - g, b - g) * 0.8);
    seeds[i] = Number(bluePurple >= parameters.stainThreshold && brightness <= parameters.maxBrightness);
    candidates[i] = Number(seeds[i] || brightness <= Math.min(100, parameters.maxBrightness));
  }
  const mask = new Uint8Array(length), labels = new Int32Array(length);
  const regions: Array<{ area: number; max: number; peak: number; candidates: number[] }> = [];
  let stainedAreaPx = 0, excluded = 0;
  components(candidates, width, height, (pixels, size) => {
    if (size < parameters.minArea) return;
    let seedCount = 0, edge = false;
    for (let j = 0; j < size; j++) {
      const i = pixels[j], x = i % width, y = Math.floor(i / width);
      seedCount += seeds[i]; if (!x || !y || x === width - 1 || y === height - 1) edge = true;
    }
    if (seedCount < Math.max(3, Math.ceil(size * 0.05))) return;
    if (edge && parameters.excludeEdge) { excluded++; return; }
    const id = regions.length + 1;
    regions.push({ area: size, max: 0, peak: pixels[0], candidates: [] }); stainedAreaPx += size;
    for (let j = 0; j < size; j++) { mask[pixels[j]] = 1; labels[pixels[j]] = id; }
  });
  const distance = new Float32Array(length), diagonal = Math.SQRT2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x; if (!mask[i]) continue;
    distance[i] = Math.min(x ? distance[i - 1] + 1 : 1, y ? distance[i - width] + 1 : 1,
      x && y ? distance[i - width - 1] + diagonal : 1, y && x < width - 1 ? distance[i - width + 1] + diagonal : 1);
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const i = y * width + x; if (!mask[i]) continue;
    distance[i] = Math.min(distance[i], x < width - 1 ? distance[i + 1] + 1 : 1, y < height - 1 ? distance[i + width] + 1 : 1,
      x < width - 1 && y < height - 1 ? distance[i + width + 1] + diagonal : 1, x && y < height - 1 ? distance[i + width - 1] + diagonal : 1);
    const region = regions[labels[i] - 1];
    if (distance[i] > region.max) { region.max = distance[i]; region.peak = i; }
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x; if (!mask[i] || distance[i] < parameters.minPeakRadius) continue;
    const region = regions[labels[i] - 1]; if (region.area < parameters.clusterArea) continue;
    let maximum = true;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1) && maximum; yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
      if (distance[yy * width + xx] > distance[i]) { maximum = false; break; }
    }
    if (maximum) region.candidates.push(i);
  }
  const points: TranswellResult['points'] = [];
  let clusterCount = 0, thinRegions = 0;
  for (const region of regions) {
    if (region.area >= parameters.clusterArea) clusterCount++;
    if (region.max < parameters.minPeakRadius) { thinRegions++; continue; }
    if (region.area < parameters.clusterArea) { points.push({ x: region.peak % width, y: Math.floor(region.peak / width) }); continue; }
    region.candidates.sort((a, b) => distance[b] - distance[a] || a - b);
    const grid = new Map<string, Array<{ x: number; y: number }>>(), spacing = parameters.peakDistance;
    for (const i of region.candidates) {
      const x = i % width, y = Math.floor(i / width), gx = Math.floor(x / spacing), gy = Math.floor(y / spacing);
      let nearby = false;
      for (let yy = gy - 1; yy <= gy + 1 && !nearby; yy++) for (let xx = gx - 1; xx <= gx + 1; xx++) {
        if (grid.get(`${xx},${yy}`)?.some(p => (p.x - x) ** 2 + (p.y - y) ** 2 < spacing ** 2)) { nearby = true; break; }
      }
      if (nearby) continue;
      const point = { x, y }, key = `${gx},${gy}`;
      points.push(point); grid.set(key, [...(grid.get(key) ?? []), point]);
    }
  }
  const qc = ['自动中心为穿膜细胞计数候选；染色碎片、孔环和粘连簇仍需人工增删复核。', '染色面积包含与蓝紫色信号相连的暗部；面积覆盖率与细胞数是不同指标。'];
  if (!stainedAreaPx) qc.push('未检出符合颜色及面积条件的染色区域，请核对原图与参数。');
  if (clusterCount) qc.push(`${clusterCount} 个大面积染色簇采用距离峰估计中心，密集簇可能低估或过分拆分。`);
  if (thinRegions) qc.push(`${thinRegions} 个区域过薄，未形成达到最小半径的候选中心；保留在染色面积中。`);
  if (excluded) qc.push(`已排除 ${excluded} 个触边区域。`);
  return { mask, points, stainedAreaPx, coveragePct: stainedAreaPx / length * 100, clusterCount, qc };
}
