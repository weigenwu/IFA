import type { ChannelData, NumericArray } from './analysis';

export interface LoadedImage {
  fileName: string;
  sourceFiles: string[];
  format: string;
  width: number;
  height: number;
  channels: ChannelData[];
  hash: string;
  pageCount: number;
  pixelSizeUm: number | null;
  displayOnly: boolean;
  warnings: string[];
}

interface OmeMetadata {
  channelLabels: string[];
  sizeC: number;
  sizeZ: number;
  sizeT: number;
  significantBits: number | null;
  pixelSizeUm: number | null;
}

const MAX_CHANNELS = 12;
const MAX_FILES = 8;

const channelInfo = (data: NumericArray, significantBits?: number | null) => {
  const inferred = data instanceof Uint8Array ? { maxValue: 255, bitDepth: 8, integer: true }
    : data instanceof Uint16Array ? { maxValue: 65535, bitDepth: 16, integer: true }
      : data instanceof Uint32Array ? { maxValue: 4294967295, bitDepth: 32, integer: true }
        : data instanceof Int8Array ? { maxValue: 127, bitDepth: 8, integer: true }
          : data instanceof Int16Array ? { maxValue: 32767, bitDepth: 16, integer: true }
            : data instanceof Int32Array ? { maxValue: 2147483647, bitDepth: 32, integer: true }
              : null;
  if (inferred) {
    if (significantBits && significantBits > 0 && significantBits <= inferred.bitDepth) {
      return { maxValue: 2 ** significantBits - 1, bitDepth: significantBits, integer: true };
    }
    return inferred;
  }
  let maxValue = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) maxValue = Math.max(maxValue, Number(data[i]));
  return { maxValue: Math.max(1, maxValue), bitDepth: data instanceof Float64Array ? 64 : 32, integer: false };
};

const makeChannel = (id: string, label: string, data: NumericArray, significantBits?: number | null): ChannelData => ({ id, label, data, ...channelInfo(data, significantBits) });

const observedMax = (data: NumericArray) => {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i++) max = Math.max(max, Number(data[i]));
  return max;
};

const correlation = (a: NumericArray, b: NumericArray) => {
  const step = Math.max(1, Math.ceil(a.length / 100000));
  let n = 0, sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
  for (let i = 0; i < a.length; i += step) {
    const av = Number(a[i]), bv = Number(b[i]);
    if (!av && !bv) continue;
    n++; sumA += av; sumB += bv; sumAA += av * av; sumBB += bv * bv; sumAB += av * bv;
  }
  const denominator = Math.sqrt(Math.max(0, sumAA - sumA * sumA / n) * Math.max(0, sumBB - sumB * sumB / n));
  return n > 1 && denominator > 0 ? (sumAB - sumA * sumB / n) / denominator : Number.NaN;
};

export function collapsePseudocolor(channels: ChannelData[]): ChannelData | null {
  if (channels.length !== 3 || channels.some(channel => channel.data.length !== channels[0].data.length)) return null;
  const active = channels.map(channel => ({ channel, peak: observedMax(channel.data) })).filter(item => item.peak > 0);
  if (!active.length) return null;
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const value = correlation(active[i].channel.data, active[j].channel.data);
      if (!Number.isFinite(value) || value < 0.995) return null;
    }
  }
  const signal = active.reduce((best, item) => item.peak > best.peak ? item : best);
  return makeChannel('signal', '灰度信号（由伪彩色还原）', signal.channel.data, signal.channel.bitDepth);
}

async function sha256(buffer: ArrayBuffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const microns = (value: string | null, unit: string | null) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  const normalized = (unit || 'µm').toLowerCase();
  if (normalized === 'nm') return number / 1000;
  if (normalized === 'mm') return number * 1000;
  return ['µm', 'um', 'micrometer', 'micrometre'].includes(normalized) ? number : null;
};

function parseOmeMetadata(description: string): OmeMetadata | null {
  if (!description.includes('<OME')) return null;
  const xml = new DOMParser().parseFromString(description, 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) return null;
  const pixels = xml.getElementsByTagNameNS('*', 'Pixels')[0];
  if (!pixels) return null;
  const channelLabels = Array.from(xml.getElementsByTagNameNS('*', 'Channel')).map((channel, index) => {
    const name = channel.getAttribute('Name') || channel.getAttribute('Fluor') || `通道 ${index + 1}`;
    const wavelength = channel.getAttribute('ExcitationWavelength');
    return wavelength ? `${name} · ${wavelength} nm` : name;
  });
  return {
    channelLabels,
    sizeC: Number(pixels.getAttribute('SizeC')) || channelLabels.length || 1,
    sizeZ: Number(pixels.getAttribute('SizeZ')) || 1,
    sizeT: Number(pixels.getAttribute('SizeT')) || 1,
    significantBits: Number(pixels.getAttribute('SignificantBits')) || null,
    pixelSizeUm: microns(pixels.getAttribute('PhysicalSizeX'), pixels.getAttribute('PhysicalSizeXUnit')),
  };
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
  const rgb = [makeChannel('red', '红色 / R', red), makeChannel('green', '绿色 / G', green), makeChannel('blue', '蓝色 / B', blue)];
  const collapsed = collapsePseudocolor(rgb);
  const extension = file.name.split('.').pop()?.toUpperCase() || 'IMAGE';
  const warnings = /jpe?g/i.test(file.type) || /\.jpe?g$/i.test(file.name)
    ? ['JPEG 为有损 8-bit 图像，仅建议探索性分析。']
    : ['浏览器解码后的 8-bit 数据；严肃定量优先使用原始 OME-TIFF。'];
  if (collapsed) warnings.push('检测到单通道伪彩/灰度 RGB，已还原为一个 8-bit 信号通道。');
  return {
    fileName: file.name,
    sourceFiles: [file.name],
    format: extension,
    width: canvas.width,
    height: canvas.height,
    channels: collapsed ? [collapsed] : rgb,
    hash: await sha256(buffer),
    pageCount: 1,
    pixelSizeUm: null,
    displayOnly: true,
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
  const photometric = Number(first.getFileDirectory().getValue('PhotometricInterpretation'));
  const description = String(await first.getFileDirectory().loadValue('ImageDescription') ?? '');
  const ome = parseOmeMetadata(description);
  if (ome && (ome.sizeZ > 1 || ome.sizeT > 1)) {
    throw new Error(`检测到 OME-TIFF Z=${ome.sizeZ}、T=${ome.sizeT}。请先在 Fiji 选择单层或生成投影，再导出二维 OME-TIFF。`);
  }
  const channels: ChannelData[] = [];
  const warnings: string[] = [];

  if (sampleCount > 1) {
    const count = Math.min(MAX_CHANNELS, sampleCount);
    const rasters = await first.readRasters({ samples: Array.from({ length: count }, (_, index) => index) }) as unknown as NumericArray[];
    for (let i = 0; i < count; i++) {
      const bits = ome?.significantBits ?? first.getBitsPerSample(i);
      channels.push(makeChannel(`sample-${i + 1}`, ome?.channelLabels[i] || `样本 ${i + 1}`, rasters[i], bits));
    }
    if (!ome) warnings.push(`文件含 ${sampleCount} 个样本；请确认它们与荧光通道的对应关系。`);
    if (sampleCount > MAX_CHANNELS) warnings.push(`文件含 ${sampleCount} 个样本，仅载入前 ${MAX_CHANNELS} 个。`);
  } else {
    const expectedChannels = ome?.sizeC || pageCount;
    const count = Math.min(MAX_CHANNELS, pageCount, expectedChannels);
    for (let i = 0; i < count; i++) {
      const image = await tiff.getImage(i);
      if (image.getWidth() !== width || image.getHeight() !== height) {
        warnings.push(`第 ${i + 1} 页尺寸不同，已跳过。`);
        continue;
      }
      const rasters = await image.readRasters({ samples: [0] }) as unknown as NumericArray[];
      const bits = ome?.significantBits ?? image.getBitsPerSample(0);
      channels.push(makeChannel(`page-${i + 1}`, ome?.channelLabels[i] || (pageCount === 1 ? '灰度 / Gray' : `页面 ${i + 1}`), rasters[0], bits));
    }
    if (!ome && pageCount > 1) warnings.push(`文件含 ${pageCount} 页；请确认页面与通道顺序。`);
    if (expectedChannels > MAX_CHANNELS) warnings.push(`文件含 ${expectedChannels} 个通道，仅载入前 ${MAX_CHANNELS} 个。`);
  }
  if (!channels.length) throw new Error('TIFF 中没有可读取的像素通道。');

  const collapsed = !ome ? collapsePseudocolor(channels) : null;
  const finalChannels = collapsed ? [collapsed] : channels;
  if (collapsed) warnings.push('检测到单通道伪彩 RGB TIFF，已还原为一个信号通道；8-bit 文件仅建议探索性定量。');
  else if (!ome && photometric === 2) warnings.push('检测到多色 RGB TIFF，可能是合并展示图；请勿把 RGB 分量当作原始染料通道。');
  if (ome) warnings.push(`已读取 OME 元数据：${ome.sizeC} 通道，Z=${ome.sizeZ}，T=${ome.sizeT}。`);
  if (finalChannels.some(channel => channel.bitDepth > 8)) warnings.push('分析使用 TIFF 原始位深；显示预览单独缩放，不改变数值。');
  return {
    fileName: file.name,
    sourceFiles: [file.name],
    format: ome ? 'OME-TIFF' : 'TIFF',
    width,
    height,
    channels: finalChannels,
    hash: await sha256(buffer),
    pageCount,
    pixelSizeUm: ome?.pixelSizeUm ?? null,
    displayOnly: Boolean(collapsed || (!ome && photometric === 2)),
    warnings,
  };
}

export async function loadImage(file: File): Promise<LoadedImage> {
  if (/\.zip$/i.test(file.name)) {
    throw new Error('请先解压 ZIP。若其中是 Olympus OIR，请在 Fiji / Bio-Formats 中批量导出二维 OME-TIFF 或原始位深灰度 TIFF。');
  }
  if (/\.oir$/i.test(file.name)) {
    throw new Error('Olympus OIR 不能由普通浏览器可靠解码。请在 Fiji 用 Bio-Formats 打开，导出 OME-TIFF 或保持原始位深的分通道灰度 TIFF 后再分析。');
  }
  const buffer = await file.arrayBuffer();
  const isTiff = /tiff?/i.test(file.type) || /\.tiff?$/i.test(file.name);
  return isTiff ? loadTiff(file, buffer) : loadStandard(file, buffer);
}

export async function loadImages(files: File[]): Promise<LoadedImage> {
  if (!files.length) throw new Error('请选择图像文件。');
  if (files.length > MAX_FILES) throw new Error(`一次最多组合 ${MAX_FILES} 个分通道文件。`);
  const oir = files.find(file => /\.oir$/i.test(file.name));
  if (oir) return loadImage(oir);
  const loaded = await Promise.all(files.map(loadImage));
  if (loaded.length === 1) return loaded[0];
  const { width, height } = loaded[0];
  if (loaded.some(image => image.width !== width || image.height !== height)) throw new Error('分通道文件的宽高不一致；网页不会自动配准，请先在 Fiji 对齐并导出。');
  const channels = loaded.flatMap((image, fileIndex) => {
    const stem = image.fileName.replace(/\.[^.]+$/, '');
    return image.channels.map(channel => ({ ...channel, id: `file-${fileIndex + 1}-${channel.id}`, label: image.channels.length === 1 ? stem : `${stem} · ${channel.label}` }));
  });
  if (channels.length > MAX_CHANNELS) throw new Error(`组合后得到 ${channels.length} 个通道；请减少文件，使通道数不超过 ${MAX_CHANNELS}。`);
  const pixelSizes = loaded.map(image => image.pixelSizeUm).filter((value): value is number => value !== null);
  const pixelSizeUm = pixelSizes[0] ?? null;
  const warnings = [...new Set(loaded.flatMap(image => image.warnings))];
  warnings.push(`已把 ${loaded.length} 个同尺寸文件作为对齐通道组合；网页不会执行配准。`);
  if (pixelSizes.some(value => Math.abs(value - pixelSizeUm!) > 1e-9)) warnings.push('各文件的像素尺寸元数据不一致，请手动核对标尺。');
  const joinedHashes = loaded.map(image => image.hash).join('\n');
  return {
    fileName: files.map(file => file.name).join(' + '),
    sourceFiles: files.map(file => file.name),
    format: [...new Set(loaded.map(image => image.format))].join(' + '),
    width,
    height,
    channels,
    hash: await sha256(new TextEncoder().encode(joinedHashes).buffer as ArrayBuffer),
    pageCount: loaded.reduce((sum, image) => sum + image.pageCount, 0),
    pixelSizeUm,
    displayOnly: loaded.some(image => image.displayOnly),
    warnings,
  };
}
