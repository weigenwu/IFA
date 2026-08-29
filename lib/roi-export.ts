import type { GeotiffWriterMetadata } from 'geotiff';

import { boundsFor, percentileInRoi, type Rect } from './analysis.ts';
import type { LoadedImage } from './image.ts';

export type PseudocolorName = 'green' | 'red' | 'blue' | 'cyan' | 'magenta' | 'yellow' | 'gray';
export type NormalizedRgb = readonly [number, number, number];
export type RoiExportView = 'overlay' | 'a' | 'b' | 'mask' | `channel:${string}`;

export interface RoiExportChannel {
  id: string;
  color: PseudocolorName | NormalizedRgb;
  enabled?: boolean;
}

export interface RoiExportMask {
  channelAId: string;
  channelBId: string;
  thresholdA: number;
  thresholdB: number;
  backgroundA?: number;
  backgroundB?: number;
}

export interface RenderRoiOptions {
  image: LoadedImage;
  channels: RoiExportChannel[];
  roi?: Rect | null;
  view?: RoiExportView;
  /**
   * Raises the display black point within the observed minimum-to-maximum range.
   * This changes only the exported pseudocolor rendering, never source pixels.
   */
  blackPointPercent?: number;
  mask?: RoiExportMask | null;
  /** A scale bar is drawn only when both values are finite and greater than zero. */
  pixelSizeUm?: number | null;
  scaleBarUm?: number | null;
}

export interface RenderedScaleBar {
  rendered: boolean;
  label: string;
  requestedUm: number;
  pixelLength: number;
  reason?: string;
}

export interface RenderedRoi {
  /** Interleaved 8-bit RGB pseudocolor pixels. This is not raw quantitative data. */
  rgb: Uint8Array;
  width: number;
  height: number;
  sourceRoi: { x: number; y: number; width: number; height: number };
  blackPointPercent: number;
  scaleBar: RenderedScaleBar | null;
}

export const ROI_TIFF_DESCRIPTION = 'FluoroScope ROI export; 8-bit RGB pseudocolor rendering; not raw quantitative fluorescence data.';

const PSEUDOCOLOR_RGB: Record<PseudocolorName, NormalizedRgb> = {
  green: [0, 1, 0],
  red: [1, 0, 0],
  blue: [0, 0, 1],
  cyan: [0, 1, 1],
  magenta: [1, 0, 1],
  yellow: [1, 1, 0],
  gray: [1, 1, 1],
};

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

function colorRgb(color: RoiExportChannel['color']): NormalizedRgb {
  if (typeof color === 'string') return PSEUDOCOLOR_RGB[color];
  if (color.length !== 3 || color.some(value => !Number.isFinite(value))) {
    throw new Error('伪彩 RGB 必须是三个有限的 0–1 数值。');
  }
  return color.map(value => clamp(value, 0, 1)) as unknown as NormalizedRgb;
}

function visibleChannels(channels: RoiExportChannel[], view: RoiExportView) {
  const enabled = channels.filter(channel => channel.enabled !== false);
  if (!enabled.length) throw new Error('至少选择一个要导出的通道。');
  if (view === 'overlay' || view === 'mask') return enabled;
  if (view === 'a') return enabled.slice(0, 1);
  if (view === 'b') return enabled.slice(1, 2);
  const id = view.slice('channel:'.length);
  return enabled.filter(channel => channel.id === id);
}

type Glyph = readonly string[];

const FONT: Record<string, Glyph> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  '.': ['00000', '00000', '00000', '00000', '00000', '00110', '00110'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  'm': ['00000', '00000', '11010', '10101', '10101', '10101', '10101'],
  'µ': ['00000', '00000', '10001', '10001', '10011', '11101', '10000'],
};

function fillRect(rgb: Uint8Array, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, value: 0 | 255) {
  const x0 = clamp(Math.floor(x), 0, width);
  const y0 = clamp(Math.floor(y), 0, height);
  const x1 = clamp(Math.ceil(x + rectWidth), 0, width);
  const y1 = clamp(Math.ceil(y + rectHeight), 0, height);
  for (let row = y0; row < y1; row++) {
    for (let column = x0; column < x1; column++) {
      const offset = (row * width + column) * 3;
      rgb[offset] = value;
      rgb[offset + 1] = value;
      rgb[offset + 2] = value;
    }
  }
}

function drawText(rgb: Uint8Array, width: number, height: number, text: string, right: number, top: number, scale: number) {
  const glyphWidth = 5 * scale;
  const advance = 6 * scale;
  const textWidth = Math.max(0, text.length * advance - scale);
  const left = right - textWidth;

  // A one-pixel black shadow keeps the white label legible over bright signal.
  for (const value of [0, 255] as const) {
    const shadow = value === 0 ? Math.max(1, Math.floor(scale / 2)) : 0;
    let cursor = left;
    for (const character of text) {
      const glyph = FONT[character] ?? FONT[' '];
      glyph.forEach((row, rowIndex) => {
        for (let column = 0; column < row.length; column++) {
          if (row[column] === '1') {
            fillRect(rgb, width, height, cursor + column * scale + shadow, top + rowIndex * scale + shadow, scale, scale, value);
          }
        }
      });
      cursor += advance;
    }
  }
  return { left, width: textWidth, height: 7 * scale, glyphWidth };
}

function scaleBarLabel(value: number) {
  return `${Number(value.toPrecision(6))} µm`;
}

function drawScaleBar(rgb: Uint8Array, width: number, height: number, pixelSizeUm?: number | null, scaleBarUm?: number | null): RenderedScaleBar | null {
  if (!(pixelSizeUm && pixelSizeUm > 0) || !(scaleBarUm && scaleBarUm > 0) || !Number.isFinite(pixelSizeUm) || !Number.isFinite(scaleBarUm)) return null;

  const pixelLength = Math.max(1, Math.round(scaleBarUm / pixelSizeUm));
  const label = scaleBarLabel(scaleBarUm);
  const margin = Math.max(3, Math.round(Math.min(width, height) * 0.03));
  const scale = Math.max(1, Math.min(12, Math.round(Math.min(width, height) / 230)));
  const textWidth = Math.max(0, label.length * 6 * scale - scale);
  const barThickness = Math.max(2, scale);
  const requiredWidth = Math.max(pixelLength, textWidth);
  const requiredHeight = 7 * scale + 2 * scale + barThickness;

  if (requiredWidth + 2 * margin > width || requiredHeight + 2 * margin > height) {
    return { rendered: false, label, requestedUm: scaleBarUm, pixelLength, reason: 'ROI 太小，比例尺或文字无法在留边后完整显示。' };
  }

  const right = width - margin;
  const barY = height - margin - barThickness;
  const barX = right - pixelLength;
  const textTop = barY - 2 * scale - 7 * scale;
  drawText(rgb, width, height, label, right, textTop, scale);

  // Black outline first, then the exact-length white bar.
  fillRect(rgb, width, height, barX - 1, barY - 1, pixelLength + 2, barThickness + 2, 0);
  fillRect(rgb, width, height, barX, barY, pixelLength, barThickness, 255);
  return { rendered: true, label, requestedUm: scaleBarUm, pixelLength };
}

export function renderRoiPseudocolor(options: RenderRoiOptions): RenderedRoi {
  const {
    image,
    channels,
    roi = null,
    view = 'overlay',
    mask = null,
    pixelSizeUm = null,
    scaleBarUm = null,
  } = options;
  const blackPointPercent = clamp(Number.isFinite(options.blackPointPercent) ? Number(options.blackPointPercent) : 0, 0, 99.9);
  const bounds = boundsFor(image.width, image.height, roi);
  const width = bounds.x1 - bounds.x0;
  const height = bounds.y1 - bounds.y0;
  if (!width || !height) throw new Error('ROI 位于图像外或面积为零，无法导出。');

  const selected = visibleChannels(channels, view).map(setting => {
    const channel = image.channels.find(candidate => candidate.id === setting.id);
    if (!channel) throw new Error(`找不到要导出的通道：${setting.id}`);
    if (channel.data.length < image.width * image.height) throw new Error(`通道 ${channel.label} 的像素数量不足。`);
    const baseLow = percentileInRoi(channel, image.width, image.height, null, 0);
    const high = percentileInRoi(channel, image.width, image.height, null, 1);
    const low = baseLow + Math.max(0, high - baseLow) * blackPointPercent / 100;
    return { channel, rgb: colorRgb(setting.color), low, range: Math.max(1e-12, high - low) };
  });
  if (!selected.length) throw new Error('当前视图对应的通道未被选择，无法导出。');

  let maskA = null as typeof image.channels[number] | null;
  let maskB = null as typeof image.channels[number] | null;
  if (view === 'mask') {
    if (!mask) throw new Error('导出共定位 Mask 需要提供两个通道及阈值。');
    maskA = image.channels.find(channel => channel.id === mask.channelAId) ?? null;
    maskB = image.channels.find(channel => channel.id === mask.channelBId) ?? null;
    if (!maskA || !maskB) throw new Error('共定位 Mask 的通道不存在。');
  }

  const rgb = new Uint8Array(width * height * 3);
  for (let targetY = 0; targetY < height; targetY++) {
    const sourceY = bounds.y0 + targetY;
    for (let targetX = 0; targetX < width; targetX++) {
      const sourceX = bounds.x0 + targetX;
      const source = sourceY * image.width + sourceX;
      const target = (targetY * width + targetX) * 3;
      let red = 0, green = 0, blue = 0;
      for (const item of selected) {
        const value = clamp((Number(item.channel.data[source]) - item.low) / item.range, 0, 1);
        red = Math.min(1, red + value * item.rgb[0]);
        green = Math.min(1, green + value * item.rgb[1]);
        blue = Math.min(1, blue + value * item.rgb[2]);
      }
      if (view === 'mask' && mask && maskA && maskB) {
        const positive = Number(maskA.data[source]) - (mask.backgroundA ?? 0) > mask.thresholdA
          && Number(maskB.data[source]) - (mask.backgroundB ?? 0) > mask.thresholdB;
        if (positive) red = green = blue = 1;
        else { red *= 0.18; green *= 0.18; blue *= 0.18; }
      }
      rgb[target] = Math.round(red * 255);
      rgb[target + 1] = Math.round(green * 255);
      rgb[target + 2] = Math.round(blue * 255);
    }
  }

  const scaleBar = drawScaleBar(rgb, width, height, pixelSizeUm, scaleBarUm);
  return {
    rgb,
    width,
    height,
    sourceRoi: { x: bounds.x0, y: bounds.y0, width, height },
    blackPointPercent,
    scaleBar,
  };
}

export async function encodePseudocolorTiff(rendered: RenderedRoi): Promise<ArrayBuffer> {
  if (rendered.rgb.length !== rendered.width * rendered.height * 3) throw new Error('RGB 像素数量与导出尺寸不一致。');
  const { writeArrayBuffer } = await import('geotiff');
  const metadata: GeotiffWriterMetadata & { ImageDescription: string } = {
    width: rendered.width,
    height: rendered.height,
    BitsPerSample: [8, 8, 8],
    Compression: 1,
    PlanarConfiguration: 1,
    PhotometricInterpretation: 2,
    SamplesPerPixel: 3,
    RowsPerStrip: rendered.height,
    ImageDescription: ROI_TIFF_DESCRIPTION,
  };
  return writeArrayBuffer(rendered.rgb, metadata);
}

export async function renderedRoiToBlob(rendered: RenderedRoi, format: 'png' | 'jpg' | 'jpeg', jpegQuality = 0.92): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('PNG/JPG 导出需要在浏览器中运行。');
  const canvas = document.createElement('canvas');
  canvas.width = rendered.width;
  canvas.height = rendered.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建导出画布。');
  const imageData = context.createImageData(rendered.width, rendered.height);
  for (let source = 0, target = 0; source < rendered.rgb.length; source += 3, target += 4) {
    imageData.data[target] = rendered.rgb[source];
    imageData.data[target + 1] = rendered.rgb[source + 1];
    imageData.data[target + 2] = rendered.rgb[source + 2];
    imageData.data[target + 3] = 255;
  }
  context.putImageData(imageData, 0, 0);
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  const quality = clamp(jpegQuality, 0, 1);
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error(`${format.toUpperCase()} 编码失败。`));
  }, mime, quality));
}
