'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadImages, type LoadedImage } from '../lib/image';
import { createStoredZip, safeFilePart, type ExportArchiveEntry } from '../lib/export-archive';
import { DEFAULT_SCRATCH_PARAMETERS, DEFAULT_TRANSWELL_PARAMETERS, SCRATCH_ALGORITHM_VERSION, measureScratch, type RGBAFrame, type ScratchParameters, type ScratchResult, type ScratchBoundary, type TranswellParameters, type TranswellResult } from '../lib/migration';
import { makeMigrationCsv, scratchClosure, parseScratchFile, type MigrationCsvRow } from '../lib/migration-batch';
import { DEFAULT_BACKGROUND_SETTINGS, estimateBackground, normalizeBackground, type BackgroundEstimate, type BackgroundSettings } from '../lib/brightfield-display';
import { moveScratchBoundary, traceScratchSegment, type ScratchSide, type TracePoint } from '../lib/scratch-edit';
import { scratchDisplayEdges, type ScratchLineType } from '../lib/scratch-display';
import './migration.css';

type Mode = 'scratch' | 'transwell';
type Parameters = ScratchParameters | TranswellParameters;
type Entry = { key: string; path: string; file: File };
type Point = { x: number; y: number };
type LineStyle = { color: string; widthPx: number; type: ScratchLineType };
type ResultRecord = MigrationCsvRow & { key: string; scratch?: ScratchResult; autoScratch?: ScratchResult; points?: Point[]; autoPoints?: Point[]; updatedAt: string; lastRunError?: string };
type Loaded = { frame: RGBAFrame; hash: string; warnings: string[]; background: BackgroundEstimate };
type Progress = { running: boolean; done: number; total: number; failed: number; skipped: number; stopped: boolean; issues: string[] };
type ScratchStroke = { key: string; hash: string; paramsJson: string; pointerId: number; side: ScratchSide; mode: 'trace' | 'move'; radiusPx: number; start: TracePoint; centerY: number; last: TracePoint; base: ScratchBoundary[]; boundaries: ScratchBoundary[]; before: ResultRecord; beforeDraft: ScratchBoundary[] | null; moved: boolean };
const SUPPORTED = /\.(png|jpe?g|tiff?|bmp|webp)$/i;
const DEFAULT_LINE_STYLE: LineStyle = { color: '#e88d89', widthPx: 2, type: 'contour' };
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
  return { frame, hash: image.hash, background: estimateBackground(frame), warnings: [...sourceWarnings, ...(image.channels.some(channel => channel.bitDepth > 8) ? ['算法按原始满量程映射到 8-bit 明场图；原文件保留。'] : [])] };
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
  const base: ResultRecord = { key: entry.key, path: entry.path, width: loaded.frame.width, height: loaded.frame.height, sourceHash: loaded.hash, algorithmVersion: mode === 'scratch' ? SCRATCH_ALGORITHM_VERSION : 'transwell-v1', paramsJson: JSON.stringify(parameters), reviewed: false, manualEdited: false, pairConfirmed: false, warnings: [...loaded.warnings, ...result.qc], updatedAt: new Date().toISOString() };
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
function initialScratchDraft(record: ResultRecord, frame: RGBAFrame) {
  const original = JSON.parse(record.paramsJson) as ScratchParameters;
  const top = Math.floor(frame.height * original.roiTopPct / 100), bottom = Math.ceil(frame.height * original.roiBottomPct / 100);
  const steps = Math.max(1, Math.ceil((bottom - top) / Math.min(2, original.rowStep)));
  return Array.from({ length: steps + 1 }, (_, i) => ({ y: top + (bottom - top) * i / steps, left: frame.width * 0.4, right: frame.width * 0.6 }));
}
function drawOverlay(context: CanvasRenderingContext2D, frame: RGBAFrame, lineStyle: LineStyle, record?: ResultRecord, anchors = false) {
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  if (!record || record.error) return;
  const width = Math.max(2, frame.width / 600);
  if (record.scratch?.boundaries.length) {
    const edges = scratchDisplayEdges(record.scratch.boundaries, lineStyle.type, frame.width);
    context.lineWidth = lineStyle.widthPx; context.strokeStyle = lineStyle.color;
    for (const side of ['left', 'right'] as const) { context.beginPath(); edges.forEach((edge, i) => i ? context.lineTo(edge[side], edge.y) : context.moveTo(edge[side], edge.y)); context.stroke(); }
    if (anchors) for (const i of anchorIndices(edges)) for (const side of ['left', 'right'] as const) { context.beginPath(); context.arc(edges[i][side], edges[i].y, width * 3, 0, Math.PI * 2); context.fillStyle = '#fff'; context.fill(); context.strokeStyle = lineStyle.color; context.stroke(); }
  } else if (record.points) {
    context.lineWidth = width; context.strokeStyle = '#11b9a6';
    for (const point of record.points) { context.beginPath(); context.arc(point.x, point.y, Math.max(4, frame.width / 220), 0, Math.PI * 2); context.stroke(); }
  }
}
function displayMetadata(settings: BackgroundSettings, result: ReturnType<typeof normalizeBackground>, lineStyle?: LineStyle) {
  return { settings, estimate: result.estimate, gains: result.gains, clippedFraction: result.clippedFraction, warnings: result.warnings, displayOnly: true, analysisUsesRawPixels: true, ...(lineStyle ? { lineStyle, measurementBoundary: 'actual-contour' } : {}) };
}

export default function MigrationAnalyzer({ mode }: { mode: Mode }) {
  const title = mode === 'scratch' ? '划痕分析' : 'Transwell 穿膜细胞计数';
  const currentVersion = mode === 'scratch' ? SCRATCH_ALGORITHM_VERSION : 'transwell-v1';
  const [entries, setEntries] = useState<Entry[]>([]), [activeKey, setActiveKey] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null), [records, setRecords] = useState<Record<string, ResultRecord>>({});
  const [parameters, setParameters] = useState<Parameters>(mode === 'scratch' ? DEFAULT_SCRATCH_PARAMETERS : DEFAULT_TRANSWELL_PARAMETERS);
  const [backgroundSettings, setBackgroundSettings] = useState<BackgroundSettings>(DEFAULT_BACKGROUND_SETTINGS);
  const [lineStyle, setLineStyle] = useState<LineStyle>(DEFAULT_LINE_STYLE);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [overlay, setOverlay] = useState(true), [editing, setEditing] = useState(false), [zoom, setZoom] = useState('fit');
  const [scratchDraft, setScratchDraft] = useState<ScratchBoundary[] | null>(null);
  const [editMode, setEditMode] = useState<'trace' | 'move'>('trace'), [editRadius, setEditRadius] = useState(32);
  const [undoStack, setUndoStack] = useState<ResultRecord[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null), [downloadLink, setDownloadLink] = useState<{ url: string; name: string } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null), fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const cancel = useRef(false), loadVersion = useRef(0);
  const stroke = useRef<ScratchStroke | null>(null);
  const paramsJson = JSON.stringify(parameters), active = entries.find(entry => entry.key === activeKey), record = records[activeKey];
  const currentIndex = entries.findIndex(entry => entry.key === activeKey), stale = Boolean(record && (record.paramsJson !== paramsJson || record.algorithmVersion !== currentVersion));
  const exportRows: MigrationCsvRow[] = entries.map(entry => {
    const item = records[entry.key];
    return item ? { ...item, error: item.error ?? item.lastRunError, status: item.lastRunError ? '本次失败；保留人工结果' : item.error ? '失败' : item.paramsJson !== paramsJson || item.algorithmVersion !== currentVersion ? '参数/算法已改变；保留原结果' : item.reviewed ? '已复核' : item.manualEdited ? '已修正，待复核' : '自动结果，待复核' } : { path: entry.path, paramsJson, algorithmVersion: currentVersion, reviewed: false, manualEdited: false, warnings: [], status: '未处理' };
  });
  const closure = mode === 'scratch' && record ? scratchClosure(record, exportRows) : null;
  const parsed = active && mode === 'scratch' ? parseScratchFile(active.path) : null;
  const display = useMemo(() => loaded ? normalizeBackground(loaded.frame, backgroundSettings, loaded.background) : null, [loaded, backgroundSettings]);

  function fail(entry: Entry, frozen: Parameters, cause: unknown, source?: Loaded) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const previous = records[entry.key];
    if (previous && (previous.manualEdited || previous.reviewed)) {
      setRecords(old => ({ ...old, [entry.key]: { ...previous, lastRunError: reason, warnings: [...previous.warnings.filter(warning => !warning.startsWith('本次处理失败')), `本次处理失败，保留人工结果：${reason}`], updatedAt: new Date().toISOString() } }));
      return reason;
    }
    const failed: ResultRecord = { key: entry.key, path: entry.path, paramsJson: JSON.stringify(frozen), algorithmVersion: currentVersion, width: source?.frame.width, height: source?.frame.height, sourceHash: source?.hash, reviewed: false, manualEdited: false, warnings: [], error: reason, updatedAt: new Date().toISOString() };
    setRecords(old => ({ ...old, [entry.key]: failed })); return reason;
  }
  async function openImage(entry: Entry) {
    const version = ++loadVersion.current;
    endEditing(true); setActiveKey(entry.key); setLoaded(null); setError(''); setBusy('正在读取…');
    let source: Loaded | undefined;
    try {
      source = await readEntry(entry); if (version !== loadVersion.current) return;
      setLoaded(source);
      const existing = records[entry.key];
      if (existing && existing.sourceHash === source.hash && !existing.error && ((existing.paramsJson === paramsJson && existing.algorithmVersion === currentVersion) || existing.manualEdited || existing.reviewed)) {
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
    endEditing(true); setBusy('正在分析…'); setError(''); await tick();
    try { const result = await processFrame(mode, loaded.frame, parameters); setRecords(old => ({ ...old, [active.key]: makeRecord(active, loaded, parameters, result, mode) })); }
    catch (cause) { setError(fail(active, parameters, cause, loaded)); }
    finally { setBusy(''); }
  }
  async function analyzeAll() {
    if (!entries.length || busy) return;
    const frozen = { ...parameters }, signature = JSON.stringify(frozen), queue = [...entries];
    const status: Progress = { running: true, done: 0, total: queue.length, failed: 0, skipped: 0, stopped: false, issues: [] };
    cancel.current = false; endEditing(true); setProgress({ ...status }); setError(''); setMessage('');
    try {
      for (let i = 0; i < queue.length; i++) {
        if (cancel.current) { status.stopped = true; break; }
        const entry = queue[i], previous = records[entry.key];
        setBusy(`正在分析 ${i + 1} / ${queue.length}…`); await tick();
        if (previous && !previous.error && (previous.manualEdited || previous.reviewed) && (previous.paramsJson !== signature || previous.algorithmVersion !== currentVersion)) {
          status.skipped++; status.issues.push(`${entry.path}：参数或算法不同，保留人工结果。`);
        } else {
          let source: Loaded | undefined;
          try {
            source = entry.key === activeKey && loaded ? loaded : await readEntry(entry);
            if (!previous || previous.error || previous.sourceHash !== source.hash || previous.paramsJson !== signature || previous.algorithmVersion !== currentVersion) {
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
  function updateBackground(change: Partial<BackgroundSettings>) {
    setBackgroundSettings(old => ({ ...old, ...change })); setDownloadLink(null);
  }
  function updateLineStyle(change: Partial<LineStyle>) {
    setLineStyle(old => ({ ...old, ...change })); setDownloadLink(null);
  }
  function cancelScratchStroke(clearDraft = false) {
    const pending = stroke.current; stroke.current = null;
    if (clearDraft) setScratchDraft(null); else if (pending) setScratchDraft(pending.beforeDraft);
    if (pending && canvas.current?.hasPointerCapture(pending.pointerId)) canvas.current.releasePointerCapture(pending.pointerId);
  }
  function endEditing(clearHistory = false) {
    cancelScratchStroke(true); setEditing(false);
    if (clearHistory) setUndoStack([]);
  }
  function beginEditing() {
    if (!record || !loaded || stale) return;
    if (editing) { endEditing(); return; }
    setOverlay(true); setEditing(true);
    if (mode === 'scratch' && !record.scratch?.boundaries.length) setScratchDraft(initialScratchDraft(record, loaded.frame));
  }
  function pointerPosition(event: { clientX: number; clientY: number }, surface: HTMLCanvasElement) {
    const rect = surface.getBoundingClientRect(), frame = loaded!.frame;
    return { x: Math.max(0, Math.min(frame.width, (event.clientX - rect.left) / rect.width * frame.width)), y: Math.max(0, Math.min(frame.height, (event.clientY - rect.top) / rect.height * frame.height)), tolerance: 14 * frame.width / rect.width };
  }
  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!editing || !loaded || !record || busy || stale || stroke.current || event.button !== 0) return;
    const point = pointerPosition(event, event.currentTarget);
    if (mode === 'transwell') {
      const points = [...(record.points ?? [])]; let nearest = -1, distance = point.tolerance;
      points.forEach((candidate, i) => { const d = Math.hypot(candidate.x - point.x, candidate.y - point.y); if (d < distance) { nearest = i; distance = d; } });
      if (nearest >= 0) points.splice(nearest, 1); else points.push({ x: point.x, y: point.y });
      updateRecord({ points, correctedCount: points.length, manualEdited: true, reviewed: false }); return;
    }
    const boundaries = scratchDraft ?? record.scratch?.boundaries ?? [];
    let closest: { side: ScratchSide; point: TracePoint; distance: number } | null = null;
    for (let i = 1; i < boundaries.length; i++) for (const side of ['left', 'right'] as const) {
      const a = boundaries[i - 1], b = boundaries[i], dx = b[side] - a[side], dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((point.x - a[side]) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      const hit = { x: a[side] + dx * t, y: a.y + dy * t }, distance = Math.hypot(hit.x - point.x, hit.y - point.y);
      if (distance < point.tolerance && (!closest || distance < closest.distance)) closest = { side, point: hit, distance };
    }
    if (!closest) return;
    point.y = Math.max(boundaries[0].y, Math.min(boundaries[boundaries.length - 1].y, point.y));
    stroke.current = { key: activeKey, hash: loaded.hash, paramsJson, pointerId: event.pointerId, side: closest.side, mode: editMode, radiusPx: editRadius, start: point, centerY: closest.point.y, last: closest.point, base: boundaries, boundaries, before: record, beforeDraft: scratchDraft, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault();
  }
  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const pending = stroke.current;
    if (!pending || pending.pointerId !== event.pointerId || !loaded) return;
    if (!editing || busy || stale || pending.key !== activeKey || pending.hash !== loaded.hash || pending.paramsJson !== paramsJson) { cancelScratchStroke(true); return; }
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of [...coalesced, event.nativeEvent]) {
      const point = pointerPosition(sample, event.currentTarget);
      point.y = Math.max(pending.base[0].y, Math.min(pending.base[pending.base.length - 1].y, point.y));
      if (!pending.moved && Math.hypot(point.x - pending.start.x, point.y - pending.start.y) < 0.5) continue;
      pending.moved = true;
      pending.boundaries = pending.mode === 'move'
        ? moveScratchBoundary(pending.base, pending.side, pending.centerY, point.x - pending.start.x, pending.radiusPx, loaded.frame.width)
        : traceScratchSegment(pending.boundaries, pending.side, pending.last, point, loaded.frame.width);
      pending.last = point;
    }
    if (pending.moved) setScratchDraft(pending.boundaries);
  }
  function pointerUp(event: React.PointerEvent<HTMLCanvasElement>) {
    if (stroke.current?.pointerId !== event.pointerId) return;
    pointerMove(event);
    const pending = stroke.current;
    cancelScratchStroke();
    if (!pending?.moved || !loaded || busy || stale || pending.key !== activeKey || pending.hash !== loaded.hash || pending.paramsJson !== paramsJson) return;
    const changed = pending.boundaries.length !== pending.base.length || pending.boundaries.some((edge, i) => edge.y !== pending.base[i].y || edge.left !== pending.base[i].left || edge.right !== pending.base[i].right);
    if (!changed) return;
    const measured = measureScratch(pending.boundaries, loaded.frame.width, loaded.frame.height);
    const next: ResultRecord = { ...pending.before, scratch: { ...measured, boundaries: pending.boundaries }, areaPx: measured.areaPx, meanWidthPx: measured.meanWidthPx, warnings: [...new Set([...pending.before.warnings, ...loaded.warnings, ...measured.qc])], manualEdited: true, reviewed: false, pairConfirmed: false, updatedAt: new Date().toISOString() };
    setUndoStack(old => [...old.slice(-19), pending.before]);
    setRecords(old => ({ ...old, [pending.key]: next })); setScratchDraft(null); setDownloadLink(null);
  }
  function undoScratch() {
    if (!undoStack.length || !loaded || busy || stale) return;
    cancelScratchStroke(true);
    const previous = undoStack[undoStack.length - 1];
    if (previous.key !== activeKey || previous.sourceHash !== loaded.hash || previous.paramsJson !== paramsJson) return;
    setRecords(old => ({ ...old, [activeKey]: previous })); setUndoStack(old => old.slice(0, -1)); setDownloadLink(null);
    if (editing && !previous.scratch?.boundaries.length) setScratchDraft(initialScratchDraft(previous, loaded.frame));
  }
  function resetManual() {
    if (!record) return;
    cancelScratchStroke(true);
    if (mode === 'scratch' && record.autoScratch) {
      setUndoStack(old => [...old.slice(-19), record]);
      updateRecord({ scratch: record.autoScratch, areaPx: record.autoScratch.areaPx, meanWidthPx: record.autoScratch.meanWidthPx, warnings: [...(loaded?.warnings ?? []), ...record.autoScratch.qc], manualEdited: false, reviewed: false, pairConfirmed: false });
      if (editing && !record.autoScratch.boundaries.length && loaded) setScratchDraft(initialScratchDraft(record, loaded.frame));
    }
    if (mode === 'transwell') updateRecord({ points: record.autoPoints, correctedCount: record.autoCount, manualEdited: false, reviewed: false });
  }
  function presentDownload(blob: Blob, name: string) {
    const url = URL.createObjectURL(blob); setDownloadLink({ url, name });
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  }
  function exportCsv() { presentDownload(new Blob([makeMigrationCsv(mode, exportRows)], { type: 'text/csv;charset=utf-8' }), `${mode === 'scratch' ? '划痕' : 'Transwell'}_全部结果.csv`); }
  async function exportImages(adjustedOnly: boolean) {
    const targets = adjustedOnly ? [...entries] : entries.filter(entry => records[entry.key] && !records[entry.key].error);
    if (!targets.length || busy || (adjustedOnly && !backgroundSettings.enabled)) return;
    const frozen = { ...backgroundSettings }, frozenLineStyle = { ...lineStyle }, label = adjustedOnly ? '调整图' : '标记图';
    const exportedLineStyle = mode === 'scratch' && !adjustedOnly ? frozenLineStyle : undefined;
    const status: Progress = { running: true, done: 0, total: targets.length, failed: 0, skipped: 0, stopped: false, issues: [] };
    cancel.current = false; endEditing(); setProgress({ ...status }); setBusy(`正在生成${label}…`); setError(''); setMessage(''); setDownloadLink(null);
    const files: ExportArchiveEntry[] = [], images: Array<{ path: string; status: string; [key: string]: unknown }> = [];
    const output = document.createElement('canvas'), context = output.getContext('2d');
    let completed = 0;
    try {
      if (!context) throw new Error('无法创建图像画布。');
      for (let i = 0; i < targets.length; i++) {
        if (cancel.current) { status.stopped = true; break; }
        const entry = targets[i], item = records[entry.key];
        const image: { path: string; status: string; [key: string]: unknown } = { path: entry.path, status: 'failed' };
        setBusy(`正在导出${label} ${i + 1} / ${targets.length}…`); await tick();
        try {
          const input = entry.key === activeKey && loaded ? loaded : await readEntry(entry);
          image.sourceHash = input.hash; image.width = input.frame.width; image.height = input.frame.height; image.sourceWarnings = input.warnings;
          if (!adjustedOnly && input.hash !== item.sourceHash) throw new Error('源文件已改变，请重新分析。');
          const adjusted = normalizeBackground(input.frame, frozen, input.background), metadata = displayMetadata(frozen, adjusted, exportedLineStyle);
          image.display = metadata;
          if (frozen.enabled && !adjusted.estimate.valid) throw new Error(adjusted.warnings.join('；') || '无法可靠估计背景。');
          output.width = input.frame.width; output.height = input.frame.height; drawOverlay(context, adjusted.frame, frozenLineStyle, adjustedOnly ? undefined : item);
          const blob = await new Promise<Blob>((resolve, reject) => output.toBlob(value => value ? resolve(value) : reject(new Error('PNG 编码失败')), 'image/png'));
          const stem = `${String(i + 1).padStart(4, '0')}_${safeFilePart(entry.file.name.replace(/\.[^.]+$/, ''))}`;
          const imageFile = `${stem}_${adjustedOnly ? 'adjusted' : 'overlay'}.png`, displayFile = `_metadata/${stem}.display.json`, analysisFile = `_metadata/${stem}.analysis.json`;
          files.push({ name: imageFile, data: new Uint8Array(await blob.arrayBuffer()) }, { name: displayFile, data: new TextEncoder().encode(JSON.stringify({ path: entry.path, sourceHash: input.hash, width: input.frame.width, height: input.frame.height, ...metadata }, null, 2)) });
          if (!adjustedOnly) files.push({ name: analysisFile, data: new TextEncoder().encode(JSON.stringify(item, null, 2)) });
          image.status = 'completed'; image.imageFile = imageFile; image.displayFile = displayFile; if (!adjustedOnly) image.analysisFile = analysisFile; completed++;
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          image.error = reason; status.failed++; status.issues.push(`${entry.path}：${reason}`);
        }
        images.push(image); status.done++; setProgress({ ...status, issues: [...status.issues] });
      }
      status.stopped ||= cancel.current && status.done < status.total;
      images.push(...targets.slice(status.done).map(entry => ({ path: entry.path, status: 'unprocessed' })));
      if (!completed) throw new Error(`没有成功导出的${label}。${status.issues[0] || (status.stopped ? '已停止。' : '')}`);
      if (!adjustedOnly) files.push({ name: 'results.csv', data: new TextEncoder().encode(makeMigrationCsv(mode, exportRows)) });
      files.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify({ mode, kind: adjustedOnly ? 'adjusted-images' : 'analysis-overlays', settings: frozen, ...(exportedLineStyle ? { lineStyle: exportedLineStyle } : {}), displayOnly: true, analysisUsesRawPixels: true, requested: targets.length, completed, failed: status.failed, stopped: status.stopped, unprocessed: targets.length - status.done, images, issues: status.issues, exportedAt: new Date().toISOString() }, null, 2)) });
      setBusy('正在打包 ZIP…'); await tick();
      const zip = await createStoredZip(files); presentDownload(new Blob([zip], { type: 'application/zip' }), `${mode}_${completed < targets.length ? '部分完成_' : ''}${label}.zip`);
      setMessage(`${label}已导出 ${completed}/${targets.length}${status.failed ? `；失败 ${status.failed} 张` : ''}${status.stopped ? '；已停止' : ''}。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { status.running = false; setProgress({ ...status, issues: [...status.issues] }); output.width = 0; output.height = 0; setBusy(''); }
  }
  useEffect(() => () => { if (downloadLink) URL.revokeObjectURL(downloadLink.url); }, [downloadLink]);
  useEffect(() => {
    if (!loaded || !canvas.current) return;
    canvas.current.width = loaded.frame.width; canvas.current.height = loaded.frame.height;
    const shown = scratchDraft && record ? { ...record, scratch: { ...record.scratch, boundaries: scratchDraft } as ScratchResult } : record;
    const previewStyle = editing ? { ...lineStyle, type: 'contour' as const } : lineStyle;
    const context = canvas.current.getContext('2d'); if (context) drawOverlay(context, display?.frame ?? loaded.frame, previewStyle, overlay ? shown : undefined, editing && mode === 'scratch' && editMode === 'move');
  }, [loaded, display, lineStyle, record, overlay, editing, mode, editMode, scratchDraft]);

  const controls: Array<{ key: string; label: string; min: number; max: number; step?: number }> = mode === 'scratch'
    ? [{ key: 'textureThreshold', label: '纹理阈值', min: 0.1, max: 128, step: 0.1 }, { key: 'centerXPct', label: '划痕中心 (%)', min: 1, max: 99 }, { key: 'roiTopPct', label: 'ROI 上缘 (%)', min: 0, max: 99.9, step: 0.1 }, { key: 'roiBottomPct', label: 'ROI 下缘 (%)', min: 0.1, max: 100, step: 0.1 }, { key: 'windowRadius', label: '纹理窗口半径', min: 1, max: 100 }, { key: 'minGapWidth', label: '最小划痕宽 (px)', min: 1, max: 10000 }, { key: 'rowStep', label: '边界采样间隔', min: 1, max: 100 }]
    : [{ key: 'stainThreshold', label: '染色阈值', min: 1, max: 255 }, { key: 'minArea', label: '最小面积 (px²)', min: 1, max: 100000 }, { key: 'peakDistance', label: '细胞中心间距 (px)', min: 1, max: 1000 }, { key: 'maxBrightness', label: '最大亮度', min: 1, max: 255 }, { key: 'minPeakRadius', label: '最小中心半径', min: 1, max: 100 }, { key: 'clusterArea', label: '大团块面积 (px²)', min: 1, max: 1000000 }];
  const control = (item: typeof controls[number]) => <label key={item.key}>{item.label}<input type="number" min={item.min} max={item.max} step={item.step ?? 1} value={Number((parameters as unknown as Record<string, unknown>)[item.key])} disabled={!!busy} onChange={event => { endEditing(true); setParameters(old => ({ ...old, [item.key]: +event.target.value })); setDownloadLink(null); }} /></label>;
  return <div className="migration-app">
    <header className="migration-header"><a className="migration-brand" href="../"><span>✳</span> FluoroScope</a><nav><a href="../intensity/">荧光</a><a href="../edu/">EdU</a><a href="../scratch/" aria-current={mode === 'scratch' ? 'page' : undefined}>划痕</a><a href="../transwell/" aria-current={mode === 'transwell' ? 'page' : undefined}>Transwell</a><a href="../cck8/">CCK-8</a><a href="../if-count/">切片计数</a></nav><small>本地处理</small></header>
    <main className="migration-main"><div className="migration-heading"><h1>{title}</h1><div><button className="quiet" disabled={!entries.length || !!busy} onClick={() => { ++loadVersion.current; endEditing(true); setEntries([]); setRecords({}); setLoaded(null); setActiveKey(''); setProgress(null); setError(''); setMessage(''); setDownloadLink(null); }}>清空列表</button><button disabled={!!busy} onClick={() => fileInput.current?.click()}>选择图像</button><button className="primary" disabled={!!busy} onClick={() => folderInput.current?.click()}>导入文件夹</button></div></div>
      <input hidden ref={fileInput} type="file" multiple accept=".png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp" onChange={event => { void importFiles(event.target.files); event.target.value = ''; }} /><input hidden ref={folderInput} type="file" multiple {...({ webkitdirectory: '' } as Record<string, string>)} onChange={event => { void importFiles(event.target.files); event.target.value = ''; }} />
      {error && <div className="migration-error" role="alert">{error}</div>}{message && <div className="migration-message" role="status">{message}</div>}
      <div className="migration-workspace"><aside className="migration-controls">
        {entries.length > 0 && <><select aria-label="图像列表" disabled={!!busy} value={activeKey} onChange={event => { const entry = entries.find(item => item.key === event.target.value); if (entry) void openImage(entry); }}>{entries.map(entry => <option key={entry.key} value={entry.key}>{records[entry.key]?.error || records[entry.key]?.lastRunError ? '失败 · ' : records[entry.key]?.reviewed ? '✓ ' : records[entry.key] ? '已算 · ' : ''}{entry.path}</option>)}</select><div className="migration-prev-next"><button disabled={!!busy || currentIndex <= 0} onClick={() => void openImage(entries[currentIndex - 1])}>←</button><span>{currentIndex + 1} / {entries.length}</span><button disabled={!!busy || currentIndex === entries.length - 1} onClick={() => void openImage(entries[currentIndex + 1])}>→</button></div></>}
        <div className="migration-basic-controls">{controls.slice(0, 2).map(control)}</div><details><summary>更多参数</summary><div className="migration-parameter-grid">{controls.slice(2).map(control)}</div>{mode === 'transwell' && <label className="check"><input type="checkbox" checked={(parameters as TranswellParameters).excludeEdge} disabled={!!busy} onChange={event => { endEditing(true); setParameters(old => ({ ...old, excludeEdge: event.target.checked })); }} />排除触边对象</label>}</details>
        <details className="migration-background-settings"><summary>背景设置</summary><label>目标亮度<input type="number" min={160} max={250} defaultValue={backgroundSettings.target} disabled={!!busy} onBlur={event => { const value = Number(event.target.value); const target = event.target.value && Number.isFinite(value) ? Math.max(160, Math.min(250, value)) : backgroundSettings.target; event.target.value = String(target); updateBackground({ target }); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label><label className="check"><input type="checkbox" checked={backgroundSettings.matchColor} disabled={!!busy} onChange={event => updateBackground({ matchColor: event.target.checked })} />同时统一色调</label><p>逐张估计背景，共用目标。仅调整显示与导出，分析仍用原图。</p></details>
        {mode === 'scratch' && <details><summary>边界设置</summary>
          <label>线条类型<select aria-label="边界线条类型" value={lineStyle.type} disabled={!!busy || editing} onChange={event => updateLineStyle({ type: event.target.value as ScratchLineType })}><option value="contour">贴合细胞</option><option value="straight">直线</option></select></label>
          <p className="migration-line-note">仅调整显示与导出，测量仍用实际边界。</p>
          <label>颜色<span className="migration-line-color"><input type="color" aria-label="边界颜色" value={lineStyle.color} disabled={!!busy} onChange={event => updateLineStyle({ color: event.target.value })} /><input key={lineStyle.color} type="text" aria-label="边界颜色 HEX" defaultValue={lineStyle.color} maxLength={7} spellCheck={false} disabled={!!busy} onBlur={event => { const color = /^#[0-9a-f]{6}$/i.test(event.target.value) ? event.target.value.toLowerCase() : lineStyle.color; event.target.value = color; updateLineStyle({ color }); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></span></label>
          <label>粗细（原图 px）<input type="number" min={0.5} max={12} step={0.5} defaultValue={lineStyle.widthPx} disabled={!!busy} onBlur={event => { const value = Number(event.target.value); const widthPx = event.target.value && Number.isFinite(value) ? Math.round(Math.max(0.5, Math.min(12, value)) * 2) / 2 : lineStyle.widthPx; event.target.value = String(widthPx); updateLineStyle({ widthPx }); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
        </details>}
        <button className="wide" disabled={!loaded || !!busy} onClick={() => void analyzeCurrent()}>重算此图</button><button className="primary wide" disabled={!entries.length || !!busy} onClick={() => void analyzeAll()}>一键分析全部</button>
        {progress?.running && <div className="migration-progress"><span>{progress.done} / {progress.total}</span><button onClick={() => { cancel.current = true; setMessage('当前图完成后停止。'); }}>停止</button></div>}
        <p className="migration-qc-note">自动结果请核对</p>
        {record && !record.error && <div className="migration-edit-controls">
          <button className={editing ? 'selected wide' : 'wide'} disabled={!!busy || stale} onClick={beginEditing}>{editing ? '完成修改' : mode === 'scratch' ? (record.scratch?.boundaries.length ? '编辑左右边界' : '手动画边界') : '添加 / 删除标记'}</button>
          {editing && mode === 'scratch' && lineStyle.type === 'straight' && <p className="migration-line-note">编辑时显示实际轮廓，完成后恢复直线。</p>}
          {mode === 'scratch' && editing && <div className="migration-scratch-tools"><div className="migration-edit-modes" aria-label="边界编辑模式">
            <button className={editMode === 'trace' ? 'selected' : ''} aria-pressed={editMode === 'trace'} disabled={!!busy || stale} onClick={() => { cancelScratchStroke(); setEditMode('trace'); }}>沿边描画</button>
            <button className={editMode === 'move' ? 'selected' : ''} aria-pressed={editMode === 'move'} disabled={!!busy || stale} onClick={() => { cancelScratchStroke(); setEditMode('move'); }}>局部拖动</button>
          </div>{editMode === 'move' && <label>影响范围（原图 px）<input type="number" min={1} max={512} step={1} defaultValue={editRadius} disabled={!!busy || stale} onBlur={event => { cancelScratchStroke(); const value = Number(event.target.value); const radius = event.target.value && Number.isFinite(value) ? Math.max(1, Math.min(512, value)) : editRadius; event.target.value = String(radius); setEditRadius(radius); }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>}</div>}
          {mode === 'scratch' && <button className="wide" disabled={!!busy || stale || !undoStack.length} onClick={undoScratch}>撤销一步</button>}
          <button className="wide" disabled={!!busy || !record.manualEdited || stale} onClick={resetManual}>恢复自动结果</button>
          <label className="check"><input type="checkbox" checked={record.reviewed} disabled={!!busy || stale || (mode === 'scratch' && !record.scratch?.valid)} onChange={event => updateRecord({ reviewed: event.target.checked })} />已复核</label>
          {mode === 'scratch' && parsed?.timeHours !== null && parsed?.timeHours !== 0 && closure?.baselinePath && <label className="check"><input type="checkbox" checked={!!record.pairConfirmed} disabled={!!busy || stale} onChange={event => updateRecord({ pairConfirmed: event.target.checked })} />与 0H 为同一视野</label>}
        </div>}
        <div className="migration-downloads"><button disabled={!exportRows.length || !!busy} onClick={exportCsv}>全部结果 CSV</button><button disabled={!Object.values(records).some(item => !item.error) || !!busy} onClick={() => void exportImages(false)}>全部标记图 ZIP</button><button className="background-export" disabled={!entries.length || !backgroundSettings.enabled || !!busy} onClick={() => void exportImages(true)}>全部调整图 ZIP</button>{downloadLink && <a href={downloadLink.url} download={downloadLink.name}>下载文件</a>}</div>
      </aside><section className="migration-stage-column">
        <div className="migration-stage"><div className="migration-toolbar"><label className="check"><input type="checkbox" checked={overlay} onChange={event => { setOverlay(event.target.checked); if (!event.target.checked) endEditing(); }} />显示标记</label><label className="check"><input type="checkbox" checked={backgroundSettings.enabled} disabled={!!busy} onChange={event => updateBackground({ enabled: event.target.checked })} />统一背景</label>{editing && <span>{mode === 'scratch' ? (editMode === 'trace' ? '从边界旁描画，抬起完成' : '局部拖动，保留凹凸') : '点击添加；点中标记删除'}</span>}<select aria-label="缩放" value={zoom} onChange={event => setZoom(event.target.value)}><option value="fit">适应视野</option><option value="0.5">50%</option><option value="1">100%</option><option value="2">200%</option></select></div>
          <div className={`migration-canvas ${loaded ? '' : 'empty'}`} aria-busy={!!busy}>{loaded ? <canvas ref={canvas} style={zoom === 'fit' ? { width: '100%', height: 'auto' } : { width: loaded.frame.width * +zoom, height: loaded.frame.height * +zoom }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={event => { if (stroke.current?.pointerId === event.pointerId) cancelScratchStroke(); }} onLostPointerCapture={event => { if (stroke.current?.pointerId === event.pointerId) cancelScratchStroke(); }} aria-label={mode === 'scratch' ? '划痕边界预览，可沿边描画或局部拖动' : '穿膜细胞标记预览，可添加或删除候选点'} /> : <div className="migration-empty"><div>{mode === 'scratch' ? 'Ⅱ' : '⠿'}</div><h2>选择图像开始</h2><p>支持 TIFF · PNG · JPEG</p></div>}{busy && <div className="migration-processing" role="status"><i />{busy}</div>}</div>
          <div className="migration-meta"><span>{active?.path || '图像保留在本机'}</span><span>{loaded ? `${loaded.frame.width} × ${loaded.frame.height} px` : ''}</span></div></div>
        {record?.lastRunError && <div className="migration-stale">本次处理失败，当前显示保留的人工结果。</div>}
        {stale && <div className="migration-stale">参数或算法已改变，当前保留旧结果。点击「重算此图」更新。</div>}
        {backgroundSettings.enabled && display && !display.estimate.valid && <div className="migration-stale" role="status">背景估计不可靠，当前保留原图。</div>}
        {backgroundSettings.enabled && display && <details className="migration-warning"><summary>背景调整详情{display.warnings.length ? ` (${display.warnings.length})` : ''}</summary><p>估计 RGB：{display.estimate.rgb.join(' / ')} → 目标 {backgroundSettings.target}；增益 {display.gains.map(gain => gain.toFixed(2)).join(' / ')}；截断 {(display.clippedFraction * 100).toFixed(2)}%。</p>{display.warnings.length > 0 && <ul>{display.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}</details>}
        {record && !record.error && <div className="migration-stats">{mode === 'scratch' ? <><article><span>伤口面积</span><strong>{numberText(record.areaPx)}</strong><small>px²</small></article><article><span>平均宽度</span><strong>{numberText(record.meanWidthPx, 1)}</strong><small>px</small></article><article><span>{record.pairConfirmed ? '闭合率' : '闭合率（待核对）'}</span><strong>{closure?.closurePct == null ? '—' : `${numberText(closure.closurePct, 1)}%`}</strong><small>{closure?.status}</small></article></> : <><article><span>自动估计数</span><strong>{record.autoCount}</strong></article><article><span>修正后计数</span><strong>{record.correctedCount}</strong></article><article><span>染色覆盖率</span><strong>{numberText(record.coveragePct, 1)}%</strong><small>大团块 {record.clusterCount ?? 0}</small></article></>}</div>}
        {record?.warnings.length ? <details className="migration-warning"><summary>质控提示 ({record.warnings.length})</summary><ul>{record.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details> : null}
        {progress && !progress.running && progress.issues.length > 0 && <details className="migration-warning"><summary>批量处理明细 ({progress.issues.length})</summary><ul>{progress.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></details>}
        <details className="migration-method"><summary>方法与说明</summary>{mode === 'scratch' ? <p>按局部纹理估计纵向划痕左右边界，以边界积分计算面积和平均宽度。可沿边描画或局部拖动修正，保留范围外边界；每笔抬起后更新面积，可撤销。无法识别时不填假零值。闭合率需同一视野 0H、相同尺寸和 ROI；文件名配对仅作提示，必须人工核对。</p> : <p>按染色与亮度筛选区域，再根据空间峰估计穿膜细胞中心；可点击增删标记。重叠细胞、大团块、膜孔和杂质会影响自动计数，请核对；染色面积和覆盖率另行保留。这里只分析图像，不自动划分实验组。</p>}<p>参数变化后旧结果会明确标记。批量会保留参数不同的人工结果；CSV 包含失败、复核、参数和文件来源。关闭页面前请导出。</p></details>
      </section></div>
    </main>
  </div>;
}
