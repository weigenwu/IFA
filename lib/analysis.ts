export type NumericArray =
  | Uint8Array | Uint16Array | Uint32Array
  | Int8Array | Int16Array | Int32Array
  | Float32Array | Float64Array;

export interface ChannelData {
  id: string;
  label: string;
  sourceColor?: string | null;
  data: NumericArray;
  maxValue: number;
  bitDepth: number;
  integer: boolean;
}

export interface Rect { x: number; y: number; width: number; height: number }
export interface Line { x1: number; y1: number; x2: number; y2: number }
export type DisplayPreset = 'raw' | 'auto' | 'imagej';

export interface IntensityStats {
  pixels: number;
  mean: number;
  median: number;
  sd: number;
  min: number;
  max: number;
  sum: number;
  backgroundMean: number;
  backgroundSd: number;
  correctedMean: number;
  ctcf: number;
  saturationPct: number;
}

export interface ColocResult {
  pearson: number;
  pearsonBelow: number;
  pearsonAbove: number;
  m1: number;
  m2: number;
  tm1: number;
  tm2: number;
  overlap: number;
  icq: number;
  thresholdA: number;
  thresholdB: number;
  thresholdMethod: string;
  regressionSlope: number;
  regressionIntercept: number;
  colocPixels: number;
  colocAreaPct: number;
  zeroZeroPct: number;
  sampleSize: number;
  warnings: string[];
}

export interface LineProfile {
  distance: number[];
  validCount: number[];
  rawA: number[];
  rawB: number[];
  correctedA: number[];
  correctedB: number[];
  smoothA: number[];
  smoothB: number[];
  sdA: number[];
  sdB: number[];
}

interface Bounds { x0: number; y0: number; x1: number; y1: number; pixels: number }
interface Moments { n: number; a: number; b: number; aa: number; bb: number; ab: number }

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

export function fitSquareRoi(width: number, height: number, x: number, y: number, side: number): Rect {
  const fittedSide = clamp(Math.round(side), 1, Math.max(1, Math.min(width, height)));
  return {
    x: clamp(Math.round(x), 0, Math.max(0, width - fittedSide)),
    y: clamp(Math.round(y), 0, Math.max(0, height - fittedSide)),
    width: fittedSide,
    height: fittedSide,
  };
}

export function boundsFor(width: number, height: number, roi?: Rect | null): Bounds {
  if (!roi) return { x0: 0, y0: 0, x1: width, y1: height, pixels: width * height };
  const x0 = clamp(Math.floor(Math.min(roi.x, roi.x + roi.width)), 0, width);
  const y0 = clamp(Math.floor(Math.min(roi.y, roi.y + roi.height)), 0, height);
  const x1 = clamp(Math.ceil(Math.max(roi.x, roi.x + roi.width)), 0, width);
  const y1 = clamp(Math.ceil(Math.max(roi.y, roi.y + roi.height)), 0, height);
  return { x0, y0, x1, y1, pixels: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) };
}

export function meanInRoi(channel: ChannelData, width: number, height: number, roi?: Rect | null): number {
  const b = boundsFor(width, height, roi);
  if (!b.pixels) return Number.NaN;
  let sum = 0;
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * width;
    for (let x = b.x0; x < b.x1; x++) sum += Number(channel.data[row + x]);
  }
  return sum / b.pixels;
}

export function percentileInRoi(channel: ChannelData, width: number, height: number, roi: Rect | null | undefined, percentile: number): number {
  const b = boundsFor(width, height, roi);
  if (!b.pixels) return Number.NaN;
  const exactIntegerBins = channel.integer && channel.maxValue <= 65535;
  const bins = exactIntegerBins ? Math.max(2, Math.floor(channel.maxValue) + 1) : 4096;
  const hist = new Uint32Array(bins);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  if (!exactIntegerBins) {
    for (let y = b.y0; y < b.y1; y++) {
      const row = y * width;
      for (let x = b.x0; x < b.x1; x++) {
        const value = Number(channel.data[row + x]);
        if (value < min) min = value;
        if (value > max) max = value;
      }
    }
  } else { min = 0; max = channel.maxValue; }
  if (!Number.isFinite(min) || max <= min) return min;
  const scale = (bins - 1) / (max - min);
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * width;
    for (let x = b.x0; x < b.x1; x++) {
      const value = Number(channel.data[row + x]);
      hist[clamp(Math.round((value - min) * scale), 0, bins - 1)]++;
    }
  }
  const target = clamp(percentile, 0, 1) * Math.max(0, b.pixels - 1);
  let seen = 0;
  for (let i = 0; i < bins; i++) {
    seen += hist[i];
    if (seen > target) return min + i / scale;
  }
  return max;
}

export function displayWindow(channel: ChannelData, width: number, height: number, preset: DisplayPreset) {
  const observedMin = percentileInRoi(channel, width, height, null, 0);
  const observedMax = percentileInRoi(channel, width, height, null, 1);
  if (preset === 'raw') {
    return { min: channel.integer ? 0 : observedMin, max: channel.integer ? channel.maxValue : observedMax };
  }
  // ImageJ Enhance Contrast commonly uses 0.35% total saturation; "auto" is a stronger 1% preview stretch.
  const tail = preset === 'imagej' ? 0.00175 : 0.005;
  const min = percentileInRoi(channel, width, height, null, tail);
  const max = percentileInRoi(channel, width, height, null, 1 - tail);
  return max > min ? { min, max } : { min: observedMin, max: observedMax > observedMin ? observedMax : observedMin + 1 };
}

export function intensityStats(channel: ChannelData, width: number, height: number, roi: Rect | null | undefined, backgroundMean = 0, backgroundSd = 0): IntensityStats {
  const b = boundsFor(width, height, roi);
  if (!b.pixels) return { pixels: 0, mean: Number.NaN, median: Number.NaN, sd: Number.NaN, min: Number.NaN, max: Number.NaN, sum: 0, backgroundMean, backgroundSd, correctedMean: Number.NaN, ctcf: Number.NaN, saturationPct: Number.NaN };
  let sum = 0, sumSq = 0, min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY, saturated = 0;
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * width;
    for (let x = b.x0; x < b.x1; x++) {
      const value = Number(channel.data[row + x]);
      sum += value;
      sumSq += value * value;
      if (value < min) min = value;
      if (value > max) max = value;
      if (channel.integer && value >= channel.maxValue) saturated++;
    }
  }
  const mean = sum / b.pixels;
  const variance = b.pixels > 1 ? Math.max(0, (sumSq - sum * sum / b.pixels) / (b.pixels - 1)) : 0;
  return {
    pixels: b.pixels,
    mean,
    median: percentileInRoi(channel, width, height, roi, 0.5),
    sd: Math.sqrt(variance),
    min,
    max,
    sum,
    backgroundMean,
    backgroundSd,
    correctedMean: mean - backgroundMean,
    ctcf: sum - b.pixels * backgroundMean,
    saturationPct: channel.integer ? saturated / b.pixels * 100 : Number.NaN,
  };
}

export function otsuThreshold(channel: ChannelData, width: number, height: number, roi?: Rect | null, background = 0): number {
  const b = boundsFor(width, height, roi);
  if (!b.pixels) return Number.NaN;
  const bins = 256;
  const hist = new Uint32Array(bins);
  const max = Math.max(1, channel.maxValue - background);
  for (let y = b.y0; y < b.y1; y++) {
    const row = y * width;
    for (let x = b.x0; x < b.x1; x++) {
      const value = Math.max(0, Number(channel.data[row + x]) - background);
      hist[clamp(Math.round(value / max * (bins - 1)), 0, bins - 1)]++;
    }
  }
  let totalMean = 0;
  for (let i = 0; i < bins; i++) totalMean += i * hist[i];
  let backgroundWeight = 0, backgroundMean = 0, bestVariance = -1, best = 0;
  for (let i = 0; i < bins; i++) {
    backgroundWeight += hist[i];
    if (!backgroundWeight) continue;
    const foregroundWeight = b.pixels - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundMean += i * hist[i];
    const mean0 = backgroundMean / backgroundWeight;
    const mean1 = (totalMean - backgroundMean) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (mean0 - mean1) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = i; }
  }
  return best / (bins - 1) * max;
}

function addMoment(m: Moments, a: number, b: number) {
  m.n++; m.a += a; m.b += b; m.aa += a * a; m.bb += b * b; m.ab += a * b;
}

function pearsonFrom(m: Moments): number {
  if (m.n < 2) return Number.NaN;
  const numerator = m.ab - m.a * m.b / m.n;
  const denominator = Math.sqrt(Math.max(0, m.aa - m.a * m.a / m.n) * Math.max(0, m.bb - m.b * m.b / m.n));
  return denominator > 0 ? clamp(numerator / denominator, -1, 1) : Number.NaN;
}

function sampledPairs(a: ChannelData, b: ChannelData, width: number, height: number, roi: Rect | null | undefined, backgroundA: number, backgroundB: number, limit = 250000) {
  const bounds = boundsFor(width, height, roi);
  const step = Math.max(1, Math.ceil(bounds.pixels / limit));
  const outA: number[] = [], outB: number[] = [];
  let seen = 0;
  for (let y = bounds.y0; y < bounds.y1; y++) {
    const row = y * width;
    for (let x = bounds.x0; x < bounds.x1; x++, seen++) {
      if (seen % step) continue;
      outA.push(Number(a.data[row + x]) - backgroundA);
      outB.push(Number(b.data[row + x]) - backgroundB);
    }
  }
  return { a: outA, b: outB };
}

function pearsonArrays(a: number[], b: number[], predicate?: (a: number, b: number) => boolean): number {
  const m: Moments = { n: 0, a: 0, b: 0, aa: 0, bb: 0, ab: 0 };
  for (let i = 0; i < a.length; i++) if (!predicate || predicate(a[i], b[i])) addMoment(m, a[i], b[i]);
  return pearsonFrom(m);
}

export function costesThreshold(a: ChannelData, b: ChannelData, width: number, height: number, roi?: Rect | null, backgroundA = 0, backgroundB = 0) {
  const pairs = sampledPairs(a, b, width, height, roi, backgroundA, backgroundB);
  const n = pairs.a.length;
  if (n < 2) return { a: Number.NaN, b: Number.NaN, slope: Number.NaN, intercept: Number.NaN, sampleSize: n };
  let meanA = 0, meanB = 0;
  for (let i = 0; i < n; i++) { meanA += pairs.a[i]; meanB += pairs.b[i]; }
  meanA /= n; meanB /= n;
  let varA = 0, varB = 0, covariance = 0;
  let minA = Number.POSITIVE_INFINITY, maxA = Number.NEGATIVE_INFINITY, minB = Number.POSITIVE_INFINITY, maxB = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const da = pairs.a[i] - meanA, db = pairs.b[i] - meanB;
    varA += da * da; varB += db * db; covariance += da * db;
    minA = Math.min(minA, pairs.a[i]); maxA = Math.max(maxA, pairs.a[i]);
    minB = Math.min(minB, pairs.b[i]); maxB = Math.max(maxB, pairs.b[i]);
  }
  varA /= n; varB /= n; covariance /= n;
  if (varA === 0 || varB === 0 || covariance === 0) return { a: Number.NaN, b: Number.NaN, slope: Number.NaN, intercept: Number.NaN, sampleSize: n };
  const slope = (varB - varA + Math.sqrt((varB - varA) ** 2 + 4 * covariance ** 2)) / (2 * covariance);
  const intercept = meanB - slope * meanA;
  if (!Number.isFinite(slope) || slope <= 0) return { a: Number.NaN, b: Number.NaN, slope, intercept, sampleSize: n };

  const stepA = Math.abs(slope) < 1;
  const lower = stepA ? minA : minB;
  let candidate = (lower + (stepA ? maxA : maxB)) / 2;
  let delta = ((stepA ? maxA : maxB) - lower) / 2;
  const span = Math.max(1e-12, delta * 2);
  const map = (value: number) => stepA
    ? { a: clamp(value, minA, maxA), b: clamp(slope * value + intercept, minB, maxB) }
    : { a: clamp((value - intercept) / slope, minA, maxA), b: clamp(value, minB, maxB) };
  for (let i = 0; i < 100 && delta > span * 1e-4; i++) {
    const thresholds = map(candidate);
    const r = pearsonArrays(pairs.a, pairs.b, (x, y) => x < thresholds.a || y < thresholds.b);
    delta *= 0.5;
    candidate += !Number.isFinite(r) || r < 0 ? delta : -delta;
  }
  return { ...map(candidate), slope, intercept, sampleSize: n };
}

export function calculateColocalization(
  a: ChannelData,
  b: ChannelData,
  width: number,
  height: number,
  roi: Rect | null | undefined,
  thresholdMethod: 'costes' | 'otsu' | 'manual' | 'none',
  manualA: number,
  manualB: number,
  backgroundA = 0,
  backgroundB = 0,
): ColocResult {
  let thresholdA = 0, thresholdB = 0, regressionSlope = Number.NaN, regressionIntercept = Number.NaN, sampleSize = 0;
  if (thresholdMethod === 'costes') {
    const result = costesThreshold(a, b, width, height, roi, backgroundA, backgroundB);
    thresholdA = result.a; thresholdB = result.b; regressionSlope = result.slope; regressionIntercept = result.intercept; sampleSize = result.sampleSize;
  } else if (thresholdMethod === 'otsu') {
    thresholdA = otsuThreshold(a, width, height, roi, backgroundA);
    thresholdB = otsuThreshold(b, width, height, roi, backgroundB);
  } else if (thresholdMethod === 'manual') {
    thresholdA = clamp(manualA, 0, 100) / 100 * Math.max(0, a.maxValue - backgroundA);
    thresholdB = clamp(manualB, 0, 100) / 100 * Math.max(0, b.maxValue - backgroundB);
  }
  const bounds = boundsFor(width, height, roi);
  const all: Moments = { n: 0, a: 0, b: 0, aa: 0, bb: 0, ab: 0 };
  const below: Moments = { n: 0, a: 0, b: 0, aa: 0, bb: 0, ab: 0 };
  const above: Moments = { n: 0, a: 0, b: 0, aa: 0, bb: 0, ab: 0 };
  let sumA = 0, sumB = 0, sumAWithB = 0, sumBWithA = 0, sumAPresentB = 0, sumBPresentA = 0;
  let sumAA = 0, sumBB = 0, sumAB = 0, colocPixels = 0, zeroZero = 0, positiveProducts = 0, nonzeroProducts = 0, saturatedA = 0, saturatedB = 0;
  let meanA = 0, meanB = 0;
  if (bounds.pixels) {
    for (let y = bounds.y0; y < bounds.y1; y++) {
      const row = y * width;
      for (let x = bounds.x0; x < bounds.x1; x++) {
        meanA += Number(a.data[row + x]) - backgroundA;
        meanB += Number(b.data[row + x]) - backgroundB;
      }
    }
    meanA /= bounds.pixels; meanB /= bounds.pixels;
  }
  for (let y = bounds.y0; y < bounds.y1; y++) {
    const row = y * width;
    for (let x = bounds.x0; x < bounds.x1; x++) {
      const rawA = Number(a.data[row + x]), rawB = Number(b.data[row + x]);
      const av = rawA - backgroundA, bv = rawB - backgroundB;
      const apos = Math.max(0, av), bpos = Math.max(0, bv);
      addMoment(all, av, bv);
      if (av < thresholdA || bv < thresholdB) addMoment(below, av, bv);
      const bothAbove = av > thresholdA && bv > thresholdB;
      if (bothAbove) { addMoment(above, av, bv); colocPixels++; }
      sumA += apos; sumB += bpos; sumAA += apos * apos; sumBB += bpos * bpos; sumAB += apos * bpos;
      if (bothAbove) { sumAWithB += apos; sumBWithA += bpos; }
      if (bv > 0) sumAPresentB += apos;
      if (av > 0) sumBPresentA += bpos;
      if (av === 0 && bv === 0) zeroZero++;
      if (a.integer && rawA >= a.maxValue) saturatedA++;
      if (b.integer && rawB >= b.maxValue) saturatedB++;
      const product = (av - meanA) * (bv - meanB);
      if (product !== 0) { nonzeroProducts++; if (product > 0) positiveProducts++; }
    }
  }
  const warnings: string[] = [];
  if (!bounds.pixels) warnings.push('ROI 为空，无法计算。');
  if (!Number.isFinite(thresholdA) || !Number.isFinite(thresholdB)) warnings.push('自动阈值拟合失败；请改用 Otsu 或手动阈值。');
  if (a.id === b.id) warnings.push('通道 A 与通道 B 相同，结果没有跨通道意义。');
  const satA = a.integer && bounds.pixels ? saturatedA / bounds.pixels * 100 : Number.NaN;
  const satB = b.integer && bounds.pixels ? saturatedB / bounds.pixels * 100 : Number.NaN;
  if (satA > 1 || satB > 1) warnings.push('ROI 内饱和像素超过 1%，共定位结果可能失真。');
  if (thresholdMethod === 'costes' && Number.isFinite(regressionIntercept) && Math.abs(regressionIntercept / (meanB || 1)) > 0.01) warnings.push('Costes 回归零偏置较明显，请检查背景与探测器 offset。');
  if (thresholdMethod === 'costes' && (thresholdA > meanA || thresholdB > meanB)) warnings.push('Costes 阈值高于通道均值，阳性像素可能很少。');
  return {
    pearson: pearsonFrom(all),
    pearsonBelow: pearsonFrom(below),
    pearsonAbove: pearsonFrom(above),
    m1: sumA > 0 ? sumAPresentB / sumA : Number.NaN,
    m2: sumB > 0 ? sumBPresentA / sumB : Number.NaN,
    tm1: sumA > 0 && Number.isFinite(thresholdB) ? sumAWithB / sumA : Number.NaN,
    tm2: sumB > 0 && Number.isFinite(thresholdA) ? sumBWithA / sumB : Number.NaN,
    overlap: sumAA > 0 && sumBB > 0 ? sumAB / Math.sqrt(sumAA * sumBB) : Number.NaN,
    icq: nonzeroProducts ? positiveProducts / nonzeroProducts - 0.5 : Number.NaN,
    thresholdA, thresholdB, thresholdMethod, regressionSlope, regressionIntercept,
    colocPixels,
    colocAreaPct: bounds.pixels ? colocPixels / bounds.pixels * 100 : Number.NaN,
    zeroZeroPct: bounds.pixels ? zeroZero / bounds.pixels * 100 : Number.NaN,
    sampleSize,
    warnings,
  };
}

function bilinear(data: NumericArray, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return Number.NaN;
  const x0 = clamp(Math.floor(x), 0, width - 1), y0 = clamp(Math.floor(y), 0, height - 1);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const fx = clamp(x - x0, 0, 1), fy = clamp(y - y0, 0, 1);
  const top = Number(data[y0 * width + x0]) * (1 - fx) + Number(data[y0 * width + x1]) * fx;
  const bottom = Number(data[y1 * width + x0]) * (1 - fx) + Number(data[y1 * width + x1]) * fx;
  return top * (1 - fy) + bottom * fy;
}

export function gaussianSmooth(values: number[], sigma: number): number[] {
  if (sigma <= 0 || values.length < 3) return values.slice();
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel: number[] = [];
  let total = 0;
  for (let i = -radius; i <= radius; i++) { const value = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel.push(value); total += value; }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  return values.map((_, index) => {
    let sum = 0, weight = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const source = clamp(index + offset, 0, values.length - 1);
      const w = kernel[offset + radius]; sum += values[source] * w; weight += w;
    }
    return sum / weight;
  });
}

export function lineProfile(a: ChannelData, b: ChannelData, width: number, height: number, line: Line, lineWidth: number, sigma: number, backgroundA = 0, backgroundB = 0): LineProfile {
  const dx = line.x2 - line.x1, dy = line.y2 - line.y1;
  const length = Math.hypot(dx, dy);
  if (length < 1) return { distance: [], validCount: [], rawA: [], rawB: [], correctedA: [], correctedB: [], smoothA: [], smoothB: [], sdA: [], sdB: [] };
  const count = Math.max(2, Math.ceil(length) + 1);
  const samplesAcross = Math.max(1, Math.round(lineWidth));
  const px = -dy / length, py = dx / length;
  const distance: number[] = [], validCount: number[] = [], rawA: number[] = [], rawB: number[] = [], sdA: number[] = [], sdB: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1), cx = line.x1 + dx * t, cy = line.y1 + dy * t;
    let sumA = 0, sumB = 0, sumSqA = 0, sumSqB = 0, valid = 0;
    for (let j = 0; j < samplesAcross; j++) {
      const offset = j - (samplesAcross - 1) / 2;
      const av = bilinear(a.data, width, height, cx + px * offset, cy + py * offset);
      const bv = bilinear(b.data, width, height, cx + px * offset, cy + py * offset);
      if (Number.isFinite(av) && Number.isFinite(bv)) { sumA += av; sumB += bv; sumSqA += av * av; sumSqB += bv * bv; valid++; }
    }
    const meanA = valid ? sumA / valid : Number.NaN, meanB = valid ? sumB / valid : Number.NaN;
    distance.push(length * t); validCount.push(valid); rawA.push(meanA); rawB.push(meanB);
    sdA.push(valid > 1 ? Math.sqrt(Math.max(0, (sumSqA - sumA * sumA / valid) / (valid - 1))) : 0);
    sdB.push(valid > 1 ? Math.sqrt(Math.max(0, (sumSqB - sumB * sumB / valid) / (valid - 1))) : 0);
  }
  const correctedA = rawA.map(value => value - backgroundA);
  const correctedB = rawB.map(value => value - backgroundB);
  return { distance, validCount, rawA, rawB, correctedA, correctedB, smoothA: gaussianSmooth(correctedA, sigma), smoothB: gaussianSmooth(correctedB, sigma), sdA, sdB };
}

export function scatterSample(a: ChannelData, b: ChannelData, width: number, height: number, roi: Rect | null | undefined, backgroundA = 0, backgroundB = 0, limit = 20000) {
  return sampledPairs(a, b, width, height, roi, backgroundA, backgroundB, limit);
}
