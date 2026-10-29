'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { loadImages, type LoadedImage } from '../lib/image';
import { summarizeIf, type Point, type Region, type Parameters, type Result, type Cell } from '../lib/if-count';
import { groupIfFiles, inferIfChannels, resolveIfChannels, captureIfChannelReference, mapIfChannels, csv } from '../lib/if-count-io';
import { createStoredZip, safeFilePart, type ExportArchiveEntry } from '../lib/export-archive';
import './if-count.css';

type Mapping = { nucleus: string; a: string; b: string };
type Snapshot = { hash: string; width: number; height: number; displayOnly: boolean; format: string; sourceWarnings: string[]; channels: string[]; parameters: Parameters; createdAt: string };
type Field = { id: string; name: string; files: File[]; regions: Region[]; mapping?: Mapping; result?: Result; snapshot?: Snapshot; reviewed: boolean; error?: string };
const defaults: Parameters = { nucleusThreshold: 55, aThreshold: 40, bThreshold: 40, minArea: 35, maxArea: 3000, median: true, excludeEdge: false, radius: 6, minPositiveFraction: 0.04 };
const colors = ['#ffd16a', '#62e2dd', '#ff9c72', '#aeabff', '#8ce3a4'];
const emptyMapping: Mapping = { nucleus: '', a: '', b: '' };
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const n = (value: number | null) => value === null ? '—' : Number.isInteger(value) ? String(value) : value.toFixed(1);

function workerAnalysis(image: LoadedImage, mapping: Mapping, parameters: Parameters, regions: Region[]): Promise<Result> {
  const [nucleus, a, b] = resolveIfChannels(image, mapping);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../lib/if-count.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => { worker.terminate(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result); };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || '计数失败')); };
    worker.postMessage({ nucleus: nucleus.data, a: a.data, b: b.data, width: image.width, height: image.height, parameters, regions });
  });
}

function nativeParameters(image: LoadedImage, mapping: Mapping, parameters: Parameters): Parameters {
  if ([parameters.nucleusThreshold, parameters.aThreshold, parameters.bThreshold].some(value => !Number.isFinite(value) || value < 0 || value > 255)) throw new Error('强度阈值须在 0–255 之间。');
  const [d, a, b] = resolveIfChannels(image, mapping);
  return { ...parameters, nucleusThreshold: parameters.nucleusThreshold / 255 * d.maxValue, aThreshold: parameters.aThreshold / 255 * a.maxValue, bThreshold: parameters.bThreshold / 255 * b.maxValue };
}

function displayRanges(image: LoadedImage, mapping: Mapping, contrast: boolean) {
  return (['nucleus', 'a', 'b'] as const).map(role => {
    const channel = image.channels.find(c => c.id === mapping[role]);
    if (!channel) return [0, 255];
    if (!contrast || image.displayOnly) return [0, channel.maxValue];
    const step = Math.max(1, Math.ceil(channel.data.length / 50000));
    const values: number[] = [];
    for (let i = 0; i < channel.data.length; i += step) values.push(channel.data[i]);
    values.sort((a, b) => a - b);
    const low = values[Math.floor((values.length - 1) * .01)];
    const high = values[Math.floor((values.length - 1) * .998)];
    return high > low ? [low, high] : [0, channel.maxValue];
  });
}

function renderImage(image: LoadedImage, mapping: Mapping, contrast = true) {
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d')!;
  const rgba = ctx.createImageData(image.width, image.height);
  const channel = (id: string) => image.channels.find(c => c.id === id);
  const d = channel(mapping.nucleus), a = channel(mapping.a), b = channel(mapping.b);
  const [dRange, aRange, bRange] = displayRanges(image, mapping, contrast);
  const gray = image.channels.length === 1 ? image.channels[0] : undefined;
  const scale = (value: number, range: number[]) => Math.max(0, Math.min(255, (value - range[0]) / (range[1] - range[0]) * 255));
  for (let i = 0; i < image.width * image.height; i++) {
    const av = a ? scale(a.data[i], aRange) : 0;
    const dv = d ? scale(d.data[i], dRange) : 0;
    const gv = b ? scale(b.data[i], bRange) : 0;
    const v = gray ? scale(gray.data[i], [0, gray.maxValue]) : 0;
    rgba.data[i * 4] = gray ? v : av;
    rgba.data[i * 4 + 1] = gray ? v : gv;
    rgba.data[i * 4 + 2] = gray ? v : Math.min(255, dv + (image.displayOnly ? 0 : av));
    rgba.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(rgba, 0, 0); return canvas;
}

function overlay(ctx: CanvasRenderingContext2D, field: Field, width: number, selected?: number, showCells = true) {
  const unit = Math.max(1, width / 800);
  field.regions.forEach((region, index) => {
    if (!region.points.length) return;
    ctx.beginPath(); region.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
    ctx.strokeStyle = colors[index % colors.length]; ctx.lineWidth = 1.2 * unit; ctx.stroke();
    ctx.font = `${12 * unit}px sans-serif`; ctx.fillStyle = colors[index % colors.length];
    ctx.fillText(region.name, region.points[0].x + 5 * unit, Math.max(15 * unit, region.points[0].y - 5 * unit));
  });
  if (!showCells) return;
  for (const cell of field.result?.cells ?? []) {
    const radius = Math.max(3 * unit, Math.sqrt(cell.area / Math.PI) + unit);
    ctx.strokeStyle = cell.excluded ? '#ff584e' : cell.doublePositive ? '#ffff80' : cell.aPositive ? '#ff79f4' : cell.bPositive ? '#6bff99' : '#7b9ed3';
    ctx.lineWidth = (cell.id === selected ? 2.5 : 0.8) * unit;
    ctx.beginPath(); ctx.arc(cell.x, cell.y, radius, 0, Math.PI * 2); ctx.stroke();
    if (cell.excluded) { ctx.beginPath(); ctx.moveTo(cell.x - radius, cell.y - radius); ctx.lineTo(cell.x + radius, cell.y + radius); ctx.stroke(); }
  }
}

function summaryCsv(fields: Field[]) {
  const rows: (string | number | boolean | null)[][] = [['图像', '区域', '面积_px2', '总核数', 'AF647阳性', 'GFP阳性', 'AF647_GFP双阳性', 'AF647阳性率_%', '双阳性占AF647_%', '已复核', 'RGB估算', '源SHA256', '参数', '区域定义', '最近运行错误_有值则保留旧结果', '计算时间', '检查提示']];
  for (const f of fields) if (f.result && f.snapshot) for (const r of f.result.regions) rows.push([f.name, r.name, r.areaPx, r.total, r.aPositive, r.bPositive, r.doublePositive, r.aPct, r.doubleOfAPct, f.reviewed, f.snapshot.displayOnly, f.snapshot.hash, JSON.stringify(f.snapshot.parameters), JSON.stringify(f.regions), f.error ?? '', f.snapshot.createdAt, f.result.warnings.join('；')]);
  return csv(rows);
}

function cellsCsv(fields: Field[]) {
  const rows: (string | number | boolean | null)[][] = [['图像', '细胞ID', '区域', 'X_px', 'Y_px', '核面积_px2', 'AF647均值', 'GFP均值', 'AF647阳性像素比例', 'GFP阳性像素比例', '双阈值重叠像素比例', 'AF647阳性', 'GFP阳性', '双阳性', '排除', '手动修正', '已复核', 'RGB估算', '源SHA256', '最近运行错误_有值则保留旧结果']];
  for (const f of fields) if (f.result && f.snapshot) for (const c of f.result.cells) rows.push([f.name, c.id, c.regionName, c.x, c.y, c.area, c.aMean, c.bMean, c.aFraction, c.bFraction, c.overlapFraction, c.aPositive, c.bPositive, c.doublePositive, c.excluded, c.manual, f.reviewed, f.snapshot.displayOnly, f.snapshot.hash, f.error ?? '']);
  return csv(rows);
}

export default function IfCountAnalyzer() {
  const [fields, setFields] = useState<Field[]>([]);
  const [activeId, setActiveId] = useState('');
  const [loaded, setLoaded] = useState<{ id: string; image: LoadedImage } | null>(null);
  const [parameters, setParameters] = useState<Parameters>(defaults);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [rgbAllowed, setRgbAllowed] = useState(false);
  const [draw, setDraw] = useState(false);
  const [draft, setDraft] = useState<Point[]>([]);
  const [regionName, setRegionName] = useState('神经束内 1');
  const [regionKind, setRegionKind] = useState<'region' | 'tissue'>('region');
  const [selectedCell, setSelectedCell] = useState<number>();
  const [showCells, setShowCells] = useState(true);
  const [displayContrast, setDisplayContrast] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null), channelsInput = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null), base = useRef<HTMLCanvasElement | null>(null);
  const stop = useRef(false), pointerDown = useRef(false), draftRef = useRef<Point[]>([]), loadSequence = useRef(0);
  const active = fields.find(f => f.id === activeId);
  const image = loaded?.id === activeId ? loaded.image : null;
  const mapping = active?.mapping ?? emptyMapping;
  const completed = fields.filter(f => f.result);
  const cell = active?.result?.cells.find(c => c.id === selectedCell);

  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);
  useEffect(() => {
    base.current = image ? renderImage(image, mapping, displayContrast) : null;
  }, [image, mapping, displayContrast]);
  useEffect(() => {
    const c = canvas.current, original = base.current;
    if (!c || !image || !original || !active) return;
    c.width = image.width; c.height = image.height;
    const ctx = c.getContext('2d')!; ctx.drawImage(original, 0, 0);
    overlay(ctx, active, image.width, selectedCell, showCells);
    if (draft.length) {
      ctx.beginPath(); draft.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, image.width / 700); ctx.stroke();
      for (const p of [draft[0], draft[draft.length - 1]]) { ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3, image.width / 250), 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
    }
  }, [image, mapping, active, draft, selectedCell, showCells, displayContrast]);

  function updateField(id: string, patch: Partial<Field>) {
    setDownload(null);
    setFields(old => old.map(f => f.id === id ? { ...f, ...patch } : f));
  }

  async function selectField(field: Field) {
    const sequence = ++loadSequence.current;
    setActiveId(field.id); setLoaded(null); setSelectedCell(undefined); setDraw(false); setDraft([]); draftRef.current = [];
    setLoading(true); setError('');
    try {
      const data = await loadImages(field.files);
      if (sequence !== loadSequence.current) return;
      setLoaded({ id: field.id, image: data });
      if (!field.mapping) updateField(field.id, { mapping: inferIfChannels(data) });
    } catch (problem) {
      if (sequence === loadSequence.current) { const msg = messageOf(problem); setError(msg); updateField(field.id, { error: msg }); }
    } finally { if (sequence === loadSequence.current) setLoading(false); }
  }

  async function importFiles(list: FileList | null, combine = false) {
    if (!list?.length || busy) return;
    setError(''); setDownload(null);
    try {
      const files = Array.from(list).filter(f => /\.(tiff?|png|jpe?g|oir)$/i.test(f.name));
      if (!files.length) throw new Error('请选择 TIFF、OIR、PNG 或 JPG。');
      const groups = combine ? [{ name: files[0].name.replace(/\.[^.]+$/, '') + '（组合）', files }] : groupIfFiles(files);
      const added: Field[] = groups.map(g => ({ ...g, id: crypto.randomUUID(), regions: [], reviewed: false }));
      setFields(old => [...old, ...added]); setStatus(`已添加 ${added.length} 张切片`);
      await selectField(added[0]);
    } catch (problem) { setError(messageOf(problem)); }
  }

  function changeParameters(patch: Partial<Parameters>) {
    setParameters(old => ({ ...old, ...patch }));
    // Measurements are kept until replaced; each result carries its frozen parameters.
    setDownload(null); setStatus('参数已修改，下次计算生效；现有结果仍保留原参数。');
  }

  async function run(all: boolean) {
    if (!image || !active || busy) return;
    setError(''); setDownload(null);
    try {
      const reference = captureIfChannelReference(image, mapping);
      resolveIfChannels(image, mapping);
      const targets = all ? fields.filter(f => !f.reviewed && !f.result?.cells.some(c => c.manual)) : [active];
      if (!targets.length) { setStatus('已复核或手动修正的结果已保留。'); return; }
      setBusy(true); setRunning(true); stop.current = false;
      const frozen = { ...parameters }; let success = 0, failed = 0;
      for (let i = 0; i < targets.length; i++) {
        if (stop.current) break;
        const f = targets[i]; setStatus(`计算 ${i + 1}/${targets.length} · ${f.name}`);
        try {
          const input = f.id === activeId ? image : await loadImages(f.files);
          if (input.displayOnly && !rgbAllowed) throw new Error('RGB 合并图需勾选“允许 RGB 估算”，正式计数建议原始独立通道。');
          const selected = f.mapping && Object.values(f.mapping).every(Boolean) ? f.mapping : mapIfChannels(input, reference);
          const native = nativeParameters(input, selected, frozen);
          const result = await workerAnalysis(input, selected, native, f.regions);
          result.warnings = [...new Set([...input.warnings, ...result.warnings])];
          const snapshot: Snapshot = { hash: input.hash, width: input.width, height: input.height, displayOnly: input.displayOnly, format: input.format, sourceWarnings: input.warnings, channels: resolveIfChannels(input, selected).map(c => c.label), parameters: native, createdAt: new Date().toISOString() };
          updateField(f.id, { result, snapshot, mapping: selected, reviewed: false, error: undefined }); success++;
        } catch (problem) { updateField(f.id, { error: messageOf(problem) }); failed++; }
      }
      setStatus(`${stop.current ? '已停止' : '计算完成'} · 成功 ${success}，失败 ${failed}${all ? '；已复核及手动修正结果保留' : ''}`);
    } catch (problem) { setError(messageOf(problem)); }
    finally { setBusy(false); setRunning(false); }
  }

  function finishRegion() {
    if (!active || !image || draftRef.current.length < 3) return;
    const points = draftRef.current;
    const regions = [...active.regions, { id: crypto.randomUUID(), name: regionName.trim() || '区域', kind: regionKind, points }];
    try {
      // Geometry validation is shared with measurement, including self-intersections.
      summarizeIf([], regions, image.width, image.height);
      updateField(active.id, { regions, result: undefined, snapshot: undefined, reviewed: false, error: undefined });
      setDraw(false); setDraft([]); draftRef.current = [];
      setRegionName(`神经束内 ${regions.filter(r => r.kind === 'region').length + 1}`); setRegionKind('region');
      setStatus('区域已保存，请重新计算此图。');
    } catch (problem) { setError(messageOf(problem)); }
  }

  function point(event: PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(event.currentTarget.width, (event.clientX - rect.left) / rect.width * event.currentTarget.width)), y: Math.max(0, Math.min(event.currentTarget.height, (event.clientY - rect.top) / rect.height * event.currentTarget.height)) };
  }

  function startPointer(event: PointerEvent<HTMLCanvasElement>) {
    if (busy || !image) return;
    const p = point(event);
    if (draw) {
      event.currentTarget.setPointerCapture(event.pointerId); pointerDown.current = true;
      draftRef.current = [...draftRef.current, p]; setDraft(draftRef.current);
    } else if (active?.result) {
      let best: Cell | undefined, distance = Infinity;
      for (const c of active.result.cells) { const d = Math.hypot(p.x - c.x, p.y - c.y); if (d < distance) { distance = d; best = c; } }
      setSelectedCell(distance < Math.max(20, image.width / 45) ? best?.id : undefined);
    }
  }

  function movePointer(event: PointerEvent<HTMLCanvasElement>) {
    if (!draw || !pointerDown.current || busy) return;
    const p = point(event), last = draftRef.current[draftRef.current.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > Math.max(3, (image?.width ?? 1000) / 250)) {
      draftRef.current = [...draftRef.current, p]; setDraft(draftRef.current);
    }
  }

  function editCell(patch: Partial<Cell>) {
    if (!active?.result || !active.snapshot || !cell) return;
    const cells = active.result.cells.map(c => c.id === cell.id ? { ...c, ...patch, manual: true } : c).map(c => ({ ...c, doublePositive: c.aPositive && c.bPositive }));
    const regions = summarizeIf(cells, active.regions, active.snapshot.width, active.snapshot.height);
    updateField(active.id, { result: { ...active.result, cells, regions }, reviewed: false });
  }

  function offer(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob); setDownload({ name, url });
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  }

  async function exportAll() {
    if (!completed.length || busy) return;
    setBusy(true); setError('');
    const frozen = completed; const entries: ExportArchiveEntry[] = []; const failed: { name: string; error: string }[] = [];
    const bytes = (value: string) => new TextEncoder().encode(value);
    try {
      entries.push({ name: '区域汇总.csv', data: bytes(summaryCsv(frozen)) }, { name: '逐细胞.csv', data: bytes(cellsCsv(frozen)) });
      for (let i = 0; i < frozen.length; i++) {
        const f = frozen[i]; const name = `${String(i + 1).padStart(4, '0')}_${safeFilePart(f.name)}`;
        setStatus(`导出 ${i + 1}/${frozen.length}`);
        const metadata = { name: f.name, sourceFiles: f.files.map(file => file.webkitRelativePath || file.name), snapshot: f.snapshot, mapping: f.mapping, regions: f.regions, reviewed: f.reviewed, latestRunError: f.error ?? null, result: f.result, display: { contrast: displayContrast, rangesDapiAf647Gfp: null as number[][] | null } };
        try {
          const input = await loadImages(f.files);
          if (input.hash !== f.snapshot?.hash) throw new Error('原图校验不一致');
          metadata.display.rangesDapiAf647Gfp = displayRanges(input, f.mapping!, displayContrast);
          const c = renderImage(input, f.mapping!, displayContrast); overlay(c.getContext('2d')!, f, input.width);
          const blob = await new Promise<Blob>((resolve, reject) => c.toBlob(value => value ? resolve(value) : reject(new Error('PNG 生成失败')), 'image/png'));
          entries.push({ name: `${name}_标记.png`, data: await blob.arrayBuffer() });
        } catch (problem) { failed.push({ name: f.name, error: messageOf(problem) }); }
        entries.push({ name: `_metadata/${name}.json`, data: bytes(JSON.stringify(metadata, null, 2)) });
      }
      entries.push({ name: 'manifest.json', data: bytes(JSON.stringify({ schema: 'if-count-v1', markers: ['DAPI', 'AF647', 'GFP'], exportedAt: new Date().toISOString(), fields: frozen.length, imageFailures: failed, retainedPriorResults: frozen.filter(f => f.error).map(f => ({ name: f.name, latestRunError: f.error, resultCreatedAt: f.snapshot?.createdAt })), uncomputed: fields.filter(f => !f.result).map(f => ({ name: f.name, error: f.error ?? '未计算' })), method: '核关联双阳性；按核质心分区；RGB 为探索性估算；未经人工复核不作为最终计数' }, null, 2)) });
      offer('切片计数_全部结果.zip', new Blob([await createStoredZip(entries)], { type: 'application/zip' }));
      setStatus(`已导出 ${frozen.length} 张结果，标记图失败 ${failed.length}`);
    } catch (problem) { setError(messageOf(problem)); } finally { setBusy(false); }
  }

  return <div className="if-app">
    <header className="if-header"><a className="if-brand" href="../">✳ <strong>FluoroScope</strong></a><nav aria-label="分析工具"><a href="../intensity/">荧光</a><a href="../edu/">EdU</a><a href="../scratch/">划痕</a><a href="../transwell/">Transwell</a><a href="../cck8/">CCK-8</a><a aria-current="page" href="../if-count/">切片计数</a></nav><small>图像仅在本地处理</small></header>
    <main className="if-main">
      <div className="if-heading"><div><small>SPATIAL CELL COUNT</small><h1>免疫荧光切片计数</h1></div><div className="if-actions"><button disabled={!completed.length || busy} onClick={() => offer('切片计数_区域汇总.csv', new Blob([summaryCsv(completed)], { type: 'text/csv;charset=utf-8' }))}>汇总 CSV · {completed.length}</button><button disabled={!completed.length || busy} onClick={() => void exportAll()}>全部结果 ZIP</button></div></div>
      {error && <div className="if-alert" role="alert">{error}</div>}
      <div className="if-layout">
        <aside className="if-sidebar">
          <section className="if-card"><h2>切片</h2><div className="if-actions"><button disabled={busy || loading} onClick={() => fileInput.current?.click()}>选择图像</button><button disabled={busy || loading} onClick={() => folderInput.current?.click()}>选择文件夹</button></div>
            <input ref={fileInput} type="file" hidden multiple accept=".tif,.tiff,.oir,.png,.jpg,.jpeg" onChange={e => { void importFiles(e.target.files); e.target.value = ''; }} />
            <input ref={folderInput} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={e => { void importFiles(e.target.files); e.target.value = ''; }} />
            <input ref={channelsInput} type="file" hidden multiple accept=".tif,.tiff,.png,.jpg,.jpeg" onChange={e => { void importFiles(e.target.files, true); e.target.value = ''; }} />
            <button className="if-text" disabled={busy || loading} onClick={() => channelsInput.current?.click()}>组合单通道文件</button>
            <div className="if-files">{fields.map((f, i) => <button key={f.id} aria-pressed={f.id === activeId} disabled={busy || loading} title={f.name} onClick={() => void selectField(f)}><span>{i + 1}. {f.name}</span><small>{f.error ? '失败' : f.reviewed ? '已复核' : f.result ? '待复核' : '未计算'}</small></button>)}</div>
            <div className="if-actions"><button className="primary" disabled={!image || busy || loading || draw} onClick={() => void run(false)}>计算此图</button><button disabled={!image || busy || loading || draw} onClick={() => void run(true)}>计算全部</button>{running && <button onClick={() => { stop.current = true; setStatus('将在当前切片完成后停止'); }}>停止</button>}</div>
            <p className="if-hint" role="status">{status || '先圈区域，再统计细胞。未圈区域时统计全图。'}</p>
            {active?.error && <p className="if-error">{active.error}{active.result ? '（上次成功结果仍保留，导出会注明本次失败）' : ''}</p>}
            {download && <a className="if-download" href={download.url} download={download.name}>下载文件 · {download.name}</a>}
          </section>
          <section className="if-card"><h2>区域</h2><div className="if-regions">{active?.regions.map((r, i) => <div key={r.id}><i style={{ background: colors[i % colors.length] }} /><input aria-label={`区域名称 ${i + 1}`} value={r.name} disabled={busy || draw} onChange={e => { const regions = active.regions.map(v => v.id === r.id ? { ...v, name: e.target.value } : v); updateField(active.id, { regions, result: undefined, snapshot: undefined, reviewed: false }); }} /><button aria-label={`删除区域 ${i + 1}`} disabled={busy || draw} onClick={() => updateField(active.id, { regions: active.regions.filter(v => v.id !== r.id), result: undefined, snapshot: undefined, reviewed: false })}>×</button></div>)}</div>
            <label>区域名称<input aria-label="新区域名称" value={regionName} disabled={busy || draw} onChange={e => setRegionName(e.target.value)} /></label>
            <label>区域类型<select aria-label="区域类型" value={regionKind} disabled={busy || draw} onChange={e => { setRegionKind(e.target.value as 'region' | 'tissue'); setRegionName(e.target.value === 'tissue' ? '束外组织（外膜候选）' : `神经束内 ${(active?.regions.filter(r => r.kind === 'region').length ?? 0) + 1}`); }}><option value="region">单独统计区域</option><option value="tissue">组织外轮廓（扣除内部区域）</option></select></label>
            <div className="if-actions">{!draw ? <button disabled={!image || busy || loading} onClick={() => { setDraw(true); setDraft([]); draftRef.current = []; setSelectedCell(undefined); }}>描画区域</button> : <><button disabled={draft.length < 3} onClick={finishRegion}>完成描边</button><button onClick={() => { draftRef.current = draftRef.current.slice(0, -1); setDraft(draftRef.current); }}>撤回一点</button><button onClick={() => { setDraw(false); setDraft([]); draftRef.current = []; }}>取消</button></>}</div>
            <p className="if-hint">{draw ? '按住拖动描边，或沿边缘逐点点击，最后点完成。' : '可圈多个神经束。外轮廓减去内部区域，得到束外组织。'}</p>
          </section>
          <details className="if-card" open={!fields.length}><summary>通道与计数参数</summary><fieldset disabled={busy || loading || draw}>
            {(['nucleus', 'a', 'b'] as const).map((key, i) => <label key={key}>{['DAPI · 蓝', 'AF647 · 紫', 'GFP · 绿'][i]}<select aria-label={['DAPI 通道', 'AF647 通道', 'GFP 通道'][i]} value={mapping[key]} onChange={e => { if (active) updateField(active.id, { mapping: { ...mapping, [key]: e.target.value }, result: undefined, snapshot: undefined, reviewed: false }); }}><option value="">选择通道</option>{image?.channels.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>)}
            {image?.displayOnly && <label className="if-check if-rgb"><input type="checkbox" checked={rgbAllowed} onChange={e => setRgbAllowed(e.target.checked)} />允许 RGB 估算<p>合并图无法还原纯 DAPI／AF647，结果标为估算。</p></label>}
            <div className="if-param-grid">{([['nucleusThreshold', 'DAPI 阈值'], ['aThreshold', 'AF647 阈值'], ['bThreshold', 'GFP 阈值'], ['minArea', '最小核面积 px²'], ['maxArea', '最大核面积 px²'], ['radius', '核周范围 px']] as const).map(([key, label]) => <label key={key}>{label}<input type="number" aria-label={label} min={key.includes('Threshold') || key === 'radius' ? 0 : 1} max={key.includes('Threshold') ? 255 : key === 'radius' ? 30 : undefined} value={parameters[key]} onChange={e => changeParameters({ [key]: Number(e.target.value) })} /></label>)}</div>
            <label>阳性像素占比 %<input type="number" aria-label="阳性像素占比" min="0.1" max="100" step="0.5" value={Number((parameters.minPositiveFraction * 100).toFixed(3))} onChange={e => changeParameters({ minPositiveFraction: Number(e.target.value) / 100 })} /></label>
            <label className="if-check"><input type="checkbox" checked={parameters.median} onChange={e => changeParameters({ median: e.target.checked })} />核掩膜去小噪点</label><label className="if-check"><input type="checkbox" checked={parameters.excludeEdge} onChange={e => changeParameters({ excludeEdge: e.target.checked })} />排除图像边缘核</label>
            <p className="if-hint">强度阈值按 0–255 输入，计算时映射到原始位深。全部计算保留已复核及手动修正结果。</p>
            {image && <p className="if-hint">原始阈值 DAPI / AF647 / GFP：{(['nucleus', 'a', 'b'] as const).map((role, i) => { const c = image.channels.find(v => v.id === mapping[role]); return c ? n([parameters.nucleusThreshold, parameters.aThreshold, parameters.bThreshold][i] / 255 * c.maxValue) : '—'; }).join(' / ')}</p>}
          </fieldset></details>
        </aside>
        <section className="if-results">
          <div className="if-card if-view"><div className="if-viewbar"><strong>{loading ? '读取中…' : active?.name ?? '图像预览'}</strong>{image && !image.displayOnly && <label className="if-check" title="仅改变预览和标记图亮度，计数使用原始信号"><input type="checkbox" disabled={busy} checked={displayContrast} onChange={e => { setDisplayContrast(e.target.checked); setDownload(null); }} />增强显示</label>}<label className="if-check"><input type="checkbox" checked={showCells} onChange={e => setShowCells(e.target.checked)} />细胞标记</label><label className="if-zoom">缩放<select aria-label="预览缩放" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value="100">适应</option><option value="150">150%</option><option value="250">250%</option><option value="400">400%</option></select></label></div>
            {image ? <div className="if-canvas-scroll"><canvas aria-label="切片图像与区域描边" ref={canvas} style={{ width: zoom === 100 ? 'auto' : `${zoom}%`, maxWidth: zoom === 100 ? '100%' : 'none', maxHeight: zoom === 100 ? 'min(65vh, 650px)' : 'none', margin: '0 auto', cursor: draw ? 'crosshair' : 'pointer' }} onPointerDown={startPointer} onPointerMove={movePointer} onPointerUp={() => { pointerDown.current = false; }} onPointerCancel={() => { pointerDown.current = false; }} /></div> : <div className="if-empty"><span>◉</span><h3>按区域，数清每一种细胞</h3><p>DAPI · AF647 · GFP</p></div>}
            {image && <div className="if-legend"><span>● DAPI 核</span><span>● AF647 阳性</span><span>● GFP 阳性</span><span>● 双阳性</span>{image.displayOnly && <em>RGB 估算</em>}</div>}
          </div>
          {cell && <div className="if-card if-cell"><strong>细胞 #{cell.id}</strong><span>{cell.regionName} · 核面积 {cell.area} px²</span><label className="if-check"><input type="checkbox" disabled={busy} checked={cell.aPositive} onChange={e => editCell({ aPositive: e.target.checked })} />AF647+</label><label className="if-check"><input type="checkbox" disabled={busy} checked={cell.bPositive} onChange={e => editCell({ bPositive: e.target.checked })} />GFP+</label><label className="if-check"><input type="checkbox" disabled={busy} checked={cell.excluded} onChange={e => editCell({ excluded: e.target.checked })} />排除</label></div>}
          <div className="if-card if-summary"><div className="if-section-head"><h2>分区结果</h2>{active?.result && <label className="if-check"><input type="checkbox" disabled={busy} checked={active.reviewed} onChange={e => updateField(active.id, { reviewed: e.target.checked })} />已人工复核</label>}</div>
            <div className="if-table"><table><thead><tr><th>区域</th><th>总核数</th><th>AF647+</th><th>GFP+</th><th>双阳性</th><th>双阳性 / AF647+</th></tr></thead><tbody>{active?.result?.regions.map(r => <tr key={r.id}><td>{r.name}</td><td>{r.total}</td><td>{r.aPositive}</td><td>{r.bPositive}</td><td>{r.doublePositive}</td><td>{n(r.doubleOfAPct)}{r.doubleOfAPct === null ? '' : '%'}</td></tr>)}</tbody></table></div>
            <p className="if-hint">{active?.result ? '点击图中细胞可修正阳性或排除；双阳性指同一核关联区域内两种标记均阳性。' : '完成描边后点“计算此图”，或统一参数计算全部。'}</p>
            {active?.result?.regions.some(r => r.total >= 10 && (r.aPositive / r.total > .95 || r.bPositive / r.total > .95)) && <p className="if-error">有区域接近全阳性，请结合阴性对照核对背景与阈值。</p>}
            {!!active?.result?.warnings.length && <details className="if-qc"><summary>检查提示 · {active.result.warnings.length}</summary>{active.result.warnings.map((w, i) => <p key={i}>{w}</p>)}</details>}
          </div>
          <details className="if-method"><summary>分区与计数方法</summary><p>神经束内为内膜区；包住神经束的薄层是束膜；束间及外围结缔组织为外膜区。荧光图不自动决定解剖分区，请沿实际结构描边并复核。黑色空白不属于外膜。内部区域按列表顺序优先，重叠部分只计一次；外轮廓内其余部分单独统计。未画外轮廓时，只统计已画区域。</p><p>DAPI 阈值连通域作为核对象，不自动拆分粘连核。AF647 与 GFP 在核及核周范围内分别判阳；重叠核周像素只分配给最近的核。按核质心归区。双阳性细胞数与像素级共定位不同；逐细胞表另含双阈值像素重叠比例。阈值应结合阴性对照确定。</p><p>原始独立通道用于定量；RGB/JPG 合成图仅供估算。不同文件须同视野、已配准。文件名以 _DAPI、_AF647、_GFP 或 _ch01 等结尾可自动分组，其他命名可用“组合单通道文件”。VSI 需连同 ETS 在 cellSens 或 Fiji 导出二维 OME-TIFF 后导入。增强显示按各通道采样强度的 1%–99.8% 分位缩放，仅影响预览与 PNG，不改变原始阈值或计数，不能据此比较不同图的荧光强弱。</p><p>所有计算在浏览器本地完成，关闭前导出。ZIP 包含平铺标记图、汇总、逐细胞表、区域坐标、源文件校验值、参数、显示范围与复核状态。</p><p><a href="https://histology.oit.duke.edu/MBS/CellSci/CS-Nerve/CS-Nerve.html" target="_blank" rel="noreferrer">神经组织分区参考</a> · <a href="https://imagej.net/imaging/colocalization-analysis" target="_blank" rel="noreferrer">共定位方法参考</a></p></details>
        </section>
      </div>
    </main>
  </div>;
}
