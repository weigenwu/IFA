import type { ChannelData, NumericArray } from './analysis';
import { parseOir } from './oir.ts';

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
  pixelSizeWarning: string | null;
}

const MAX_CHANNELS = 12;
const MAX_FILES = 8;
const RGB_COMPONENTS = [
  { id: 'red', label: 'RGB 红分量 / R', color: 'red' },
  { id: 'green', label: 'RGB 绿分量 / G', color: 'green' },
  { id: 'blue', label: 'RGB 蓝分量 / B', color: 'blue' },
] as const;
const RGB_COMPOSITE_WARNING = '检测到 RGB 合并展示图。这里的 R、G、B 是文件的三个显示分量，不等同于三个原始荧光通道。如果原图由蓝、绿、红、洋红等 4 个荧光通道合并导出，洋红已经同时写入 R 与 B，无法从该 RGB 文件精确恢复成独立第 4 通道。请上传原始 OIR、保留通道维度的 OME-TIFF，或分别上传 4 个单通道 TIFF。';

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

const makeChannel = (id: string, label: string, data: NumericArray, significantBits?: number | null, sourceColor?: string | null): ChannelData => ({ id, label, sourceColor, data, ...channelInfo(data, significantBits) });

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
  return makeChannel('signal', '灰度信号（由单色伪彩还原）', signal.channel.data, signal.channel.bitDepth);
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
  const pixelSizeX = microns(pixels.getAttribute('PhysicalSizeX'), pixels.getAttribute('PhysicalSizeXUnit'));
  const pixelSizeY = microns(pixels.getAttribute('PhysicalSizeY'), pixels.getAttribute('PhysicalSizeYUnit'));
  const anisotropic = pixelSizeX !== null && pixelSizeY !== null && Math.abs(pixelSizeX - pixelSizeY) > Math.max(pixelSizeX, pixelSizeY) * 1e-6;
  return {
    channelLabels,
    sizeC: Number(pixels.getAttribute('SizeC')) || channelLabels.length || 1,
    sizeZ: Number(pixels.getAttribute('SizeZ')) || 1,
    sizeT: Number(pixels.getAttribute('SizeT')) || 1,
    significantBits: Number(pixels.getAttribute('SignificantBits')) || null,
    pixelSizeUm: anisotropic ? null : pixelSizeX ?? pixelSizeY,
    pixelSizeWarning: anisotropic ? `X/Y 像素尺寸不同（${pixelSizeX} / ${pixelSizeY} µm）；已停用自动 µm 正方形与比例尺，请手动核对。` : null,
  };
}

function rgbChannels(red: NumericArray, green: NumericArray, blue: NumericArray, bits = 8) {
  return [
    makeChannel(RGB_COMPONENTS[0].id, RGB_COMPONENTS[0].label, red, bits, RGB_COMPONENTS[0].color),
    makeChannel(RGB_COMPONENTS[1].id, RGB_COMPONENTS[1].label, green, bits, RGB_COMPONENTS[1].color),
    makeChannel(RGB_COMPONENTS[2].id, RGB_COMPONENTS[2].label, blue, bits, RGB_COMPONENTS[2].color),
  ];
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
  const rgb = rgbChannels(red, green, blue);
  const collapsed = collapsePseudocolor(rgb);
  const extension = file.name.split('.').pop()?.toUpperCase() || 'IMAGE';
  const warnings = /jpe?g/i.test(file.type) || /\.jpe?g$/i.test(file.name)
    ? ['JPEG 为有损 8-bit 图像，仅建议用于展示和探索性处理。']
    : ['浏览器解码后的 8-bit 展示数据；严肃定量优先使用原始 OME-TIFF 或 OIR。'];
  if (collapsed) warnings.push('检测到单色伪彩/灰度 RGB，已还原为一个 8-bit 信号通道。');
  else warnings.push(RGB_COMPOSITE_WARNING);
  return {
    fileName: file.name,
    sourceFiles: [file.name],
    format: collapsed ? `${extension}（单通道展示图）` : `RGB ${extension}（合并展示图）`,
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
  const rgbComposite = !ome && photometric === 2;
  if (ome && (ome.sizeZ > 1 || ome.sizeT > 1)) {
    throw new Error(`检测到 OME-TIFF Z=${ome.sizeZ}、T=${ome.sizeT}。当前页面仅读取二维 OME-TIFF；请上传二维投影，或直接上传原始 OIR 由网页生成 MIP。`);
  }
  const channels: ChannelData[] = [];
  const warnings: string[] = [];

  if (sampleCount > 1) {
    if (rgbComposite) {
      if (sampleCount < 3) throw new Error(`RGB TIFF 仅含 ${sampleCount} 个样本，无法构成完整 RGB 展示图。`);
      const rasters = await first.readRasters({ samples: [0, 1, 2] }) as unknown as NumericArray[];
      const bits = first.getBitsPerSample(0);
      channels.push(...rgbChannels(rasters[0], rasters[1], rasters[2], bits));
      if (sampleCount > 3) warnings.push(`RGB TIFF 还含 ${sampleCount - 3} 个额外样本，通常为 Alpha/ExtraSamples；未将其当作荧光通道。`);
    } else {
      const count = Math.min(MAX_CHANNELS, sampleCount);
      const rasters = await first.readRasters({ samples: Array.from({ length: count }, (_, index) => index) }) as unknown as NumericArray[];
      for (let i = 0; i < count; i++) {
        const bits = ome?.significantBits ?? first.getBitsPerSample(i);
        channels.push(makeChannel(`sample-${i + 1}`, ome?.channelLabels[i] || `通道 ${i + 1}`, rasters[i], bits));
      }
      if (!ome) warnings.push(`文件含 ${sampleCount} 个独立样本；请确认它们与荧光通道的对应关系。`);
      if (sampleCount > MAX_CHANNELS) warnings.push(`文件含 ${sampleCount} 个样本，仅载入前 ${MAX_CHANNELS} 个。`);
    }
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
      channels.push(makeChannel(`page-${i + 1}`, ome?.channelLabels[i] || (pageCount === 1 ? '灰度 / Gray' : `通道 ${i + 1}`), rasters[0], bits));
    }
    if (!ome && pageCount > 1) warnings.push(`文件含 ${pageCount} 个灰度页面，已按独立通道读取；请确认页面与通道顺序。`);
    if (expectedChannels > MAX_CHANNELS) warnings.push(`文件含 ${expectedChannels} 个通道，仅载入前 ${MAX_CHANNELS} 个。`);
  }
  if (!channels.length) throw new Error('TIFF 中没有可读取的像素通道。');

  const collapsed = rgbComposite ? collapsePseudocolor(channels) : null;
  const finalChannels = collapsed ? [collapsed] : channels;
  if (collapsed) warnings.push('检测到单色伪彩 RGB TIFF，已还原为一个信号通道；8-bit 文件仅建议探索性定量。');
  else if (rgbComposite) warnings.push(RGB_COMPOSITE_WARNING);
  if (ome) warnings.push(`已读取 OME 元数据：${ome.sizeC} 通道，Z=${ome.sizeZ}，T=${ome.sizeT}。`);
  if (ome?.pixelSizeWarning) warnings.push(ome.pixelSizeWarning);
  if (!ome?.pixelSizeUm) warnings.push('未读取到显微镜像素尺寸。DPI 不能代替标定；添加 µm 比例尺前请填写像素尺寸（µm/px）。');
  if (finalChannels.some(channel => channel.bitDepth > 8)) warnings.push('分析使用 TIFF 原始位深；显示预览单独缩放，不改变数值。');
  return {
    fileName: file.name,
    sourceFiles: [file.name],
    format: ome ? 'OME-TIFF' : collapsed ? 'TIFF（单通道伪彩展示图）' : rgbComposite ? 'RGB TIFF（合并展示图）' : 'TIFF',
    width,
    height,
    channels: finalChannels,
    hash: await sha256(buffer),
    pageCount,
    pixelSizeUm: ome?.pixelSizeUm ?? null,
    displayOnly: Boolean(collapsed || rgbComposite),
    warnings,
  };
}

async function loadOir(file: File, buffer: ArrayBuffer): Promise<LoadedImage> {
  const parsed = parseOir(buffer);
  return {
    fileName: file.name,
    sourceFiles: [file.name],
    format: parsed.projection === 'max' ? `Olympus OIR · Z=${parsed.sizeZ} MIP` : 'Olympus OIR',
    width: parsed.width,
    height: parsed.height,
    channels: parsed.channels.map(channel => makeChannel(channel.id, channel.label, channel.data, parsed.bitDepth, channel.lut)),
    hash: await sha256(buffer),
    pageCount: parsed.channels.length,
    pixelSizeUm: parsed.pixelSizeUm,
    displayOnly: false,
    warnings: [
      `已在浏览器本地直接读取 OIR：${parsed.channels.length} 通道，${parsed.bitDepth}-bit；原图未上传服务器。`,
      ...(parsed.projection === 'max' ? [`检测到 ${parsed.sizeZ} 层 Z-stack，已对每个通道生成最大强度投影（MIP）；导出结果会记录此处理。`] : []),
      ...(parsed.discardedTrailingZ ? [`采集末尾有 ${parsed.discardedTrailingZ} 个未完成的 Z 层，已按 Bio-Formats 的完整层规则忽略。`] : []),
      ...(parsed.declaredSizeZ !== null && parsed.declaredSizeZ > parsed.sizeZ ? [`采集元数据计划 ${parsed.declaredSizeZ} 层 Z，当前文件只有 ${parsed.sizeZ} 个完整层；这可能是中断采集，也可能缺少伴随文件。请确认同目录没有同名 _00001、_00002 等文件后再定量。此警告会写入导出结果。`] : []),
      ...(parsed.pixelSizeWarning ? [parsed.pixelSizeWarning] : []),
      '仅支持同目录不存在同名 _00001、_00002 等伴随文件的单文件 OIR；元数据层数与完整层数不一致时会在质控和导出中明确警告。',
      '当前直接读取模式已针对 Olympus FV3000 未压缩 OIR 验证；未知布局会停止分析，不会猜测像素顺序。',
    ],
  };
}

export async function loadImage(file: File): Promise<LoadedImage> {
  if (/\.zip$/i.test(file.name)) {
    throw new Error('请先解压 ZIP，再直接选择其中一个 .oir 文件；不需要打开 ImageJ。若同目录还有同名 _00001、_00002 等伴随文件，当前网页暂不支持这套采集。');
  }
  const buffer = await file.arrayBuffer();
  if (/\.oir$/i.test(file.name)) return loadOir(file, buffer);
  const isTiff = /tiff?/i.test(file.type) || /\.tiff?$/i.test(file.name);
  return isTiff ? loadTiff(file, buffer) : loadStandard(file, buffer);
}

export async function loadImages(files: File[]): Promise<LoadedImage> {
  if (!files.length) throw new Error('请选择图像文件。');
  if (files.length > MAX_FILES) throw new Error(`一次最多组合 ${MAX_FILES} 个分通道文件。`);
  const oir = files.filter(file => /\.oir$/i.test(file.name));
  if (oir.length) {
    if (files.length > 1) throw new Error('OIR 请一次选择一个文件；同一次采集的通道已包含在这个 OIR 内。');
    return loadImage(oir[0]);
  }
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
  warnings.push(`已把 ${loaded.length} 个同尺寸文件作为对齐输入组合。每个单通道文件会保留为独立可调色通道；网页不会执行自动配准。`);
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
