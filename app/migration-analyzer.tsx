'use client';

import { useEffect, useRef, useState } from 'react';
import { loadImages, type LoadedImage } from '../lib/image';
import { createStoredZip, safeFilePart, type ExportArchiveEntry } from '../lib/export-archive';
import { DEFAULT_SCRATCH_PARAMETERS, DEFAULT_TRANSWELL_PARAMETERS, measureScratch, type RGBAFrame, type ScratchParameters, type ScratchResult, type ScratchBoundary, type TranswellParameters, type TranswellResult } from '../lib/migration';
import { makeMigrationCsv, scratchClosure, parseScratchFile, type MigrationCsvRow } from '../lib/migration-batch';
import './migration.css';

type Mode = 'scratch' | 'transwell';
type Parameters = ScratchParameters | TranswellParameters;
type Entry = { key: string; path: string; file: File };
type Point = { x: number; y: number };
type ResultRecord = MigrationCsvRow & { key: string; scratch?: ScratchResult; autoScratch?: ScratchResult; points?: Point[]; autoPoints?: Point[]; updatedAt: string; lastRunError?: string };
type Loaded = { frame: RGBAFrame; hash: string; warnings: string[] };
type Progress = { running: boolean; done: number; total: number; failed: number; skipped: number; stopped: boolean; issues: string[] };
const SUPPORTED = /\.(png|jpe?g|tiff?|bmp|webp)$/i;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const numberText = (value: number | null | undefined, digits = 0) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });

function imageFrame(image: LoadedImage): RGBAFrame {
  if (image.pageCount > 1 || ![1, 3].includes(image.channels.length)) throw new Error('请使用单平面 RGB 或灰度明场图；暂不分析堆栈/多通道荧光图。');
  const byColor = ['red', 'green', 'blue'].map(id => image.channels.find(channel => channel.id === id));
  if (image.channels.length === 3 && byColor.some(channel => !channel)) throw new Error('无法确认 RGB 来源，请导出单平面 RGB 图。');
  const channels = image.channels.length === 1 ? [image.channels[0], image.channels[0], image.channels[0]] : byColor;
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = channels[c]!.data[i] / channels[c]!.maxValue * 255;
    data[i * 4 + 3] = 255;
  }
  return { width: image.width, height: image.height, data };
}
async function readEntry(entry: Entry): Promise<Loaded> {
  const image = await loadImages([entry.file]);
  if (image.warnings.some(warning => warning.includes('Alpha/ExtraSamples'))) throw new Error('TIFF 含 Alpha/额外样本，请先导出不透明单平面 RGB 图。');
  let frame = imageFrame(image);
  if (!/\.tiff?$/i.test(entry.file.name)) {
    const bitmap = await createImageBitmap(entry.file), surface = document.createElement('canvas');
    surface.width = bitmap.width; surface.height = bitmap.height;
    const context = surface.getContext('2d');
    if (!context) { bitmap.close(); throw new Error('无法读取图像透明度。'); }
    context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, surface.width, surface.height);
    surface.width = 0; surface.height = 0;
    for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i] !== 255) throw new Error('图像含透明像素，请先导出不透明明场图。');
    frame = { width: image.width, height: image.height, data: pixels.data };
  }
  // Fluorescence-channel warnings do not apply to the intended brightfield RGB input.
  const sourceWarnings = image.warnings.filter(warning => !warning.startsWith('检测到 RGB 合并展示图') && !warning.startsWith('分析使用 TIFF 原始位深'));
  return { frame, hash: image.hash, warnings: [...sourceWarnings, ...(image.channels.some(channel => channel.bitDepth > 8) ? ['算法按原始满量程映射到 8-bit 明场图；原文件保留。'] : [])] };
}
function processFrame(mode: Mode, frame: RGBAFrame, parameters: Parameters): Promise<ScratchResult | TranswellResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../lib/migration.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => { worker.terminate(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result); };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || '图像处理失败')); };
    worker.postMessage({ id: 1, mode, frame, parameters });
  });
}
function makeRecord(entry: Entry, loaded: Loaded, parameters: Parameters, result: ScratchResult | TranswellResult, mode: Mode): ResultRecord {
  const base: ResultRecord = { key: entry.key, path: entry.path, width: loaded.frame.width, height: loaded.frame.height, sourceHash: loaded.hash, paramsJson: JSON.stringify(parameters), reviewed: false, manualEdited: false, pairConfirmed: false, warnings: [...loaded.warnings, ...result.qc], updatedAt: new Date().toISOString() };
  if (mode === 'scratch') {
    const scratch = result as ScratchResult, params = parameters as ScratchParameters;
    return { ...base, areaPx: scratch.areaPx, meanWidthPx: scratch.meanWidthPx, roiTopPct: params.roiTopPct, roiBottomPct: params.roiBottomPct, scratch, autoScratch: scratch };
  }
  const transwell = result as TranswellResult;
  return { ...base, autoCount: transwell.points.length, correctedCount: transwell.points.length, stainedAreaPx: transwell.stainedAreaPx, coveragePct: transwell.coveragePct, clusterCount: transwell.clusterCount, points: transwell.points, autoPoints: transwell.points };
}
function anchorIndices(boundaries: ScratchBoundary[]) {
  const step = Math.max(1, Math.floor(boundaries.length / 12));
  return boundaries.map((_, index) => index).filter(index => index % step === 0 || index === boundaries.length - 1);
}
function drawOverlay(context: CanvasRenderingContext2D, frame: RGBAFrame, record?: ResultRecord, anchors = false) {
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  if (!record || record.error) return;
  const width = Math.max(2, frame.width / 600);
  if (record.scratch?.boundaries.length) {
    const edges = record.scratch.boundaries;
    context.beginPath(); context.moveTo(edges[0].left, edges[0].y);
    edges.slice(1).forEach(edge => context.lineTo(edge.left, edge.y));
    [...edges].reverse().forEach(edge => context.lineTo(edge.right, edge.y));
    context.closePath(); context.fillStyle = 'rgba(19,166,142,.17)'; context.fill();
    context.lineWidth = width; context.strokeStyle = '#12b99e';
    for (const side of ['left', 'right'] as const) { context.beginPath(); edges.forEach((edge, i) => i ? context.lineTo(edge[side], edge.y) : context.moveTo(edge[side], edge.y)); context.stroke(); }
    if (anchors) for (const i of anchorIndices(edges)) for (const side of ['left', 'right'] as const) { context.beginPath(); context.arc(edges[i][side], edges[i].y, width * 3, 0, Math.PI * 2); context.fillStyle = '#fff'; context.fill(); context.strokeStyle = '#087e70'; context.stroke(); }
  } else if (record.points) {
    context.lineWidth = width; context.strokeStyle = '#11b9a6';
    for (const point of record.points) { context.beginPath(); context.arc(point.x, point.y, Math.max(4, frame.width / 220), 0, Math.PI * 2); context.stroke(); }
  }
}

export default function MigrationAnalyzer({ mode }: { mode: Mode }) {
  const title = mode === 'scratch' ? '划痕分析' : 'Transwell 穿膜细胞计数';
  const [entries, setEntries] = useState<Entry[]>([]), [activeKey, setActiveKey] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null), [records, setRecords] = useState<Record<string, ResultRecord>>({});
  const [parameters, setParameters] = useState<Parameters>(mode === 'scratch' ? DEFAULT_SCRATCH_PARAMETERS : DEFAULT_TRANSWELL_PARAMETERS);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [overlay, setOverlay] = useState(true), [editing, setEditing] = useState(false), [zoom, setZoom] = useState('fit');
  const [scratchDraft, setScratchDraft] = useState<ScratchBoundary[] | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null), [downloadLink, setDownloadLink] = useState<{ url: string; name: string } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null), fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const cancel = useRef(false), loadVersion = useRef(0);
  const dragging = useRef<{ side: 'left' | 'right'; index: number; boundaries: ScratchBoundary[] } | null>(null);
  const paramsJson = JSON.stringify(parameters), active = entries.find(entry => entry.key === activeKey), record = records[activeKey];
  const currentIndex = entries.findIndex(entry => entry.key === activeKey), stale = Boolean(record && record.paramsJson !== paramsJson);
  const exportRows: MigrationCsvRow[] = entries.map(entry => {
    const item = records[entry.key];
    return item ? { ...item, error: item.error ?? item.lastRunError, status: item.lastRunError ? '本次失败；保留人工结果' : item.error ? '失败' : item.paramsJson !== paramsJson ? '参数已改变；保留原结果' : item.reviewed ? '已复核' : item.manualEdited ? '已修正，待复核' : '自动结果，待复核' } : { path: entry.path, paramsJson, reviewed: false, manualEdited: false, warnings: [], status: '未处理' };
  });
  const closure = mode === 'scratch' && record ? scratchClosure(record, exportRows) : null;
  const parsed = active && mode === 'scratch' ? parseScratchFile(active.path) : null;

  function fail(entry: Entry, frozen: Parameters, cause: unknown, source?: Loaded) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const previous = records[entry.key];
    if (previous && (previous.manualEdited || previous.reviewed)) {
      setRecords(old => ({ ...old, [entry.key]: { ...previous, lastRunError: reason, warnings: [...previous.warnings.filter(warning => !warning.startsWith('本次处理失败')), `本次处理失败，保留人工结果：${reason}`], updatedAt: new Date().toISOString() } }));
      return reason;
    }
    const failed: ResultRecord = { key: entry.key, path: entry.path, paramsJson: JSON.stringify(frozen), width: source?.frame.width, height: source?.frame.height, sourceHash: source?.hash, reviewed: false, manualEdited: false, warnings: [], error: reason, updatedAt: new Date().toISOString() };
    setRecords(old => ({ ...old, [entry.key]: failed })); return reason;
  }
  async function openImage(entry: Entry) {
    const version = ++loadVersion.current;
    setActiveKey(entry.key); setLoaded(null); setEditing(false); setScratchDraft(null); setError(''); setBusy('正在读取…');
    let source: Loaded | undefined;
    try {
      source = await readEntry(entry); if (version !== loadVersion.current) return;
      setLoaded(source);
      const existing = records[entry.key];
      if (existing && existing.sourceHash === source.hash && !existing.error) {
        if (existing.lastRunError) setRecords(old => ({ ...old, [entry.key]: { ...existing, lastRunError: undefined, warnings: existing.warnings.filter(warning => !warning.startsWith('本次处理失败')) } }));
        setBusy(''); return;
      }
      setBusy('正在分析…'); await tick();
      const result = await processFrame(mode, source.frame, parameters);
      if (version !== loadVersion.current) return;
      const next = makeRecord(entry, source, parameters, result, mode);
      setRecords(old => ({ ...old, [entry.key]: next }));
    } catch (cause) { if (version === loadVersion.current) setError(fail(entry, parameters, cause, source)); }
    finally { if (version === loadVersion.current) setBusy(''); }
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    const selected = Array.from(list).filter(file => SUPPORTED.test(file.name) && !(file.webkitRelativePath || '').split('/').some(part => /^(metadata|\.git|node_modules|_audit|pages-dist)$/i.test(part)));
    if (!selected.length) { setError('没有找到支持的图像文件。'); return; }
    const next = selected.map((file, i) => {
      const duplicate = selected.filter(other => other.name === file.name).length > 1;
      const path = file.webkitRelativePath || (duplicate ? `文件选择/${i + 1}/${file.name}` : file.name);
      return { path, file, key: `${path}\n${file.size}\n${file.lastModified}` };
    });
    const merged = new Map(entries.map(entry => [entry.key, entry])); next.forEach(entry => merged.set(entry.key, entry));
    setEntries([...merged.values()]); setMessage(`已载入 ${next.length} 张图。`); setDownloadLink(null);
    await openImage(next[0]);
  }
  async function analyzeCurrent() {
    if (!active || !loaded || busy) return;
    setBusy('正在分析…'); setEditing(false); setScratchDraft(null); setError(''); await tick();
    try { const result = await processFrame(mode, loaded.frame, parameters); setRecords(old => ({ ...old, [active.key]: makeRecord(active, loaded, parameters, result, mode) })); }
    catch (cause) { setError(fail(active, parameters, cause, loaded)); }
    finally { setBusy(''); }
  }
  async function analyzeAll() {
    if (!entries.length || busy) return;
    const frozen = { ...parameters }, signature = JSON.stringify(frozen), queue = [...entries];
    const status: Progress = { running: true, done: 0, total: queue.length, failed: 0, skipped: 0, stopped: false, issues: [] };
    cancel.current = false; setProgress({ ...status }); setEditing(false); setScratchDraft(null); setError(''); setMessage('');
    try {
      for (let i = 0; i < queue.length; i++) {
        if (cancel.current) { status.stopped = true; break; }
        const entry = queue[i], previous = records[entry.key];
        setBusy(`正在分析 ${i + 1} / ${queue.length}…`); await tick();
        if (previous && !previous.error && (previous.manualEdited || previous.reviewed) && previous.paramsJson !== signature) {
          status.skipped++; status.issues.push(`${entry.path}：参数不同，保留人工结果。`);
        } else {
          let source: Loaded | undefined;
          try {
            source = entry.key === activeKey && loaded ? loaded : await readEntry(entry);
            if (!previous || previous.error || previous.sourceHash !== source.hash || previous.paramsJson !== signature) {
              const result = await processFrame(mode, source.frame, frozen);
              const next = makeRecord(entry, source, frozen, result, mode);
              setRecords(old => ({ ...old, [entry.key]: next }));
            } else if (previous.lastRunError) {
              setRecords(old => ({ ...old, [entry.key]: { ...previous, lastRunError: undefined, warnings: previous.warnings.filter(warning => !warning.startsWith('本次处理失败')) } }));
            }
          } catch (cause) { status.failed++; status.issues.push(`${entry.path}：${fail(entry, frozen, cause, source)}`); }
        }
        status.done++; setProgress({ ...status, issues: [...status.issues] });
      }
    } finally { status.running = false; status.stopped ||= cancel.current && status.done < status.total; setProgress({ ...status, issues: [...status.issues] }); setBusy(''); setMessage(`${status.stopped ? '已停止' : '分析完成'} ${status.done}/${status.total}，失败 ${status.failed}，保留 ${status.skipped}。`); }
  }
  function updateRecord(change: Partial<ResultRecord>) {
    if (!record) return;
    setRecords(old => ({ ...old, [activeKey]: { ...old[activeKey], ...change, updatedAt: new Date().toISOString() } })); setDownloadLink(null);
  }
  function beginEditing() {
    if (!record || !loaded || stale) return;
    setOverlay(true); setEditing(!editing);
    if (editing) { setScratchDraft(null); return; }
    if (mode === 'scratch' && !record.scratch?.boundaries.length) {
      const original = JSON.parse(record.paramsJson) as ScratchParameters;
      const top = Math.floor(loaded.frame.height * original.roiTopPct / 100), bottom = Math.ceil(loaded.frame.height * original.roiBottomPct / 100);
      const boundaries = Array.from({ length: 13 }, (_, i) => ({ y: top + (bottom - top) * i / 12, left: loaded.frame.width * 0.4, right: loaded.frame.width * 0.6 }));
      setScratchDraft(boundaries);
    }
  }
  function editBoundaries(boundaries: ScratchBoundary[]) {
    if (!loaded || !record) return;
    const measured = measureScratch(boundaries, loaded.frame.width, loaded.frame.height);
    const scratch = { ...record.scratch, ...measured, boundaries } as ScratchResult;
    setScratchDraft(null);
    updateRecord({ scratch, areaPx: measured.areaPx, meanWidthPx: measured.meanWidthPx, warnings: [...loaded.warnings, ...measured.qc], manualEdited: true, reviewed: false, pairConfirmed: false });
  }
  function pointerPosition(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect(), frame = loaded!.frame;
    return { x: Math.max(0, Math.min(frame.width, (event.clientX - rect.left) / rect.width * frame.width)), y: Math.max(0, Math.min(frame.height, (event.clientY - rect.top) / rect.height * frame.height)), tolerance: 14 * frame.width / rect.width };
  }
  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!editing || !loaded || !record || busy || stale) return;
    const point = pointerPosition(event);
    if (mode === 'transwell') {
      const points = [...(record.points ?? [])]; let nearest = -1, distance = point.tolerance;
      points.forEach((candidate, i) => { const d = Math.hypot(candidate.x - point.x, candidate.y - point.y); if (d < distance) { nearest = i; distance = d; } });
      if (nearest >= 0) points.splice(nearest, 1); else points.push({ x: point.x, y: point.y });
      updateRecord({ points, correctedCount: points.length, manualEdited: true, reviewed: false }); return;
    }
    const boundaries = scratchDraft ?? record.scratch?.boundaries ?? []; let closest: { side: 'left' | 'right'; index: number; distance: number } | null = null;
    for (let index = 0; index < boundaries.length; index++) for (const side of ['left', 'right'] as const) {
      const distance = Math.hypot(boundaries[index][side] - point.x, boundaries[index].y - point.y);
      if (distance < point.tolerance && (!closest || distance < closest.distance)) closest = { side, index, distance };
    }
    if (closest) { dragging.current = { side: closest.side, index: closest.index, boundaries: boundaries.map(edge => ({ ...edge })) }; event.currentTarget.setPointerCapture(event.pointerId); }
  }
  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const drag = dragging.current;
    if (!drag || !loaded || busy) return;
    const point = pointerPosition(event), center = drag.boundaries[drag.index];
    if (Math.abs(point.x - center[drag.side]) < 1) return;
    const reach = Math.max(1, (drag.boundaries[drag.boundaries.length - 1].y - drag.boundaries[0].y) / 12);
    const lower = [...drag.boundaries].reverse().find(edge => edge.y <= center.y - reach) ?? drag.boundaries[0];
    const upper = drag.boundaries.find(edge => edge.y >= center.y + reach) ?? drag.boundaries[drag.boundaries.length - 1];
    const boundaries = drag.boundaries.map(edge => {
      if (edge.y < lower.y || edge.y > upper.y) return { ...edge };
      const adjusted = edge.y <= center.y
        ? lower[drag.side] + (point.x - lower[drag.side]) * (center.y === lower.y ? 1 : (edge.y - lower.y) / (center.y - lower.y))
        : point.x + (upper[drag.side] - point.x) * (upper.y === center.y ? 1 : (edge.y - center.y) / (upper.y - center.y));
      return { ...edge, [drag.side]: Math.max(drag.side === 'left' ? 0 : edge.left, Math.min(drag.side === 'left' ? edge.right : loaded.frame.width, adjusted)) };
    });
    editBoundaries(boundaries);
  }
  function resetManual() {
    if (!record) return;
    if (mode === 'scratch' && record.autoScratch) updateRecord({ scratch: record.autoScratch, areaPx: record.autoScratch.areaPx, meanWidthPx: record.autoScratch.meanWidthPx, warnings: record.autoScratch.qc, manualEdited: false, reviewed: false, pairConfirmed: false });
    if (mode === 'transwell') updateRecord({ points: record.autoPoints, correctedCount: record.autoCount, manualEdited: false, reviewed: false });
  }
  function presentDownload(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob); setDownloadLink({ url, name });
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  }
  function exportCsv() { presentDownload(new Blob([makeMigrationCsv(mode, exportRows)], { type: 'text/csv;charset=utf-8' }), `${mode === 'scratch' ? '划痕' : 'Transwell'}_全部结果.csv`); }
  async function exportOverlays() {
    const targets = entries.filter(entry => records[entry.key] && !records[entry.key].error);
    if (!targets.length || busy) return;
    setBusy('正在生成标记图…'); setError(''); setDownloadLink(null); setEditing(false); setScratchDraft(null);
    const files: ExportArchiveEntry[] = [], issues: string[] = [];
    const output = document.createElement('canvas'), context = output.getContext('2d');
    try {
      if (!context) throw new Error('无法创建图像画布。');
      for (let i = 0; i < targets.length; i++) {
        const entry = targets[i], item = records[entry.key];
        setBusy(`正在导出 ${i + 1} / ${targets.length}…`); await tick();
        try {
          const input = entry.key === activeKey && loaded ? loaded : await readEntry(entry);
          if (input.hash !== item.sourceHash) throw new Error('源文件已改变，请重新分析。');
          output.width = input.frame.width; output.height = input.frame.height; drawOverlay(context, input.frame, item);
          const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('PNG 编码失败')), 'image/png'));
          const directory = `${String(i + 1).padStart(4, '0')}_${safeFilePart(entry.path)}`;
          files.push({ name: `${directory}/overlay.png`, data: new Uint8Array(await blob.arrayBuffer()) }, { name: `${directory}/analysis.json`, data: new TextEncoder().encode(JSON.stringify(item, null, 2)) });
        } catch (cause) { issues.push(`${entry.path}：${cause instanceof Error ? cause.message : String(cause)}`); }
      }
      if (!files.length) throw new Error(`没有成功导出的图像。${issues.join('；')}`);
      files.push({ name: 'results.csv', data: new TextEncoder().encode(makeMigrationCsv(mode, exportRows)) }, { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ mode, requested: targets.length, completed: files.length / 2, issues, exportedAt: new Date().toISOString() }, null, 2)) });
      const zip = await createStoredZip(files); presentDownload(new Blob([zip], { type: 'application/zip' }), `${mode}_${issues.length ? '部分完成_' : ''}标记图.zip`); setMessage(`标记图已导出${issues.length ? `；失败 ${issues.length} 张。` : '。'}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { output.width = 0; output.height = 0; setBusy(''); }
  }
  useEffect(() => () => { if (downloadLink) URL.revokeObjectURL(downloadLink.url); }, [downloadLink]);
  useEffect(() => {
    if (!loaded || !canvas.current) return;
    canvas.current.width = loaded.frame.width; canvas.current.height = loaded.frame.height;
    const shown = scratchDraft && record ? { ...record, scratch: { ...record.scratch, boundaries: scratchDraft } as ScratchResult } : record;
    const context = canvas.current.getContext('2d'); if (context) drawOverlay(context, loaded.frame, overlay ? shown : undefined, editing && mode === 'scratch');
  }, [loaded, record, overlay, editing, mode, scratchDraft]);

  const controls: Array<{ key: string; label: string; min: number; max: number; step?: number }> = mode === 'scratch'
    ? [{ key: 'textureThreshold', label: '纹理阈值', min: 0.1, max: 128, step: 0.1 }, { key: 'centerXPct', label: '划痕中心 (%)', min: 1, max: 99 }, { key: 'roiTopPct', label: 'ROI 上缘 (%)', min: 0, max: 99.9, step: 0.1 }, { key: 'roiBottomPct', label: 'ROI 下缘 (%)', min: 0.1, max: 100, step: 0.1 }, { key: 'windowRadius', label: '纹理窗口半径', min: 1, max: 100 }, { key: 'minGapWidth', label: '最小划痕宽 (px)', min: 1, max: 10000 }, { key: 'rowStep', label: '边界采样间隔', min: 1, max: 100 }]
    : [{ key: 'stainThreshold', label: '染色阈值', min: 1, max: 255 }, { key: 'minArea', label: '最小面积 (px²)', min: 1, max: 100000 }, { key: 'peakDistance', label: '细胞中心间距 (px)', min: 1, max: 1000 }, { key: 'maxBrightness', label: '最大亮度', min: 1, max: 255 }, { key: 'minPeakRadius', label: '最小中心半径', min: 1, max: 100 }, { key: 'clusterArea', label: '大团块面积 (px²)', min: 1, max: 1000000 }];
  const control = (item: typeof controls[number]) => <label key={item.key}>{item.label}<input type="number" min={item.min} max={item.max} step={item.step ?? 1} value={Number((parameters as unknown as Record<string, unknown>)[item.key])} disabled={!!busy} onChange={event => { setParameters(old => ({ ...old, [item.key]: +event.target.value })); setEditing(false); setScratchDraft(null); setDownloadLink(null); }} /></label>;
  return <div className="migration-app">
    <header className="migration-header"><a className="migration-brand" href="../"><span>✳</span> FluoroScope</a><nav><a href="../intensity/">荧光</a><a href="../edu/">EdU</a><a href="../scratch/" aria-current={mode === 'scratch' ? 'page' : undefined}>划痕</a><a href="../transwell/" aria-current={mode === 'transwell' ? 'page' : undefined}>Transwell</a></nav><small>本地处理</small></header>
    <main className="migration-main"><div className="migration-heading"><h1>{title}</h1><div><button className="quiet" disabled={!entries.length || !!busy} onClick={() => { ++loadVersion.current; setEntries([]); setRecords({}); setLoaded(null); setActiveKey(''); setEditing(false); setScratchDraft(null); setProgress(null); setError(''); setMessage(''); setDownloadLink(null); }}>清空列表</button><button disabled={!!busy} onClick={() => fileInput.current?.click()}>选择图像</button><button className="primary" disabled={!!busy} onClick={() => folderInput.current?.click()}>导入文件夹</button></div></div>
      <input hidden ref={fileInput} type="file" multiple accept=".png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp" onChange={event => { void importFiles(event.target.files); event.target.value = ''; }} /><input hidden ref={folderInput} type="file" multiple {...({ webkitdirectory: '' } as Record<string, string>)} onChange={event => { void importFiles(event.target.files); event.target.value = ''; }} />
      {error && <div className="migration-error" role="alert">{error}</div>}{message && <div className="migration-message" role="status">{message}</div>}
      <div className="migration-workspace"><aside className="migration-controls">
        {entries.length > 0 && <><select aria-label="图像列表" disabled={!!busy} value={activeKey} onChange={event => { const entry = entries.find(item => item.key === event.target.value); if (entry) void openImage(entry); }}>{entries.map(entry => <option key={entry.key} value={entry.key}>{records[entry.key]?.error || records[entry.key]?.lastRunError ? '失败 · ' : records[entry.key]?.reviewed ? '✓ ' : records[entry.key] ? '已算 · ' : ''}{entry.path}</option>)}</select><div className="migration-prev-next"><button disabled={!!busy || currentIndex <= 0} onClick={() => void openImage(entries[currentIndex - 1])}>←</button><span>{currentIndex + 1} / {entries.length}</span><button disabled={!!busy || currentIndex === entries.length - 1} onClick={() => void openImage(entries[currentIndex + 1])}>→</button></div></>}
        <div className="migration-basic-controls">{controls.slice(0, 2).map(control)}</div><details><summary>更多参数</summary><div className="migration-parameter-grid">{controls.slice(2).map(control)}</div>{mode === 'transwell' && <label className="check"><input type="checkbox" checked={(parameters as TranswellParameters).excludeEdge} disabled={!!busy} onChange={event => { setParameters(old => ({ ...old, excludeEdge: event.target.checked })); setEditing(false); }} />排除触边对象</label>}</details>
        <button className="wide" disabled={!loaded || !!busy} onClick={() => void analyzeCurrent()}>重算此图</button><button className="primary wide" disabled={!entries.length || !!busy} onClick={() => void analyzeAll()}>一键分析全部</button>
        {progress?.running && <div className="migration-progress"><span>{progress.done} / {progress.total}</span><button onClick={() => { cancel.current = true; setMessage('当前图完成后停止。'); }}>停止</button></div>}
        <p className="migration-qc-note">自动结果请核对</p>
        {record && !record.error && <div className="migration-edit-controls"><button className={editing ? 'selected wide' : 'wide'} disabled={!!busy || stale} onClick={beginEditing}>{editing ? '完成修改' : mode === 'scratch' ? (record.scratch?.boundaries.length ? '编辑左右边界' : '手动画边界') : '添加 / 删除标记'}</button><button className="wide" disabled={!!busy || !record.manualEdited || stale} onClick={resetManual}>恢复自动结果</button><label className="check"><input type="checkbox" checked={record.reviewed} disabled={!!busy || stale || (mode === 'scratch' && !record.scratch?.valid)} onChange={event => updateRecord({ reviewed: event.target.checked })} />已复核</label>{mode === 'scratch' && parsed?.timeHours !== null && parsed?.timeHours !== 0 && closure?.baselinePath && <label className="check"><input type="checkbox" checked={!!record.pairConfirmed} disabled={!!busy || stale} onChange={event => updateRecord({ pairConfirmed: event.target.checked })} />与 0H 为同一视野</label>}</div>}
        <div className="migration-downloads"><button disabled={!exportRows.length || !!busy} onClick={exportCsv}>全部结果 CSV</button><button disabled={!Object.values(records).some(item => !item.error) || !!busy} onClick={() => void exportOverlays()}>全部标记图 ZIP</button>{downloadLink && <a href={downloadLink.url} download={downloadLink.name}>下载文件</a>}</div>
      </aside><section className="migration-stage-column">
        <div className="migration-stage"><div className="migration-toolbar"><label className="check"><input type="checkbox" checked={overlay} onChange={event => setOverlay(event.target.checked)} />显示标记</label>{editing && <span>{mode === 'scratch' ? (scratchDraft ? '草稿：拖动边界后计算' : '拖动边界修正') : '点击添加；点中标记删除'}</span>}<select aria-label="缩放" value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">适应视野</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option></select></div>
          <div className={`migration-canvas ${loaded ? '' : 'empty'}`} aria-busy={!!busy}>{loaded ? <canvas ref={canvas} style={zoom === 'fit' ? { width: '100%', height: 'auto' } : { width: loaded.frame.width * +zoom, height: loaded.frame.height * +zoom }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={() => { dragging.current = null; }} onPointerCancel={() => { dragging.current = null; }} aria-label={mode === 'scratch' ? '划痕边界预览，可编辑左右边界' : '穿膜细胞标记预览，可添加或删除候选点'} /> : <div className="migration-empty"><div>{mode === 'scratch' ? 'Ⅱ' : '⠿'}</div><h2>选择图像开始</h2><p>支持 TIFF · PNG · JPEG</p></div>}{busy && <div className="migration-processing" role="status"><i />{busy}</div>}</div>
          <div className="migration-meta"><span>{active?.path || '图像保留在本机'}</span><span>{loaded ? `${loaded.frame.width} × ${loaded.frame.height} px` : ''}</span></div></div>
        {record?.lastRunError && <div className="migration-stale">本次处理失败，当前显示保留的人工结果。</div>}
        {stale && <div className="migration-stale">参数已改变，当前显示保留的旧结果。点击「重算此图」更新。</div>}
        {record && !record.error && <div className="migration-stats">{mode === 'scratch' ? <><article><span>伤口面积</span><strong>{numberText(record.areaPx)}</strong><small>px²</small></article><article><span>平均宽度</span><strong>{numberText(record.meanWidthPx, 1)}</strong><small>px</small></article><article><span>{record.pairConfirmed ? '闭合率' : '闭合率（待核对）'}</span><strong>{closure?.closurePct == null ? '—' : `${numberText(closure.closurePct, 1)}%`}</strong><small>{closure?.status}</small></article></> : <><article><span>自动估计数</span><strong>{record.autoCount}</strong></article><article><span>修正后计数</span><strong>{record.correctedCount}</strong></article><article><span>染色覆盖率</span><strong>{numberText(record.coveragePct, 1)}%</strong><small>大团块 {record.clusterCount ?? 0}</small></article></>}</div>}
        {record?.warnings.length ? <details className="migration-warning"><summary>质控提示 ({record.warnings.length})</summary><ul>{record.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details> : null}
        {progress && !progress.running && progress.issues.length > 0 && <details className="migration-warning"><summary>批量处理明细 ({progress.issues.length})</summary><ul>{progress.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details>}
        <details className="migration-method"><summary>方法与说明</summary>{mode === 'scratch' ? <p>按局部纹理估计纵向划痕左右边界，以边界积分计算面积和平均宽度。可拖动锚点修正；无法识别时不填假零值。闭合率需同一视野 0H、相同尺寸和 ROI；文件名配对仅作提示，必须人工核对。</p> : <p>按染色与亮度筛选区域，再根据空间峰估计穿膜细胞中心；可点击增删标记。重叠细胞、大团块、膜孔和杂质会影响自动计数，请核对；染色面积和覆盖率另行保留。这里只分析图像，不自动划分实验组。</p>}<p>参数变化后旧结果会明确标记。批量会保留参数不同的人工结果；CSV 包含失败、复核、参数和文件来源。关闭页面前请导出。</p></details>
      </section></div>
    </main>
  </div>;
}
