import type { NumericArray } from './analysis';

export interface EduParameters {
  nucleusThreshold: number;
  eduThreshold: number;
  minArea: number;
  maxArea: number;
  median: boolean;
  excludeEdge: boolean;
  minPositiveFraction: number;
}

export interface EduNucleus {
  id: number;
  area: number;
  x: number;
  y: number;
  eduMean: number;
  eduPositiveFraction: number;
  positive: boolean;
  touchesEdge: boolean;
}

export interface EduResult {
  labels: Int32Array;
  nuclei: EduNucleus[];
  total: number;
  positive: number;
  positivePct: number | null;
  warnings: string[];
}

function validateImage(data: NumericArray, width: number, height: number) {
  const length = width * height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || length > 0x7fffffff) {
    throw new Error('图像宽高必须是正整数，像素总数不能超过 2147483647。');
  }
  if (data.length !== length) throw new Error('通道像素数与图像宽高不一致。');
  for (let i = 0; i < length; i++) {
    if (!Number.isFinite(data[i])) throw new Error(`通道包含非有限像素值（位置 ${i}）。`);
  }
}

function validateThreshold(value: number) {
  if (!Number.isFinite(value)) throw new Error('强度阈值必须为有限数值。');
}

function validateArea(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('面积阈值必须为正整数像素数。');
}

/** Destructively consumes a binary mask; the queue is reused across components. */
function components(mask: Uint8Array, width: number, height: number, visit: (pixels: Uint32Array, size: number) => void) {
  const queue = new Uint32Array(mask.length);
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed]) continue;
    let size = 1;
    queue[0] = seed;
    mask[seed] = 0;
    for (let head = 0; head < size; head++) {
      const pixel = queue[head];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const neighbor = ny * width + nx;
          if (!mask[neighbor]) continue;
          mask[neighbor] = 0;
          queue[size++] = neighbor;
        }
      }
    }
    visit(queue, size);
  }
}

function nucleusMask(data: NumericArray, width: number, height: number, threshold: number, median: boolean) {
  const mask = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) mask[i] = Number(data[i] > threshold);
  if (!median) return mask;
  const filtered = new Uint8Array(mask.length);
  // Threshold(median(3×3)) equals a majority vote of the thresholded pixels.
  // Clamp edge coordinates so every window has nine samples.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let above = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = Math.max(0, Math.min(height - 1, y + dy)) * width;
        for (let dx = -1; dx <= 1; dx++) above += mask[row + Math.max(0, Math.min(width - 1, x + dx))];
      }
      filtered[y * width + x] = Number(above >= 5);
    }
  }
  return filtered;
}

/**
 * Full-resolution, 8-connected nuclear segmentation in native intensity units.
 * EdU values always come from the original channel, never the display cleanup.
 * Labels use sequential positive IDs; background and excluded objects are zero.
 */
export function analyzeEdu(nucleus: NumericArray, edu: NumericArray, width: number, height: number, parameters: EduParameters): EduResult {
  validateImage(nucleus, width, height);
  validateImage(edu, width, height);
  validateThreshold(parameters.nucleusThreshold);
  validateThreshold(parameters.eduThreshold);
  validateArea(parameters.minArea);
  validateArea(parameters.maxArea);
  if (parameters.maxArea < parameters.minArea) throw new Error('最大核面积不能小于最小核面积。');
  if (!Number.isFinite(parameters.minPositiveFraction) || parameters.minPositiveFraction < 0 || parameters.minPositiveFraction > 1) {
    throw new Error('核内 EdU 阳性像素比例阈值必须在 0 到 1 之间。');
  }
  if (typeof parameters.median !== 'boolean' || typeof parameters.excludeEdge !== 'boolean') throw new Error('中值滤波及排除边缘设置必须为布尔值。');

  const mask = nucleusMask(nucleus, width, height, parameters.nucleusThreshold, parameters.median);
  const labels = new Int32Array(mask.length);
  const nuclei: EduNucleus[] = [];
  let excludedArea = 0;
  let excludedEdge = 0;
  components(mask, width, height, (pixels, size) => {
    if (size < parameters.minArea || size > parameters.maxArea) { excludedArea++; return; }
    let sumX = 0;
    let sumY = 0;
    let eduMean = 0;
    let above = 0;
    let touchesEdge = false;
    for (let j = 0; j < size; j++) {
      const pixel = pixels[j];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      sumX += x;
      sumY += y;
      // Sum divided terms to avoid overflow for otherwise finite source values.
      eduMean += edu[pixel] / size;
      if (edu[pixel] > parameters.eduThreshold) above++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;
    }
    if (parameters.excludeEdge && touchesEdge) { excludedEdge++; return; }
    const id = nuclei.length + 1;
    const eduPositiveFraction = above / size;
    nuclei.push({ id, area: size, x: sumX / size, y: sumY / size, eduMean, eduPositiveFraction,
      positive: eduPositiveFraction >= parameters.minPositiveFraction, touchesEdge });
    for (let j = 0; j < size; j++) labels[pixels[j]] = id;
  });
  const positive = nuclei.filter(n => n.positive).length;
  // ponytail: connected nuclei remain one object; add validated watershed only
  // when representative annotated images justify a particular splitting rule.
  const warnings = ['阈值连通域计数未自动拆分粘连细胞核；粘连核、碎片和非细胞标注需检查。'];
  if (excludedArea) warnings.push(`已按面积排除 ${excludedArea} 个连通域（包含小亮点或过大对象）。`);
  if (excludedEdge) warnings.push(`已排除 ${excludedEdge} 个接触图像边缘的对象。`);
  if (!nuclei.length) warnings.push('未检出符合条件的细胞核；阳性率记为 NA，请检查通道、阈值和面积。');
  if (parameters.minPositiveFraction === 0) warnings.push('阳性比例阈值为 0，所有保留的细胞核都会被判为阳性。');
  return { labels, nuclei, total: nuclei.length, positive, positivePct: nuclei.length ? positive / nuclei.length * 100 : null, warnings };
}

/** Preview-only cleanup: zero low values and tiny islands, preserving surviving intensities. */
export function cleanupDisplay(input: NumericArray, width: number, height: number, floor: number, minArea: number): Float64Array {
  validateImage(input, width, height);
  validateThreshold(floor);
  validateArea(minArea);
  const output = new Float64Array(input.length);
  const mask = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) mask[i] = Number(input[i] > floor);
  components(mask, width, height, (pixels, size) => {
    if (size < minArea) return;
    for (let i = 0; i < size; i++) output[pixels[i]] = input[pixels[i]];
  });
  return output;
}

export interface EduDisplayOptions {
  floor: number;
  minArea: number;
  nucleusThreshold: number;
  nucleusMinArea: number;
  protectNuclear: boolean;
  onlyNuclear: boolean;
}

/**
 * Preview-only EdU cleanup with nuclear overlap as optional evidence to keep a
 * small red component. Retained components keep their entire original shape;
 * this is not a nuclear clipping mask or an EdU positivity classification.
 */
export function cleanupEduDisplay(edu: NumericArray, nucleus: NumericArray, width: number, height: number, options: EduDisplayOptions): Float64Array {
  validateImage(edu, width, height);
  validateImage(nucleus, width, height);
  validateThreshold(options.floor);
  validateThreshold(options.nucleusThreshold);
  validateArea(options.minArea);
  validateArea(options.nucleusMinArea);
  if (typeof options.protectNuclear !== 'boolean' || typeof options.onlyNuclear !== 'boolean') throw new Error('核内保护及仅保留核关联设置必须为布尔值。');

  const support = new Uint8Array(edu.length);
  if (options.protectNuclear || options.onlyNuclear) {
    const mask = nucleusMask(nucleus, width, height, options.nucleusThreshold, false);
    components(mask, width, height, (pixels, size) => {
      if (size < options.nucleusMinArea) return;
      for (let i = 0; i < size; i++) support[pixels[i]] = 1;
    });
  }
  const output = new Float64Array(edu.length);
  const mask = new Uint8Array(edu.length);
  for (let i = 0; i < edu.length; i++) mask[i] = Number(edu[i] > options.floor);
  components(mask, width, height, (pixels, size) => {
    let overlaps = false;
    for (let i = 0; i < size; i++) {
      if (support[pixels[i]]) { overlaps = true; break; }
    }
    if (options.onlyNuclear && !overlaps) return;
    if (size < options.minArea && !(options.protectNuclear && overlaps)) return;
    for (let i = 0; i < size; i++) output[pixels[i]] = edu[pixels[i]];
  });
  return output;
}
