import type { RGBAFrame } from './migration';
import type { ColonyCircle } from './colony';

type RGB = [number, number, number];

function bounds(frame: RGBAFrame, roi: ColonyCircle) {
  const { width, height, data } = frame;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new Error('需要有效的 8-bit RGBA 展示图像。');
  if (![roi.cx, roi.cy, roi.r].every(Number.isFinite) || roi.r <= 0 || roi.cx - roi.r < 0 || roi.cy - roi.r < 0
    || roi.cx + roi.r > width || roi.cy + roi.r > height) throw new Error('展示圆必须完整位于图像内。');
  return { left: Math.max(0, Math.floor(roi.cx - roi.r)), right: Math.min(width - 1, Math.ceil(roi.cx + roi.r)),
    top: Math.max(0, Math.floor(roi.cy - roi.r)), bottom: Math.min(height - 1, Math.ceil(roi.cy + roi.r)) };
}

const inside = (x: number, y: number, roi: ColonyCircle) => (x + .5 - roi.cx) ** 2 + (y + .5 - roi.cy) ** 2 <= roi.r ** 2;

/** Median RGB of opaque pixels on a uniform spatial sample; raw image is never modified. */
export function estimateColonyBackground(frame: RGBAFrame, roi: ColonyCircle): RGB {
  const box = bounds(frame, roi), histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let count = 0;
  const sample = (step: number) => {
    for (let y = box.top; y <= box.bottom; y += step) for (let x = box.left; x <= box.right; x += step) {
      const at = (y * frame.width + x) * 4;
      if (!inside(x, y, roi) || frame.data[at + 3] !== 255) continue;
      for (let c = 0; c < 3; c++) histograms[c][frame.data[at + c]]++;
      count++;
    }
  };
  const step = Math.max(1, Math.ceil(Math.sqrt((box.right - box.left + 1) * (box.bottom - box.top + 1) / 50000)));
  sample(step);
  if (!count && step > 1) sample(1);
  if (!count) throw new Error('展示圆内没有可用于估计背景的不透明像素。');
  return histograms.map(histogram => {
    let total = 0;
    for (let i = 0; i < histogram.length; i++) { total += histogram[i]; if (total >= Math.ceil(count / 2)) return i; }
    return 0;
  }) as RGB;
}

/** Display-only global RGB gains within the circle; supply native-image background for all output sizes. */
export function recolorColonyBackground(frame: RGBAFrame, roi: ColonyCircle, targetHex: string, background?: RGB, strength = 1): { data: Uint8ClampedArray; background: RGB } {
  const box = bounds(frame, roi);
  if (!/^#[0-9a-f]{6}$/i.test(targetHex)) throw new Error('背景颜色需使用 #RRGGBB 格式。');
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) throw new Error('背景调整强度必须为 0–1。');
  if (background && (background.length !== 3 || background.some(value => !Number.isFinite(value) || value < 0 || value > 255))) throw new Error('背景 RGB 估计值必须为 0–255。');
  const estimated: RGB = background ? [...background] : estimateColonyBackground(frame, roi);
  const targets = estimated.map((_, i) => parseInt(targetHex.slice(1 + i * 2, 3 + i * 2), 16));
  const data = frame.data.slice();
  for (let y = box.top; y <= box.bottom; y++) for (let x = box.left; x <= box.right; x++) {
    const at = (y * frame.width + x) * 4;
    if (!inside(x, y, roi) || data[at + 3] !== 255) continue;
    for (let c = 0; c < 3; c++) {
      const value = estimated[c] > 0 ? data[at + c] * targets[c] / estimated[c] : data[at + c] + targets[c];
      const mixed = strength === 0 ? data[at + c] : strength === 1 ? value : data[at + c] + (value - data[at + c]) * strength;
      data[at + c] = Math.max(0, Math.min(255, mixed));
    }
  }
  return { data, background: estimated };
}
