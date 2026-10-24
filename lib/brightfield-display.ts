import type { RGBAFrame } from './migration.ts';

export interface BackgroundSettings { enabled: boolean; target: number; matchColor: boolean }
export interface BackgroundEstimate { rgb: [number, number, number]; sampleCount: number; valid: boolean; warnings: string[] }
export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = { enabled: false, target: 220, matchColor: true };

function validate(frame: RGBAFrame) {
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1 || !(frame.data instanceof Uint8ClampedArray) || frame.data.length !== frame.width * frame.height * 4) throw new Error('需要有效的 RGBA 明场图像。');
}
function percentile(values: number[], fraction: number) {
  const sorted = values.sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

/** Estimate an illumination reference from bright, low-texture patches, not stained cells. */
export function estimateBackground(frame: RGBAFrame): BackgroundEstimate {
  validate(frame);
  const { width, height, data } = frame, stride = width + 1;
  const sum = new Float64Array(stride * (height + 1)), square = new Float64Array(sum.length);
  for (let y = 0; y < height; y++) {
    let total = 0, squares = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      total += gray; squares += gray * gray;
      const at = (y + 1) * stride + x + 1;
      sum[at] = sum[at - stride] + total; square[at] = square[at - stride] + squares;
    }
  }
  const step = Math.max(1, Math.ceil(Math.sqrt(width * height / 30000))), radius = Math.min(5, Math.floor(Math.min(width, height) / 4));
  const samples: Array<{ index: number; mean: number; sd: number }> = [];
  for (let y = radius; y < height - radius; y += step) for (let x = radius; x < width - radius; x += step) {
    const x0 = x - radius, x1 = x + radius + 1, y0 = y - radius, y1 = y + radius + 1;
    const a = y0 * stride + x0, b = y0 * stride + x1, c = y1 * stride + x0, d = y1 * stride + x1, n = (x1 - x0) * (y1 - y0);
    const mean = (sum[d] - sum[b] - sum[c] + sum[a]) / n;
    const sd = Math.sqrt(Math.max(0, (square[d] - square[b] - square[c] + square[a]) / n - mean * mean));
    samples.push({ index: (y * width + x) * 4, mean, sd });
  }
  if (!samples.length) return { rgb: [0, 0, 0], sampleCount: 0, valid: false, warnings: ['没有足够的背景样本，保留原图。'] };
  const brightFloor = percentile(samples.map(sample => sample.mean), 0.55);
  const bright = samples.filter(sample => sample.mean >= brightFloor);
  const textureCeiling = percentile(bright.map(sample => sample.sd), 0.25);
  const selected = bright.filter(sample => sample.sd <= textureCeiling);
  const rgb = [0, 1, 2].map(channel => percentile(selected.map(sample => data[sample.index + channel]), 0.5)) as [number, number, number];
  const valid = selected.length >= Math.min(16, samples.length) && Math.min(...rgb) > 8;
  const warnings: string[] = [];
  if (!valid) warnings.push('未找到可靠的亮背景，保留原图。');
  else if (textureCeiling > 12) warnings.push('背景区域纹理较多，请核对统一后的亮度和色调。');
  return { rgb, sampleCount: selected.length, valid, warnings };
}

/** Global display-only RGB gains: one gain per channel over the entire field. */
export function normalizeBackground(frame: RGBAFrame, settings: BackgroundSettings, estimate = estimateBackground(frame)) {
  validate(frame);
  if (!Number.isFinite(settings.target) || settings.target < 160 || settings.target > 250) throw new Error('背景亮度需在 160–250 之间。');
  if (typeof settings.enabled !== 'boolean' || typeof settings.matchColor !== 'boolean') throw new Error('背景设置必须为有效布尔值。');
  const warnings = settings.enabled ? [...estimate.warnings] : [];
  const gains: [number, number, number] = [1, 1, 1];
  if (!settings.enabled || !estimate.valid) return { frame, estimate, gains, clippedFraction: 0, warnings };
  if (estimate.rgb.some(value => !Number.isFinite(value) || value <= 0 || value > 255)) throw new Error('背景估计值无效。');
  const gray = estimate.rgb[0] * 0.299 + estimate.rgb[1] * 0.587 + estimate.rgb[2] * 0.114;
  for (let c = 0; c < 3; c++) {
    const requested = settings.target / (settings.matchColor ? estimate.rgb[c] : gray);
    gains[c] = Math.min(4, Math.max(0.25, requested));
    if (gains[c] !== requested && !warnings.includes('亮度差异过大，已限制增益；背景可能未完全匹配。')) warnings.push('亮度差异过大，已限制增益；背景可能未完全匹配。');
  }
  const data = new Uint8ClampedArray(frame.data.length);
  let clipped = 0;
  for (let i = 0; i < data.length; i += 4) {
    let overflow = false;
    for (let c = 0; c < 3; c++) {
      const value = frame.data[i + c] * gains[c];
      overflow ||= value > 255;
      data[i + c] = value;
    }
    data[i + 3] = frame.data[i + 3];
    if (overflow) clipped++;
  }
  const clippedFraction = clipped / (frame.width * frame.height);
  if (clippedFraction > 0.005) warnings.push(`调整后 ${(clippedFraction * 100).toFixed(1)}% 像素超出显示上限，可降低目标亮度。`);
  return { frame: { ...frame, data }, estimate, gains, clippedFraction, warnings };
}
