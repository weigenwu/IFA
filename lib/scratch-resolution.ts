import type { RGBAFrame } from './migration.ts';
import { parseScratchFile } from './migration-batch.ts';

export interface ScratchResolution {
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  baselinePath: string;
  confirmedSameField: boolean;
  method: 'canvas-high-quality';
}

export function resolveScratchBaseline<T extends { path: string }>(path: string, candidates: readonly T[]): T {
  const current = parseScratchFile(path);
  if (current.timeHours === null) throw new Error('未识别时间，请使用“视野名_0H / 24H / 48H”等文件名。');
  const matches = candidates.filter(candidate => {
    const parsed = parseScratchFile(candidate.path);
    return parsed.parent === current.parent && parsed.series === current.series && parsed.timeHours === 0;
  });
  if (!matches.length) throw new Error('缺少同一文件夹、同名视野的 0H 图像。');
  if (matches.length !== 1) throw new Error('0H 匹配不唯一，请保留唯一的基准图像。');
  return matches[0];
}

export function assertScratchResize(width: number, height: number, targetWidth: number, targetHeight: number): void {
  if (![width, height, targetWidth, targetHeight].every(value => Number.isSafeInteger(value) && value > 0)
      || width * height > 0x1fffffff || targetWidth * targetHeight > 0x1fffffff) {
    throw new Error('图像尺寸无效，无法统一分辨率。');
  }
  if (width * targetHeight !== height * targetWidth) {
    throw new Error('与 0H 的宽高比例不同，可能经过裁剪；未调整尺寸，请核对视野。');
  }
}

/** Resize a browser-local analysis copy only; the imported File and its hash stay unchanged. */
export function resizeScratchFrame(frame: RGBAFrame, target: { width: number; height: number }): RGBAFrame {
  assertScratchResize(frame.width, frame.height, target.width, target.height);
  if (!(frame.data instanceof Uint8ClampedArray) || frame.data.length !== frame.width * frame.height * 4) {
    throw new Error('图像像素与尺寸不一致，无法统一分辨率。');
  }
  if (frame.width === target.width && frame.height === target.height) return frame;
  const source = document.createElement('canvas'), output = document.createElement('canvas');
  try {
    source.width = frame.width; source.height = frame.height;
    output.width = target.width; output.height = target.height;
    const input = source.getContext('2d'), context = output.getContext('2d');
    if (!input || !context) throw new Error('无法创建分辨率调整画布。');
    input.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, target.width, target.height);
    return { width: target.width, height: target.height, data: context.getImageData(0, 0, target.width, target.height).data };
  } finally {
    source.width = 0; source.height = 0; output.width = 0; output.height = 0;
  }
}
