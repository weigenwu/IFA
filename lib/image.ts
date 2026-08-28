import type { ChannelData, NumericArray } from './analysis';

export interface LoadedImage {
  fileName: string;
  format: string;
  width: number;
  height: number;
  channels: ChannelData[];
  hash: string;
  pageCount: number;
  warnings: string[];
}

const channelInfo = (data: NumericArray) => {
  if (data instanceof Uint8Array) return { maxValue: 255, bitDepth: 8, integer: true };
  if (data instanceof Uint16Array) return { maxValue: 65535, bitDepth: 16, integer: true };
  if (data instanceof Uint32Array) return { maxValue: 4294967295, bitDepth: 32, integer: true };
  if (data instanceof Int8Array) return { maxValue: 127, bitDepth: 8, integer: true };
  if (data instanceof Int16Array) return { maxValue: 32767, bitDepth: 16, integer: true };
  if (data instanceof Int32Array) return { maxValue: 2147483647, bitDepth: 32, integer: true };
  let maxValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) maxValue = Math.max(maxValue, Number(data[i]));
  return { maxValue: Math.max(1, maxValue), bitDepth: data instanceof Float64Array ? 64 : 32, integer: false };
};

const makeChannel = (id: string, label: string, data: NumericArray): ChannelData => ({ id, label, data, ...channelInfo(data) });

async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function loadStandard(file: File, buffer: ArrayBuffer): Promise<LoadedImage> {
  const bitmap = await createImageBitmap(new Blob([buffer], { type: file.type }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('浏览器无法创建图像画布。');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const red = new Uint8Array(canvas.width * canvas.height);
  const green = new Uint8Array(red.length);
  const blue = new Uint8Array(red.length);
  for (let source = 0, target = 0; target < red.length; source += 4, target++) {
    red[target] = pixels[source]; green[target] = pixels[source + 1]; blue[target] = pixels[source + 2];
  }
  const extension = file.name.split('.').pop()?.toUpperCase() || 'IMAGE';
  const warnings = /jpe?g/i.test(file.type) || /\.jpe?g$/i.test(file.name)
    ? ['JPEG 为有损 8-bit 图像，仅建议探索性分析。']
    : ['浏览器解码后的 8-bit RGB 数据；严肃定量优先使用原始 TIFF。'];
  return {
    fileName: file.name,
    format: extension,
    width: canvas.width,
    height: canvas.height,
    channels: [makeChannel('red', '红色 / R', red), makeChannel('green', '绿色 / G', green), makeChannel('blue', '蓝色 / B', blue)],
    hash: await sha256(buffer),
    pageCount: 1,
    warnings,
  };
}

async function loadTiff(file: File, buffer: ArrayBuffer): Promise<LoadedImage> {
  const { fromArrayBuffer } = await import('geotiff');
  const tiff = await fromArrayBuffer(buffer);
  const pageCount = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const width = first.getWidth(), height = first.getHeight();
  const sampleCount = first.getSamplesPerPixel();
  const channels: ChannelData[] = [];
  const warnings: string[] = [];

  if (sampleCount > 1) {
    const count = Math.min(3, sampleCount);
    const rasters = await first.readRasters({ samples: Array.from({ length: count }, (_, index) => index) }) as unknown as NumericArray[];
    const labels = ['样本 1', '样本 2', '样本 3'];
    for (let i = 0; i < count; i++) channels.push(makeChannel(`sample-${i + 1}`, labels[i], rasters[i]));
    warnings.push(`文件含 ${sampleCount} 个样本；请确认样本与荧光通道的对应关系。`);
    if (sampleCount > 3) warnings.push(`本版仅载入前 3 个样本。`);
  } else {
    const count = Math.min(3, pageCount);
    for (let i = 0; i < count; i++) {
      const image = await tiff.getImage(i);
      if (image.getWidth() !== width || image.getHeight() !== height) {
        warnings.push(`第 ${i + 1} 页尺寸不同，已跳过。`);
        continue;
      }
      const rasters = await image.readRasters({ samples: [0] }) as unknown as NumericArray[];
      channels.push(makeChannel(`page-${i + 1}`, pageCount === 1 ? '灰度 / Gray' : `页面 ${i + 1}`, rasters[0]));
    }
    if (pageCount > 3) warnings.push(`文件含 ${pageCount} 页，本版载入前 3 页；请确认页面与通道顺序。`);
  }
  if (!channels.length) throw new Error('TIFF 中没有可读取的像素通道。');
  if (channels.some(channel => channel.bitDepth > 8)) warnings.push('分析使用 TIFF 原始位深；显示预览单独缩放，不改变数值。');
  return { fileName: file.name, format: 'TIFF', width, height, channels, hash: await sha256(buffer), pageCount, warnings };
}

export async function loadImage(file: File): Promise<LoadedImage> {
  const buffer = await file.arrayBuffer();
  const isTiff = /tiff?/i.test(file.type) || /\.tiff?$/i.test(file.name);
  return isTiff ? loadTiff(file, buffer) : loadStandard(file, buffer);
}
