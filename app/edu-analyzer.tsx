'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChannelData, NumericArray } from '../lib/analysis';
import { loadImages, type LoadedImage } from '../lib/image';
import type { EduParameters, EduResult } from '../lib/edu';
import './edu.css';

type Field = { id: string; name: string; group: string; files: File[] };
type Revision = 'positive' | 'negative' | 'exclude';
type Exclusion = { enabled: boolean; width: number; height: number };
type RecordResult = {
  field: string; group: string; sourceFiles: string[]; sourceHash: string; hashKind: string;
  width: number; height: number; displayOnly: boolean; synthetic: boolean; reviewed: boolean;
  channels: { nucleus: string; edu: string }; parameters: EduParameters; uiParameters: EduParameters;
  exclusion: Exclusion; revisions: Record<number, Revision>; nuclei: EduResult['nuclei']; warnings: string[];
  timestamp: string; signature: string;
};
const INITIAL: EduParameters = { nucleusThreshold: 28, eduThreshold: 36, minArea: 45, maxArea: 8000, median: true, excludeEdge: true, minPositiveFraction: 0.2 };
const INITIAL_EXCLUSION: Exclusion = { enabled: true, width: 128, height: 48 };
const SUPPORTED = /\.(tiff?|png|jpe?g|oir)$/i;
const DISPLAY_CHANNELS = ['DAPI', 'RED', 'Merge'] as const;
const pause = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

function groupFiles(files: File[]): Field[] {
  const grouped = new Map<string, Field>();
  for (const file of files.filter(file => SUPPORTED.test(file.name))) {
    const path = file.webkitRelativePath || file.name;
    if (path.split('/').slice(0, -1).some(part => /^(metadata|node_modules|\.git|_audit|ifa|pages-dist|dist|public)$/i.test(part))) continue;
    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const stem = file.name.replace(/\.[^.]+$/, '').replace(/_ch\d+$/i, '');
    const id = directory + stem;
    const field = grouped.get(id) ?? { id, name: id, group: directory.replace(/\/$/, '') || '未指定样本', files: [] };
    field.files.push(file); grouped.set(id, field);
  }
  return [...grouped.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })).map(field => {
    const merge = field.files.filter(file => !/_ch\d+\.[^.]+$/i.test(file.name));
    return { ...field, files: merge.length ? [merge.sort((a, b) => Number(/\.tiff?$/i.test(b.name)) - Number(/\.tiff?$/i.test(a.name)))[0]] : field.files.sort((a, b) => a.name.localeCompare(b.name)) };
  });
}
function inferChannels(image: LoadedImage): [number, number] {
  const strongest = (color: string) => {
    let selected = -1, best = -1;
    image.channels.forEach((channel, index) => {
      if (channel.sourceColor !== color && channel.id !== color) return;
      let signal = 0;
      for (let i = 0; i < channel.data.length; i += Math.max(1, Math.floor(channel.data.length / 50000))) signal += channel.data[i] / channel.maxValue;
      if (signal > best) { best = signal; selected = index; }
    });
    return selected;
  };
  const blue = strongest('blue'), red = strongest('red');
  // Multi-file channel numbers are deliberately not interpreted as fluorescence identities.
  return [blue >= 0 ? blue : 0, red >= 0 ? red : Math.min(1, image.channels.length - 1)];
}
function counts(nuclei: EduResult['nuclei'], revisions: Record<number, Revision>) {
  let total = 0, positive = 0;
  for (const nucleus of nuclei) {
    const revision = revisions[nucleus.id];
    if (revision === 'exclude') continue;
    total++;
    if (revision === 'positive' || (!revision && nucleus.positive)) positive++;
  }
  return { total, positive, negative: total - positive, positivePct: total ? positive / total * 100 : null };
}
function csv(rows: unknown[][]) {
  return '\ufeff' + rows.map(row => row.map(value => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+@\-]/.test(text) && typeof value !== 'number') text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function demoImage(): LoadedImage {
  const width = 900, height = 600, red = new Uint8Array(width * height), blue = new Uint8Array(width * height);
  let seed = 46;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let index = 0; index < red.length; index++) { red[index] = Math.floor(random() * 12); blue[index] = Math.floor(random() * 10); }
  for (let object = 0; object < 40; object++) {
    const cx = 55 + (object % 8) * 112 + random() * 12, cy = 57 + Math.floor(object / 8) * 115 + random() * 12;
    const rx = 15 + random() * 6, ry = 18 + random() * 7;
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const distance = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (distance < 1) { blue[y * width + x] = 70 + Math.floor(140 * (1 - distance)); if (object % 3 === 0) red[y * width + x] = 55 + Math.floor(140 * (1 - distance)); }
    }
  }
  for (let i = 0; i < 1800; i++) { const pixel = Math.floor(random() * red.length); if (i % 2) red[pixel] = 90; else blue[pixel] = 90; }
  const channel = (id: string, data: Uint8Array): ChannelData => ({ id, data, label: id === 'red' ? '合成 EdU / R' : '合成细胞核 / B', maxValue: 255, bitDepth: 8, integer: true });
  return { fileName: '合成演示 · 40 个核 / 14 个 EdU+', sourceFiles: ['synthetic-demo'], format: '合成演示', width, height, channels: [channel('red', red), channel('blue', blue)], hash: 'synthetic-v1-seed46', pageCount: 1, pixelSizeUm: null, displayOnly: false, warnings: ['合成演示用于功能检查，不代表真实实验或算法验证。'] };
}
function compute<T>(payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../lib/edu.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => { worker.terminate(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data); };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || '图像处理失败')); };
    worker.postMessage(payload);
  });
}

export default function EduAnalyzer() {
  const [fields, setFields] = useState<Field[]>([]), [index, setIndex] = useState(-1);
  const [image, setImage] = useState<LoadedImage | null>(null), [isDemo, setIsDemo] = useState(false);
  const [nucleusIndex, setNucleusIndex] = useState(0), [eduIndex, setEduIndex] = useState(1);
  const [parameters, setParameters] = useState<EduParameters>(INITIAL), [exclusion, setExclusion] = useState<Exclusion>(INITIAL_EXCLUSION);
  const [redFloor, setRedFloor] = useState(16), [blueFloor, setBlueFloor] = useState(0), [speckle, setSpeckle] = useState(12);
  const [blueSpeckle, setBlueSpeckle] = useState(1), [protectNuclear, setProtectNuclear] = useState(true), [onlyNuclear, setOnlyNuclear] = useState(false);
  const [exportChannels, setExportChannels] = useState<'merge' | 'red' | 'blue'>('merge');
  const [cleaned, setCleaned] = useState<{ nucleus: NumericArray; edu: NumericArray } | null>(null);
  const [result, setResult] = useState<EduResult | null>(null), [revisions, setRevisions] = useState<Record<number, Revision>>({});
  const [records, setRecords] = useState<Record<string, RecordResult>>({});
  const [view, setView] = useState<'raw' | 'clean' | 'mask'>('raw'), [zoom, setZoom] = useState('fit');
  const [busy, setBusy] = useState(''), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false), [group, setGroup] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]), folderInput = useRef<HTMLInputElement>(null), filesInput = useRef<HTMLInputElement>(null);
  const imagePanes = useRef<Array<HTMLDivElement | null>>([]);
  const expectedScroll = useRef(new WeakMap<HTMLDivElement, { left: number; top: number }>());
  const scrollPosition = useRef({ x: 0, y: 0 });
  const channelDetails = useRef<HTMLDetailsElement>(null);
  const loadToken = useRef(0);
  const nucleus = image?.channels[nucleusIndex], edu = image?.channels[eduIndex];
  const preservedGreen = image?.sourceFiles.length === 1 && nucleus?.id === 'blue' && edu?.id === 'red' ? image.channels.find(channel => channel.id === 'green') : undefined;
  const currentId = isDemo ? 'synthetic-demo' : fields[index]?.id;
  const signature = JSON.stringify({ parameters, exclusion, nucleus: nucleus?.id, edu: edu?.id });
  const totals = useMemo(() => result ? counts(result.nuclei, revisions) : null, [result, revisions]);
  const saved = Object.values(records), currentSaved = currentId ? records[currentId] : undefined;

  const invalidate = () => {
    setResult(null); setRevisions({}); setSelected(null);
    if (currentId) setRecords(old => { const next = { ...old }; delete next[currentId]; return next; });
  };
  const setParameter = (key: keyof EduParameters, value: number | boolean) => { setParameters(old => ({ ...old, [key]: value })); setCleaned(null); invalidate(); };
  const changeExclusion = (change: Partial<Exclusion>) => { setExclusion(old => ({ ...old, ...change })); invalidate(); };
  const changeChannel = (which: 'nucleus' | 'edu', value: number) => { (which === 'nucleus' ? setNucleusIndex : setEduIndex)(value); setCleaned(null); invalidate(); };

  async function openField(queue: Field[], selectedIndex: number) {
    const token = ++loadToken.current;
    scrollPosition.current = { x: 0, y: 0 };
    if (isDemo) setExclusion(INITIAL_EXCLUSION);
    setBusy('正在读取图像…'); setError(''); setImage(null); setResult(null); setCleaned(null); setRevisions({}); setSelected(null); setAcknowledged(false); setView('raw'); setIsDemo(false); setIndex(selectedIndex);
    try {
      const loaded = await loadImages(queue[selectedIndex].files);
      if (token !== loadToken.current) return;
      const [blue, red] = inferChannels(loaded);
      setNucleusIndex(blue); setEduIndex(red); setImage(loaded); setGroup(queue[selectedIndex].group);
      if (queue[selectedIndex].files.length > 1) { setMessage('分通道图：请核对通道设置。'); if (channelDetails.current) channelDetails.current.open = true; }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (token === loadToken.current) setBusy(''); }
  }
  async function importFiles(input: FileList | null) {
    if (!input?.length) return;
    const files = Array.from(input), queue = groupFiles(files);
    const skipped = files.filter(file => !SUPPORTED.test(file.name)).length;
    if (!queue.length) { setError(files.some(file => /\.lif$/i.test(file.name)) ? 'LIF 暂不能直接解码。请在 Leica LAS X 或 Fiji/Bio-Formats 导出保留通道的 TIFF，再选择文件夹。' : '没有找到 TIFF、PNG、JPEG 或 OIR 图像。'); return; }
    setFields(queue); setRecords({});
    setMessage(`已导入 ${queue.length} 个视野${skipped ? `，忽略 ${skipped} 个非图像文件` : ''}。`);
    await openField(queue, 0);
  }
  function openDemo() {
    scrollPosition.current = { x: 0, y: 0 }; ++loadToken.current; const demo = demoImage(); setImage(demo); setFields([]); setIndex(-1); setIsDemo(true); setNucleusIndex(1); setEduIndex(0); setParameters(INITIAL); setExclusion({ ...INITIAL_EXCLUSION, enabled: false }); setResult(null); setCleaned(null); setRevisions({}); setRecords({}); setAcknowledged(true); setGroup('合成演示'); setView('raw'); setError(''); setMessage('演示图：40 个核，14 个 EdU 阳性。');
  }
  const nativeParameters = (): EduParameters => ({ ...parameters, nucleusThreshold: parameters.nucleusThreshold / 255 * (nucleus?.maxValue ?? 255), eduThreshold: parameters.eduThreshold / 255 * (edu?.maxValue ?? 255) });
  async function analyze() {
    if (!image || !nucleus || !edu) return;
    if (![parameters.nucleusThreshold, parameters.eduThreshold].every(value => Number.isFinite(value) && value >= 1 && value <= 254) || parameters.minPositiveFraction < 0.01 || parameters.minPositiveFraction > 1) { setError('核与 EdU 阈值需为 1–254；核内阳性像素占比需为 1–100%。'); return; }
    if (nucleusIndex === eduIndex) { if (channelDetails.current) channelDetails.current.open = true; setError('细胞核和 EdU 不能选择同一个通道。'); return; }
    if (image.displayOnly && !acknowledged) { if (channelDetails.current) channelDetails.current.open = true; setError('请在「通道设置」确认 RGB 图仅用于探索性计数。'); return; }
    setBusy('正在分割细胞核并检测核内 EdU…'); setError(''); await pause();
    try {
      let source: NumericArray = nucleus.data;
      if (exclusion.enabled) {
        source = new Float64Array(nucleus.data);
        for (let y = Math.max(0, image.height - exclusion.height); y < image.height; y++) source.fill(0, y * image.width + Math.max(0, image.width - exclusion.width), (y + 1) * image.width);
      }
      const response = await compute<{ result: EduResult }>({ operation: 'analyze', nucleus: source, edu: edu.data, width: image.width, height: image.height, parameters: nativeParameters() });
      setResult(response.result); setRevisions({}); setView('mask'); setSelected(null);
      if (currentId) setRecords(old => { const next = { ...old }; delete next[currentId]; return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(''); }
  }
  async function clean() {
    if (!image || !nucleus || !edu) return;
    if (!Number.isFinite(parameters.nucleusThreshold) || parameters.nucleusThreshold < 1 || parameters.nucleusThreshold > 254) { setError('用于核支持的核阈值需为 1–254。'); return; }
    setBusy('正在生成去杂点展示副本…'); setError(''); await pause();
    try {
      setCleaned(await compute<{ nucleus: NumericArray; edu: NumericArray }>({ operation: 'clean', nucleus: nucleus.data, edu: edu.data, width: image.width, height: image.height, blueFloor: blueFloor / 255 * nucleus.maxValue, blueSpeckle, redOptions: { floor: redFloor / 255 * edu.maxValue, minArea: speckle, nucleusThreshold: parameters.nucleusThreshold / 255 * nucleus.maxValue, nucleusMinArea: parameters.minArea, protectNuclear, onlyNuclear } })); setView('clean');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(''); }
  }
  function saveResult(next = false) {
    if (!result || !image || !nucleus || !edu || !currentId) return;
    const record: RecordResult = { field: currentId, group, sourceFiles: fields[index]?.files.map(file => file.webkitRelativePath || file.name) ?? image.sourceFiles, sourceHash: image.hash, hashKind: image.sourceFiles.length > 1 ? 'SHA256 of newline-joined individual SHA256 hashes in input order' : 'SHA256 of original file', width: image.width, height: image.height, displayOnly: image.displayOnly, synthetic: isDemo, reviewed: true, channels: { nucleus: nucleus.label, edu: edu.label }, parameters: nativeParameters(), uiParameters: parameters, exclusion, revisions, nuclei: result.nuclei, warnings: [...image.warnings, ...result.warnings], timestamp: new Date().toISOString(), signature };
    setRecords(old => ({ ...old, [currentId]: record })); setMessage('已确认。关闭页面前请导出结果。');
    if (next && index + 1 < fields.length) void openField(fields, index + 1);
  }
  function revise(id: number, state?: Revision) {
    setRevisions(old => {
      const updated = { ...old };
      const revision = state ?? (old[id] === undefined ? 'positive' : old[id] === 'positive' ? 'negative' : old[id] === 'negative' ? 'exclude' : undefined);
      if (revision) updated[id] = revision; else delete updated[id];
      return updated;
    });
    setSelected(id);
    if (currentId) setRecords(old => { const next = { ...old }; delete next[currentId]; return next; });
  }
  function exportData(kind: 'summary' | 'cells' | 'json') {
    if (!saved.length) return;
    if (kind === 'json') { download(new Blob([JSON.stringify({ schema: 'fluoroscope-edu-v1', exportedAt: new Date().toISOString(), scope: 'All detected nuclei, including NK; no cell-type discrimination. RGB images exploratory. Fields are not biological replicates.', records: saved.map(record => ({ ...record, counts: counts(record.nuclei, record.revisions) })) }, null, 2)], { type: 'application/json' }), 'EdU_分析记录.json'); return; }
    const rows: unknown[][] = kind === 'summary' ? [['field', 'sample_or_group', 'total_nuclei', 'edu_positive', 'edu_negative', 'edu_positive_pct', 'manual_revisions', 'display_only', 'synthetic', 'source_sha256', 'nucleus_channel', 'edu_channel', 'parameters_native', 'excluded_bottom_right', 'source_files', 'reviewed_at']]
      : [['field', 'sample_or_group', 'object_id', 'x_px', 'y_px', 'area_px', 'edu_mean_native', 'edu_above_threshold_fraction', 'auto_positive', 'manual_revision', 'final_class', 'source_sha256', 'parameters_native', 'nucleus_channel', 'edu_channel', 'excluded_bottom_right', 'synthetic']];
    for (const record of saved) {
      const count = counts(record.nuclei, record.revisions);
      if (kind === 'summary') rows.push([record.field, record.group, count.total, count.positive, count.negative, count.positivePct, Object.keys(record.revisions).length, record.displayOnly, record.synthetic, record.sourceHash, record.channels.nucleus, record.channels.edu, JSON.stringify(record.parameters), JSON.stringify(record.exclusion), record.sourceFiles.join(' | '), record.timestamp]);
      else for (const cell of record.nuclei) rows.push([record.field, record.group, cell.id, cell.x, cell.y, cell.area, cell.eduMean, cell.eduPositiveFraction, cell.positive, record.revisions[cell.id] ?? 'auto', record.revisions[cell.id] ?? (cell.positive ? 'positive' : 'negative'), record.sourceHash, JSON.stringify(record.parameters), record.channels.nucleus, record.channels.edu, JSON.stringify(record.exclusion), record.synthetic]);
    }
    download(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }), kind === 'summary' ? 'EdU_视野汇总.csv' : 'EdU_逐核数据.csv');
  }
  async function exportCleaned() {
    if (!image || !cleaned || !nucleus || !edu) return;
    const output = document.createElement('canvas'); output.width = image.width; output.height = image.height;
    const context = output.getContext('2d'); if (!context) return;
    const pixels = context.createImageData(image.width, image.height);
    for (let i = 0; i < cleaned.edu.length; i++) { pixels.data[i * 4] = exportChannels === 'blue' ? 0 : cleaned.edu[i] / edu.maxValue * 255; pixels.data[i * 4 + 1] = exportChannels === 'merge' && preservedGreen ? preservedGreen.data[i] / preservedGreen.maxValue * 255 : 0; pixels.data[i * 4 + 2] = exportChannels === 'red' ? 0 : cleaned.nucleus[i] / nucleus.maxValue * 255; pixels.data[i * 4 + 3] = 255; }
    context.putImageData(pixels, 0, 0);
    const name = image.fileName.replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 100);
    output.toBlob(blob => { if (blob) download(blob, `${name}_${exportChannels}_display-cleaned.png`); });
    setMessage('已导出展示 PNG；原图保留。参数可在「高级清理」导出。');
  }
  function exportDisplaySettings() {
    if (!image || !nucleus || !edu) return;
    download(new Blob([JSON.stringify({ schema: 'fluoroscope-edu-display-v1', timestamp: new Date().toISOString(), purpose: 'Display derivative only, not for quantitative analysis', sourceFiles: fields[index]?.files.map(file => file.webkitRelativePath || file.name) ?? image.sourceFiles, sourceHash: image.hash, synthetic: isDemo, dimensions: [image.width, image.height], channels: { nucleus: nucleus.label, edu: edu.label }, display: { redFloor, blueFloor, thresholdUiScale: '0..255 normalized to channel full scale', redMinArea: speckle, blueMinArea: blueSpeckle, protectNuclear, onlyNuclear, nucleusSupportThreshold: parameters.nucleusThreshold, nucleusSupportMinArea: parameters.minArea, nucleusFullScale: nucleus.maxValue, eduFullScale: edu.maxValue, exportChannels, greenPreserved: exportChannels === 'merge' && Boolean(preservedGreen), outputBitDepth: 8 }, warnings: image.warnings }, null, 2)], { type: 'application/json' }), 'EdU_display-cleaned_参数.json');
  }

  function syncScroll(source: HTMLDivElement) {
    const expected = expectedScroll.current.get(source);
    if (expected && Math.abs(source.scrollLeft - expected.left) < 1 && Math.abs(source.scrollTop - expected.top) < 1) return;
    const x = source.scrollLeft / Math.max(1, source.scrollWidth - source.clientWidth);
    const y = source.scrollTop / Math.max(1, source.scrollHeight - source.clientHeight);
    scrollPosition.current = { x, y };
    for (const pane of imagePanes.current) {
      if (!pane || pane === source) continue;
      pane.scrollLeft = x * Math.max(0, pane.scrollWidth - pane.clientWidth);
      pane.scrollTop = y * Math.max(0, pane.scrollHeight - pane.clientHeight);
      expectedScroll.current.set(pane, { left: pane.scrollLeft, top: pane.scrollTop });
    }
  }

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      for (const pane of imagePanes.current) {
        if (!pane) continue;
        pane.scrollLeft = scrollPosition.current.x * Math.max(0, pane.scrollWidth - pane.clientWidth);
        pane.scrollTop = scrollPosition.current.y * Math.max(0, pane.scrollHeight - pane.clientHeight);
        expectedScroll.current.set(pane, { left: pane.scrollLeft, top: pane.scrollTop });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [zoom, image]);

  useEffect(() => {
    if (!image || !nucleus || !edu) return;
    const contexts = canvases.current.map(target => {
      if (!target) return null;
      target.width = image.width; target.height = image.height;
      return target.getContext('2d');
    });
    const first = contexts[0]; if (!first) return;
    // Reuse one full-resolution RGBA buffer across all three channel views.
    const pixels = first.createImageData(image.width, image.height);
    const blue = view === 'clean' && cleaned ? cleaned.nucleus : nucleus.data;
    const red = view === 'clean' && cleaned ? cleaned.edu : edu.data;
    const labels = view === 'mask' ? result?.labels : null;
    const classification = new Uint8Array((result?.nuclei.length ?? 0) + 1);
    if (result) for (const cell of result.nuclei) classification[cell.id] = revisions[cell.id] === 'exclude' ? 3 : revisions[cell.id] === 'positive' || (!revisions[cell.id] && cell.positive) ? 1 : 2;
    contexts.forEach((context, panel) => {
      if (!context) return;
      const merge = panel === 2;
      for (let i = 0; i < red.length; i++) {
        const at = i * 4;
        pixels.data[at] = panel === 0 ? 0 : red[i] / edu.maxValue * 255;
        pixels.data[at + 1] = merge && preservedGreen ? preservedGreen.data[i] / preservedGreen.maxValue * 255 : 0;
        pixels.data[at + 2] = panel === 1 ? 0 : blue[i] / nucleus.maxValue * 255;
        pixels.data[at + 3] = 255;
        const label = merge ? labels?.[i] ?? 0 : 0;
        if (label && (i % image.width === 0 || i % image.width === image.width - 1 || i < image.width || i >= red.length - image.width || labels![i - 1] !== label || labels![i + 1] !== label || labels![i - image.width] !== label || labels![i + image.width] !== label)) {
          const state = classification[label]; pixels.data[at] = state === 1 ? 255 : state === 3 ? 150 : 40; pixels.data[at + 1] = state === 1 ? 211 : state === 3 ? 150 : 240; pixels.data[at + 2] = state === 1 ? 40 : state === 3 ? 150 : 205;
        }
      }
      context.putImageData(pixels, 0, 0);
      if (!merge || view !== 'mask') return;
      if (exclusion.enabled) {
        const w = Math.min(image.width, exclusion.width), h = Math.min(image.height, exclusion.height);
        context.fillStyle = '#ffffff28'; context.fillRect(image.width - w, image.height - h, w, h); context.strokeStyle = '#ff9a4f'; context.lineWidth = 3; context.strokeRect(image.width - w, image.height - h, w, h);
      }
      if (result) {
        context.font = `${Math.max(11, Math.round(image.width / 220))}px sans-serif`; context.textAlign = 'center';
        for (const cell of result.nuclei) { context.fillStyle = cell.id === selected ? '#ffffff' : '#fff9'; context.fillText(String(cell.id), cell.x, cell.y); }
      }
    });
  }, [image, nucleus, edu, preservedGreen, view, cleaned, result, revisions, selected, exclusion]);
  const selectedCell = result?.nuclei.find(cell => cell.id === selected);
  const fieldLabel = isDemo ? '合成演示' : `${index + 1} / ${fields.length}`;
  return <div className="edu-app edu-compact edu-three">
    <header className="edu-header"><a className="edu-brand" href="../"><span className="edu-brand-icon">✳</span> FluoroScope</a><nav><a href="../intensity/">荧光强度</a><a href="../colocalization/">共定位</a><a href="../edu/" aria-current="page">EdU</a></nav><span className="edu-local"><i /> 图像仅在本地处理</span></header>
    <main className="edu-main">
      <div className="edu-heading"><h1>EdU 去碎片</h1><div className="edu-heading-actions"><button className="edu-quiet" onClick={openDemo} disabled={!!busy}>演示</button><button onClick={() => filesInput.current?.click()} disabled={!!busy}>选择图像</button><button className="edu-primary" onClick={() => folderInput.current?.click()} disabled={!!busy}>导入文件夹</button></div></div>
      <input className="edu-hidden" ref={folderInput} type="file" multiple {...({ webkitdirectory: '' } as Record<string, string>)} onChange={event => { void importFiles(event.target.files); event.target.value = ''; }} />
      <input className="edu-hidden" ref={filesInput} type="file" multiple accept=".tif,.tiff,.png,.jpg,.jpeg,.oir" onChange={event => { void importFiles(event.target.files); event.target.value = ''; }} />
      {error && <div className="edu-alert edu-error" role="alert">{error}</div>}
      {message && <div className="edu-status" role="status">{message}<button aria-label="关闭提示" onClick={() => setMessage('')}>×</button></div>}
      <div className="edu-workspace">
        <aside className="edu-controls edu-panel">
          {fields.length > 0 && <div className="edu-queue"><select aria-label="视野队列" value={index} disabled={!!busy} onChange={event => void openField(fields, Number(event.target.value))}>{fields.map((field, i) => <option key={field.id} value={i}>{records[field.id] ? '✓ ' : ''}{field.name}</option>)}</select><div className="edu-queue-nav"><button aria-label="上一个视野" disabled={!!busy || index <= 0} onClick={() => void openField(fields, index - 1)}>←</button><span>{index + 1} / {fields.length}</span><button aria-label="下一个视野" disabled={!!busy || index >= fields.length - 1} onClick={() => void openField(fields, index + 1)}>→</button></div></div>}
          <fieldset className="edu-primary-controls" disabled={!image || !!busy}>
            <label className="edu-main-control">去除小于此面积的红色碎片<div className="edu-input-unit"><input aria-label="红色颗粒最小面积" type="number" min="1" max="100000" value={speckle} onChange={event => { setSpeckle(Math.max(1, Math.round(+event.target.value))); setCleaned(null); }} /><span>px²</span></div></label>
            <label className="edu-check"><input type="checkbox" checked={protectNuclear} onChange={event => { setProtectNuclear(event.target.checked); setCleaned(null); }} />保护核内信号</label>
            <div className="edu-button-row edu-main-actions"><button className="edu-primary" aria-label="生成去杂点预览" onClick={() => void clean()}>预览</button><button disabled={!cleaned || !!busy} aria-label="展示 PNG" onClick={() => void exportCleaned()}>导出 PNG</button></div>
          </fieldset>
          <p className="edu-mapping"><i className="edu-dot red" /> EdU <span>·</span> <i className="edu-dot blue" /> 细胞核</p>
          <details className="edu-disclosure" ref={channelDetails}><summary>通道设置</summary><fieldset disabled={!image || !!busy}>
            {image && <><label>细胞核通道<select value={nucleusIndex} onChange={event => changeChannel('nucleus', Number(event.target.value))}>{image.channels.map((channel, i) => <option key={channel.id} value={i}>{channel.label}</option>)}</select></label><label>EdU 通道<select value={eduIndex} onChange={event => changeChannel('edu', Number(event.target.value))}>{image.channels.map((channel, i) => <option key={channel.id} value={i}>{channel.label}</option>)}</select></label><p className="edu-help">请核对实际颜色，ch00 / ch01 顺序可能变化。</p>{image.displayOnly && <label className="edu-check edu-caution"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>确认：RGB / 伪彩图仅作探索性计数。</span></label>}</>}
            {!image && <p className="edu-help">先选择图像。</p>}
          </fieldset></details>
          <details className="edu-disclosure"><summary>高级清理</summary><fieldset disabled={!image || !!busy}>
            <label>红色背景下限 <b>{redFloor}</b><input aria-label="红色背景下限" type="range" min="0" max="100" value={redFloor} onChange={event => { setRedFloor(+event.target.value); setCleaned(null); }} /></label>
            <label className="edu-check"><input type="checkbox" checked={onlyNuclear} onChange={event => { setOnlyNuclear(event.target.checked); setCleaned(null); }} />仅保留与核相交的红色</label>
            <label>蓝色背景下限 <b>{blueFloor}</b><input aria-label="蓝色背景下限" type="range" min="0" max="100" value={blueFloor} onChange={event => { setBlueFloor(+event.target.value); setCleaned(null); }} /></label><label>蓝色最小面积（px²）<input type="number" min="1" max="100000" value={blueSpeckle} onChange={event => { setBlueSpeckle(Math.max(1, Math.round(+event.target.value))); setCleaned(null); }} /></label>
            <label>导出通道<select aria-label="展示导出通道" value={exportChannels} onChange={event => setExportChannels(event.target.value as typeof exportChannels)}><option value="merge">合并红蓝</option><option value="red">仅 EdU 红色</option><option value="blue">仅蓝色核</option></select></label><button className="edu-wide" disabled={!cleaned || !!busy} onClick={exportDisplaySettings}>展示参数 JSON</button>
            <p className="edu-help">保护模式保留与核相交的完整红色颗粒；核支持采用下方计数中的核阈值和最小面积。蓝色默认不变。清理只影响展示。</p>
          </fieldset></details>
          <details className="edu-disclosure"><summary>EdU 计数</summary><fieldset disabled={!image || !!busy}>
            <p className="edu-help">计数包含全部细胞，含 NK。</p>
            <div className="edu-two"><label>核阈值<input aria-label="核阈值" type="number" min="1" max="254" value={parameters.nucleusThreshold} onChange={event => setParameter('nucleusThreshold', +event.target.value)} /></label><label>EdU 阈值<input aria-label="EdU 阈值" type="number" min="1" max="254" value={parameters.eduThreshold} onChange={event => setParameter('eduThreshold', +event.target.value)} /></label><label>最小核面积<input type="number" min="1" value={parameters.minArea} onChange={event => setParameter('minArea', +event.target.value)} /></label><label>最大核面积<input type="number" min="1" value={parameters.maxArea} onChange={event => setParameter('maxArea', +event.target.value)} /></label></div>
            <label>核内 EdU 阳性面积 ≥<div className="edu-input-unit"><input type="number" min="1" max="100" value={Math.round(parameters.minPositiveFraction * 100)} onChange={event => setParameter('minPositiveFraction', +event.target.value / 100)} /><span>%</span></div></label>
            <label className="edu-check"><input type="checkbox" checked={parameters.median} onChange={event => setParameter('median', event.target.checked)} />3×3 中值去噪</label><label className="edu-check"><input type="checkbox" checked={parameters.excludeEdge} onChange={event => setParameter('excludeEdge', event.target.checked)} />排除触边核</label><label className="edu-check"><input type="checkbox" checked={exclusion.enabled} onChange={event => changeExclusion({ enabled: event.target.checked })} />排除右下标尺</label>
            {exclusion.enabled && <div className="edu-two"><label>右侧宽（px）<input type="number" min="1" max={image?.width} value={exclusion.width} onChange={event => changeExclusion({ width: Math.max(1, Math.round(+event.target.value)) })} /></label><label>底部高（px）<input type="number" min="1" max={image?.height} value={exclusion.height} onChange={event => changeExclusion({ height: Math.max(1, Math.round(+event.target.value)) })} /></label></div>}
            <label>样本 / 分组<input value={group} onChange={event => { setGroup(event.target.value); if (currentId) setRecords(old => { const next = { ...old }; delete next[currentId]; return next; }); }} /></label>
            <button className="edu-primary edu-wide" onClick={() => void analyze()}>运行 EdU 分析</button><p className="edu-help">面积单位 px²；阈值 1–254，按原始满量程映射。用阴性对照设阈值，组间固定参数。</p>
          </fieldset></details>
        </aside>
        <div className="edu-stage-column">
          <section className="edu-stage"><div className="edu-stage-toolbar"><div className="edu-tabs">{([['raw', '原图'], ['clean', '去碎片'], ['mask', '计数']] as const).filter(([key]) => key !== 'mask' || result).map(([key, label]) => <button key={key} aria-pressed={view === key} disabled={!image || !!busy || (key === 'clean' && !cleaned)} onClick={() => setView(key)}>{label}</button>)}</div><select aria-label="缩放" value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">适应视野</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option></select></div>
            <div className="edu-gallery-container" aria-busy={!!busy}>
              {image ? <div className="edu-channel-gallery">{DISPLAY_CHANNELS.map((channel, panel) => <section className="edu-channel-panel" key={channel}>
                <h2 className={`edu-channel-title channel-${panel}`}>{channel}</h2>
                <div role="region" tabIndex={0} aria-label={`${channel} 图像滚动区域`} className={`edu-channel-viewport ${zoom === 'fit' ? 'is-fit' : 'is-zoomed'}`} ref={element => { imagePanes.current[panel] = element; }} style={zoom === 'fit' ? { aspectRatio: `${image.width} / ${image.height}` } : undefined} onScroll={event => syncScroll(event.currentTarget)}>
                  <canvas ref={element => { canvases.current[panel] = element; }} aria-label={panel === 2 ? 'Merge，计数视图可点击细胞核修订' : `${channel} 通道图像`} style={zoom === 'fit' ? { width: '100%', height: 'auto' } : { width: image.width * +zoom, height: image.height * +zoom }} onClick={event => { if (panel !== 2 || view !== 'mask' || !result || busy) return; const bounds = event.currentTarget.getBoundingClientRect(); const x = Math.floor((event.clientX - bounds.left) / bounds.width * image.width), y = Math.floor((event.clientY - bounds.top) / bounds.height * image.height); const id = result.labels[y * image.width + x]; if (id) revise(id); }} />
                </div>
              </section>)}</div> : <div className="edu-canvas-wrap is-empty"><div className="edu-empty"><div className="edu-cell-art">{Array.from({ length: 16 }, (_, i) => <i key={i} style={{ left: `${13 + (i % 4) * 22 + (i % 3) * 2}%`, top: `${8 + Math.floor(i / 4) * 24}%`, width: 16 + (i % 3) * 8, height: 22 + (i % 4) * 5, transform: `rotate(${i * 31}deg)` }} />)}</div><h2>选择图像开始</h2><p>DAPI · RED · Merge</p></div></div>}
              {busy && <div className="edu-processing" role="status"><span />{busy}</div>}
            </div>            {image && <div className="edu-image-meta"><span>{fieldLabel} · {image.width} × {image.height} px</span><span>{view === 'clean' ? '展示副本 · 原图保留' : view === 'mask' ? '点击核：阳性 → 阴性 → 排除 → 自动' : image.format}</span></div>}
          </section>
          {result && <><div className="edu-stats"><article><span>总细胞核</span><strong>{totals?.total}</strong></article><article><span><i className="edu-dot yellow" /> EdU 阳性</span><strong>{totals?.positive}</strong></article><article className="edu-stat-primary"><span>阳性率</span><strong>{totals?.positivePct === null || !totals ? '—' : `${totals.positivePct.toFixed(1)}%`}</strong></article><article><span>人工修订</span><strong>{Object.keys(revisions).length}</strong></article></div><div className="edu-result-note"><span>● 阳性　<span className="edu-negative">● 阴性</span>　<span className="edu-excluded">● 排除</span></span><p>{result.warnings.join(' ')} 粘连核可能合并计数，请放大复核。</p></div></>}
          {selectedCell && <div className="edu-selection"><span>核 #{selectedCell.id} · {selectedCell.area} px² · EdU {Math.round(selectedCell.eduPositiveFraction * 100)}% · {revisions[selectedCell.id] ?? (selectedCell.positive ? '自动阳性' : '自动阴性')}</span><div>{(['positive', 'negative', 'exclude'] as const).map((state, i) => <button key={state} onClick={() => revise(selectedCell.id, state)}>{['设为阳性', '设为阴性', '排除'][i]}</button>)}</div></div>}
          {(result || saved.length > 0) && <section className="edu-panel edu-export"><span className="edu-saved-count">已确认 {saved.length} 个视野</span><div className="edu-button-row"><button disabled={!result || !!busy} onClick={() => saveResult(false)}>{currentSaved ? '✓ 已确认' : '确认当前视野'}</button><button className="edu-primary" disabled={!result || !!busy || isDemo || index === fields.length - 1} onClick={() => saveResult(true)}>确认并下一个 →</button></div>{saved.length > 0 && <div className="edu-export-row"><button disabled={!!busy} onClick={() => exportData('summary')}>汇总 CSV</button><button disabled={!!busy} onClick={() => exportData('cells')}>逐核 CSV</button><button disabled={!!busy} onClick={() => exportData('json')}>完整记录 JSON</button></div>}</section>}
          <details className="edu-method"><summary>方法与注意事项</summary><div className="edu-method-grid"><div><h3>展示清理</h3><p>按背景阈值与 8 连通颗粒面积去碎片；可保护与核相交的红色。蓝色默认不变。核外信号未必是杂质，请切换原图核对。导出为 8-bit 展示 PNG，勿用该副本定量。</p></div><div><h3>EdU 计数</h3><p>核中值滤波 → 阈值分割 → 连通域与面积筛选 → 核内 EdU 阳性面积占比。EdU 测量使用原始输入，不受展示清理影响。不自动拆分粘连核，必要时在 Fiji 分水岭并人工复核。</p></div><div><h3>实验比较</h3><p>用阴性对照设阈值，曝光与 LUT 应一致。RGB / 伪彩图仅作探索性计数；同名合并图优先，不重复计数。视野不能代替生物学重复。计数含 NK；关闭页面前请导出结果。</p></div></div>{image && <details><summary>输入文件提示</summary><ul>{image.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}</details>
        </div>
      </div>
    </main>
  </div>;
}
