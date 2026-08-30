import type { NumericArray } from './analysis';

// OIR block layout and terminology follow oirfile (BSD-3-Clause):
// https://github.com/cgohlke/oirfile

export interface ParsedOirChannel {
  id: string;
  label: string;
  lut: string | null;
  data: NumericArray;
}

export interface ParsedOir {
  width: number;
  height: number;
  bitDepth: number;
  pixelSizeUm: number | null;
  pixelSizeWarning: string | null;
  channels: ParsedOirChannel[];
  blockCount: number;
  sizeZ: number;
  sizeT: number;
  projection: 'none' | 'max';
  discardedTrailingZ: number;
  declaredSizeZ: number | null;
}

interface PixelBlock {
  uid: string;
  channelId: string;
  index: number;
  start: number;
  length: number;
  z: number;
  t: number;
  lambda: number;
}

const MAGIC = 'OLYMPUSRAWFORMAT';
const decoder = new TextDecoder('ascii');
const encoder = new TextEncoder();

const ascii = (bytes: Uint8Array, start: number, length: number) => decoder.decode(bytes.subarray(start, start + length));

function findBytes(bytes: Uint8Array, pattern: Uint8Array, from = 0) {
  for (let at = bytes.indexOf(pattern[0], from); at >= 0; at = bytes.indexOf(pattern[0], at + 1)) {
    let matched = true;
    for (let i = 1; i < pattern.length; i++) {
      if (bytes[at + i] !== pattern[i]) { matched = false; break; }
    }
    if (matched) return at;
  }
  return -1;
}

function xmlDocuments(bytes: Uint8Array) {
  const documents: string[] = [];
  const marker = encoder.encode('<?xml');
  const declarationEnd = encoder.encode('?>');
  let from = 0;
  while (from < bytes.length) {
    const start = findBytes(bytes, marker, from);
    if (start < 0) break;
    const declaration = findBytes(bytes, declarationEnd, start + marker.length);
    if (declaration < 0) break;
    let root = declaration + declarationEnd.length;
    while (root < bytes.length && bytes[root] !== 60) root++;
    const opening = ascii(bytes, root + 1, Math.min(256, bytes.length - root - 1));
    const name = opening.match(/^([A-Za-z_][\w:.-]*)[\s>]/)?.[1];
    if (!name) { from = declaration + 2; continue; }
    const close = encoder.encode(`</${name}>`);
    const closing = findBytes(bytes, close, root + name.length + 2);
    if (closing < 0) { from = declaration + 2; continue; }
    const end = closing + close.length;
    documents.push(ascii(bytes, start, end - start));
    from = end;
  }
  return documents;
}

function pixelBlocks(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const blocks: PixelBlock[] = [];
  for (let offset = 16; offset + 32 < bytes.length;) {
    if (view.getUint32(offset + 4, true) !== 3) { offset++; continue; }
    const checkLength = view.getUint32(offset, true);
    const uidLength = view.getUint32(offset + 16, true);
    if (uidLength < 4 || uidLength > 512 || checkLength !== uidLength + 12 || offset + 28 + uidLength > bytes.length) {
      offset++;
      continue;
    }
    const uid = ascii(bytes, offset + 20, uidLength);
    const length = view.getUint32(offset + 20 + uidLength, true);
    const start = offset + 28 + uidLength;
    if (!/^[\x20-\x7e]+$/.test(uid) || length < 1 || start + length > bytes.length) { offset++; continue; }
    const dimension = uid.match(/^(?:l(\d{3}))?(?:z(\d{3})(?:t(\d+))?|t(\d+))_/);
    if (dimension) {
      const parts = uid.split('_');
      const index = Number(parts.at(-1));
      const channelId = parts.at(-2) || '';
      if (channelId && Number.isInteger(index) && index >= 0) blocks.push({
        uid,
        channelId,
        index,
        start,
        length,
        lambda: Number(dimension[1] || 1),
        z: Number(dimension[2] || 1),
        t: Number(dimension[3] || dimension[4] || 1),
      });
    }
    offset = start + length;
  }
  return blocks;
}

const numberTag = (xml: string, localName: string) => {
  const match = xml.match(new RegExp(`<(?:[\\w.-]+:)?${localName}>\\s*([+\\-\\d.eE]+)\\s*</(?:[\\w.-]+:)?${localName}>`));
  const value = Number(match?.[1]);
  return Number.isFinite(value) ? value : null;
};

function activeAxisMaxSize(documents: string[], axisType: 'ZSTACK' | 'TIMELAPSE' | 'LAMBDA') {
  const prefix = '(?:[\\w.-]+:)?';
  const pattern = new RegExp(
    `<${prefix}axis\\b(?=[^>]*\\benable="true")(?![^>]*\\bparamEnable="false")[^>]*>`
      + `\\s*<${prefix}axis>\\s*${axisType}\\s*</${prefix}axis>`
      + `[\\s\\S]{0,2000}?<${prefix}maxSize>\\s*(\\d+)\\s*</${prefix}maxSize>`,
  );
  for (const xml of documents) {
    const value = Number(xml.match(pattern)?.[1]);
    if (Number.isInteger(value) && value >= 0) return value;
  }
  return null;
}

function channelMetadata(documents: string[], id: string, fallback: string) {
  let best = '';
  let score = -1;
  let lut: string | null = null;
  let order: number | null = null;
  const token = `id="${id}"`;
  for (const xml of documents) {
    for (let position = xml.indexOf(token); position >= 0; position = xml.indexOf(token, position + token.length)) {
      const open = xml.lastIndexOf('<', position);
      const openEnd = xml.indexOf('>', position);
      const tagName = xml.slice(open + 1, openEnd).match(/^([\w.-]+:)?channel\b/)?.[0].replace(/\s.*$/, '');
      if (!tagName) continue;
      const close = `</${tagName}>`;
      const end = xml.indexOf(close, openEnd);
      if (end < 0) continue;
      const section = xml.slice(open, end + close.length);
      const dye = section.match(/<(?:[\w.-]+:)?dyeName>\s*([^<]+?)\s*<\//)?.[1]?.trim();
      const device = section.match(/<(?:[\w.-]+:)?deviceName>\s*([^<]+?)\s*<\//)?.[1]?.trim();
      const name = section.match(/<(?:[\w.-]+:)?name>\s*([^<]+?)\s*<\//)?.[1]?.trim();
      const candidate = dye || device || name || '';
      const candidateScore = dye ? 3 : device ? 2 : name ? 1 : 0;
      if (candidate && candidateScore > score) { best = candidate; score = candidateScore; }
      lut ??= section.match(/<(?:[\w.-]+:)?lut>\s*([^<]+?)\s*<\//)?.[1]?.trim() || null;
      const parsedOrder = Number(xml.slice(open, openEnd).match(/\border="(\d+)"/)?.[1]);
      if (order === null && Number.isInteger(parsedOrder)) order = parsedOrder;
    }
  }
  return { label: best || fallback, lut, order };
}

function readPlane(bytes: Uint8Array, view: DataView, blocks: PixelBlock[], bytesPerSample: number, pixels: number): NumericArray {
  const sorted = [...blocks].sort((a, b) => a.index - b.index);
  if (sorted.some((block, index) => block.index !== index)) throw new Error('OIR 像素块编号不连续，已停止定量以避免误读。');
  if (sorted.some(block => block.length % bytesPerSample !== 0)) throw new Error('OIR 像素块长度与位深不一致。');
  let target = 0;
  if (bytesPerSample === 1) {
    const output = new Uint8Array(pixels);
    for (const block of sorted) { output.set(bytes.subarray(block.start, block.start + block.length), target); target += block.length; }
    return output;
  }
  const output = new Uint16Array(pixels);
  for (const block of sorted) {
    for (let source = block.start; source < block.start + block.length; source += 2) output[target++] = view.getUint16(source, true);
  }
  return output;
}

function maxProjection(bytes: Uint8Array, view: DataView, planes: PixelBlock[][], bytesPerSample: number, pixels: number) {
  const output = readPlane(bytes, view, planes[0], bytesPerSample, pixels) as Uint8Array | Uint16Array;
  for (let planeIndex = 1; planeIndex < planes.length; planeIndex++) {
    const plane = readPlane(bytes, view, planes[planeIndex], bytesPerSample, pixels) as Uint8Array | Uint16Array;
    for (let pixel = 0; pixel < output.length; pixel++) if (plane[pixel] > output[pixel]) output[pixel] = plane[pixel];
  }
  return output;
}

export function parseOir(buffer: ArrayBuffer): ParsedOir {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 64 || ascii(bytes, 0, 16) !== MAGIC) throw new Error('这不是有效的 Olympus OIR 文件。');
  if (bytes.length > 512 * 1024 * 1024) throw new Error('当前网页最多直接读取 512 MB 的单个 OIR；更大的文件需要后续启用服务器兼容模式。');

  const documents = xmlDocuments(bytes);
  const frame = documents.find(xml => /<(?:[\w.-]+:)?frameProperties\b/.test(xml)) || '';
  const width = numberTag(frame, 'width');
  const height = numberTag(frame, 'height');
  const bitDepth = numberTag(frame, 'bitCounts');
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error('OIR 中缺少可验证的图像宽高。');

  const blocks = pixelBlocks(bytes);
  if (!blocks.length) throw new Error('OIR 中没有找到未压缩的原始像素块；该文件可能是暂不支持的变体。');
  const z = new Set(blocks.map(block => block.z));
  const t = new Set(blocks.map(block => block.t));
  const lambda = new Set(blocks.map(block => block.lambda));
  const declaredZMax = activeAxisMaxSize(documents, 'ZSTACK');
  const declaredTMax = activeAxisMaxSize(documents, 'TIMELAPSE');
  const declaredLambdaMax = activeAxisMaxSize(documents, 'LAMBDA');
  if (declaredTMax !== null || declaredLambdaMax !== null || t.size > 1 || lambda.size > 1) {
    throw new Error(`检测到多维 OIR（T=${declaredTMax === null ? t.size : declaredTMax + 1}、光谱=${declaredLambdaMax === null ? lambda.size : declaredLambdaMax + 1}）；该文件需要后续启用服务器兼容模式。`);
  }

  const grouped = new Map<string, Map<number, PixelBlock[]>>();
  for (const block of blocks) {
    const channel = grouped.get(block.channelId) || new Map<number, PixelBlock[]>();
    const plane = channel.get(block.z) || [];
    plane.push(block);
    channel.set(block.z, plane);
    grouped.set(block.channelId, channel);
  }
  if (grouped.size > 12) throw new Error(`OIR 含 ${grouped.size} 个通道；当前页面最多读取 12 个。`);
  const pixels = width * height;
  const allTotals = [...grouped.values()].flatMap(channel => [...channel.values()].map(plane => plane.reduce((sum, block) => sum + block.length, 0)));
  const totalCounts = new Map<number, number>();
  for (const total of allTotals) totalCounts.set(total, (totalCounts.get(total) || 0) + 1);
  const modalTotal = [...totalCounts].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  const metadataBytes = bitDepth ? Math.ceil(bitDepth / 8) : 0;
  const expectedTotal = metadataBytes === 1 || metadataBytes === 2 ? pixels * metadataBytes : modalTotal;
  if (!expectedTotal || expectedTotal % pixels !== 0) throw new Error('OIR 像素长度与图像尺寸不一致。');
  const orderedZ = [...z].sort((a, b) => a - b);
  const completeZ = orderedZ.filter(zIndex => [...grouped.values()].every(channel => {
    const plane = channel.get(zIndex);
    return plane && plane.reduce((sum, block) => sum + block.length, 0) === expectedTotal;
  }));
  if (!completeZ.length) throw new Error('OIR 中没有完整的图像层。');
  const firstIncomplete = orderedZ.findIndex(zIndex => !completeZ.includes(zIndex));
  if (firstIncomplete >= 0 && orderedZ.slice(firstIncomplete).some(zIndex => completeZ.includes(zIndex))) {
    throw new Error('OIR 中间存在不完整的 Z 层，已停止定量以避免层错位。');
  }
  const bytesPerSample = expectedTotal / pixels;
  if (bytesPerSample !== 1 && bytesPerSample !== 2) throw new Error(`OIR 使用 ${bytesPerSample * 8}-bit 存储；当前浏览器读取器仅支持 8/16-bit 灰度通道。`);
  const effectiveBits = bitDepth && bitDepth > 0 && bitDepth <= bytesPerSample * 8 ? bitDepth : bytesPerSample * 8;
  const view = new DataView(buffer);
  const channels = [...grouped.entries()].map(([id, channel], index) => {
    const planes = completeZ.map(zIndex => channel.get(zIndex)!);
    const metadata = channelMetadata(documents, id, `通道 ${index + 1}`);
    return {
      id,
      label: metadata.label,
      lut: metadata.lut,
      order: metadata.order,
      fallbackOrder: index,
      data: planes.length === 1 ? readPlane(bytes, view, planes[0], bytesPerSample, pixels) : maxProjection(bytes, view, planes, bytesPerSample, pixels),
    };
  }).sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.fallbackOrder - b.fallbackOrder)
    .map(channel => ({ id: channel.id, label: channel.label, lut: channel.lut, data: channel.data }));

  const length = documents.map(xml => xml.match(/<(?:[\w.-]+:)?length\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?length>/)?.[1]).find(Boolean);
  const axis = (name: 'x' | 'y') => Number(length?.match(new RegExp(`<(?:[\\w.-]+:)?${name}>\\s*([+\\-\\d.eE]+)`))?.[1]);
  const nanometers = documents.some(xml => /<(?:[\w.-]+:)?pixelUnit>[\s\S]*?NANO_METER[\s\S]*?<\/(?:[\w.-]+:)?pixelUnit>/.test(xml));
  const convertPixelSize = (value: number) => Number.isFinite(value) && value > 0 ? (nanometers ? value / 1000 : value) : null;
  const pixelSizeX = convertPixelSize(axis('x'));
  const pixelSizeY = convertPixelSize(axis('y'));
  const anisotropic = pixelSizeX !== null && pixelSizeY !== null && Math.abs(pixelSizeX - pixelSizeY) > Math.max(pixelSizeX, pixelSizeY) * 1e-6;
  return {
    width,
    height,
    bitDepth: effectiveBits,
    pixelSizeUm: anisotropic ? null : pixelSizeX ?? pixelSizeY,
    pixelSizeWarning: anisotropic ? `X/Y 像素尺寸不同（${pixelSizeX} / ${pixelSizeY} µm）；已停用自动 µm 正方形与比例尺，请手动核对。` : null,
    channels,
    blockCount: blocks.length,
    sizeZ: completeZ.length,
    sizeT: t.size,
    projection: completeZ.length > 1 ? 'max' : 'none',
    discardedTrailingZ: orderedZ.length - completeZ.length,
    declaredSizeZ: declaredZMax === null ? null : declaredZMax + 1,
  };
}
