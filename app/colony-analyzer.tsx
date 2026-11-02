'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { loadImages } from '../lib/image';
import { DEFAULT_COLONY_PARAMETERS, type ColonyCircle, type ColonyParameters, type ColonyPoint, type ColonyResult } from '../lib/colony';
import { colonyCsv, prismTsv, colonySummary, type ColonyExportRow } from '../lib/colony-export';
import { createStoredZip, safeFilePart, type ExportArchiveEntry } from '../lib/export-archive';
import type { RGBAFrame } from '../lib/migration';
import './if-count.css';
import './colony.css';

type Photo = { canvas: HTMLCanvasElement; frame: RGBAFrame; hash: string };
type Well = { id: string; file: File; path: string; group: string; replicate: string; included: boolean; show: boolean; width: number; height: number; hash: string; roi: ColonyCircle; confirmed: boolean; thumb?: string; result?: ColonyResult; points?: ColonyPoint[]; parameters?: ColonyParameters; reviewed: boolean; manual: boolean; error?: string; createdAt?: string };
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const circle = (w: number, h: number): ColonyCircle => ({ cx: w / 2, cy: h / 2, r: Math.min(w, h) * .42 });
const inside = (p: { x: number; y: number }, c: ColonyCircle) => Math.hypot(p.x - c.cx, p.y - c.cy) <= c.r;
function bounded(c: ColonyCircle, w: number, h: number): ColonyCircle {
  const r = Math.max(2, Math.min(c.r, Math.min(w, h) / 2));
  return { r, cx: Math.max(r, Math.min(w - r, c.cx)), cy: Math.max(r, Math.min(h - r, c.cy)) };
}
async function readPhoto(file: File): Promise<Photo> {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d')!;
  let hash: string;
  if (/\.tiff?$/i.test(file.name)) {
    const im = await loadImages([file]);
    if (im.pageCount !== 1 || im.channels.length !== 3 || im.width * im.height > 30_000_000 || im.warnings.some(w => w.includes('Alpha/ExtraSamples'))) throw new Error('请选择不超过 3000 万像素的单平面、不透明 RGB 图。');
    const channels = ['red', 'green', 'blue'].map(id => im.channels.find(c => c.id === id));
    if (channels.some(c => !c)) throw new Error('无法确认 RGB 通道。');
    canvas.width = im.width; canvas.height = im.height;
    const pixels = ctx.createImageData(im.width, im.height);
    for (let i = 0; i < im.width * im.height; i++) { for (let k = 0; k < 3; k++) pixels.data[i * 4 + k] = channels[k]!.data[i] / channels[k]!.maxValue * 255; pixels.data[i * 4 + 3] = 255; }
    ctx.putImageData(pixels, 0, 0); hash = im.hash;
  } else {
    const bitmap = await createImageBitmap(file);
    if (bitmap.width * bitmap.height > 30_000_000) { bitmap.close(); throw new Error('图像超过 3000 万像素，请先导出单孔图。'); }
    canvas.width = bitmap.width; canvas.height = bitmap.height; ctx.drawImage(bitmap, 0, 0); bitmap.close();
    hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
  }
  if (Math.min(canvas.width, canvas.height) < 4) throw new Error('图像尺寸过小。');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) throw new Error('请使用不透明的原始平板照片。');
  return { canvas, frame: { width: canvas.width, height: canvas.height, data }, hash };
}
function cropped(source: HTMLCanvasElement, roi: ColonyCircle, size: number) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
  ctx.save(); ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(source, roi.cx - roi.r, roi.cy - roi.r, roi.r * 2, roi.r * 2, 0, 0, size, size); ctx.restore(); return c;
}
function countPhoto(photo: Photo, roi: ColonyCircle, parameters: ColonyParameters): Promise<ColonyResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../lib/colony.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = e => { worker.terminate(); if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result); };
    worker.onerror = e => { worker.terminate(); reject(new Error(e.message || '统计失败')); };
    worker.postMessage({ frame: photo.frame, roi, parameters });
  });
}
function dataRows(wells: Well[]): ColonyExportRow[] {
  return wells.map(w => ({ file: w.path, group: w.group.trim(), replicate: w.replicate, included: w.included, count: w.points?.length ?? null, autoCount: w.result?.points.length ?? null, reviewed: w.reviewed, manual: w.manual, coveragePct: w.result?.coveragePct ?? null, error: w.error ?? '', hash: w.hash, roi: JSON.stringify(w.roi), parameters: w.parameters ? JSON.stringify(w.parameters) : '', createdAt: w.createdAt ?? '' }));
}
function groupsFor(wells: Well[]) {
  const groups = new Map<string, Well[]>();
  for (const w of wells) if (w.included && w.group.trim()) {
    if (!groups.has(w.group.trim())) groups.set(w.group.trim(), []);
    if (w.show && w.confirmed) groups.get(w.group.trim())!.push(w);
  }
  return [...groups].filter(([, entries]) => entries.length);
}
async function montage(wells: Well[], title: string, size: number, originals: boolean) {
  const groups = groupsFor(wells); if (!groups.length) throw new Error('先确认圈选、填写组别，并勾选要排版的孔。');
  const rows = Math.max(...groups.map(([, entries]) => entries.length)), gap = Math.round(size * .12), top = title ? 110 : 65;
  const canvas = document.createElement('canvas'); canvas.width = groups.length * (size + gap) + gap; canvas.height = top + rows * (size + gap);
  if (canvas.width * canvas.height > 40_000_000 || canvas.width > 16000 || canvas.height > 16000) throw new Error('排版过大，请减少本次展示的孔。');
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#111'; ctx.textAlign = 'center';
  if (title) { ctx.font = 'bold 32px Arial, Microsoft YaHei'; ctx.fillText(title, canvas.width / 2, 38, canvas.width - gap * 2); ctx.strokeStyle = '#333'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(gap, 52); ctx.lineTo(canvas.width - gap, 52); ctx.stroke(); }
  for (let col = 0; col < groups.length; col++) {
    const [group, entries] = groups[col]; const x = gap + col * (size + gap);
    ctx.font = 'bold 26px Arial, Microsoft YaHei'; ctx.fillStyle = '#111'; ctx.fillText(group, x + size / 2, top - 18, size);
    for (let row = 0; row < entries.length; row++) {
      const w = entries[row];
      if (originals) { const photo = await readPhoto(w.file); if (photo.hash !== w.hash) throw new Error('源图校验不一致'); ctx.drawImage(cropped(photo.canvas, w.roi, size), x, top + row * (size + gap)); }
      else { const im = new Image(); im.src = w.thumb!; await im.decode(); ctx.drawImage(im, x, top + row * (size + gap), size, size); }
    }
  }
  return canvas;
}
const png = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('图片生成失败')), 'image/png'));

export default function ColonyAnalyzer() {
  const [wells, setWells] = useState<Well[]>([]), [activeId, setActiveId] = useState('');
  const [photo, setPhoto] = useState<{ id: string; value: Photo } | null>(null);
  const [parameters, setParameters] = useState<ColonyParameters>(DEFAULT_COLONY_PARAMETERS);
  const [title, setTitle] = useState(''), [mode, setMode] = useState<'roi' | 'correct'>('roi');
  const [busy, setBusy] = useState(false), [running, setRunning] = useState(false), [status, setStatus] = useState(''), [error, setError] = useState('');
  const [showMarks, setShowMarks] = useState(true), [layoutError, setLayoutError] = useState('');
  const [zoom, setZoom] = useState(100);
  const [download, setDownload] = useState<{ url: string; name: string } | null>(null);
  const [undo, setUndo] = useState<Record<string, ColonyPoint[][]>>({});
  const input = useRef<HTMLInputElement>(null), folder = useRef<HTMLInputElement>(null), canvas = useRef<HTMLCanvasElement>(null), layout = useRef<HTMLCanvasElement>(null), prism = useRef<HTMLTextAreaElement>(null);
  const stop = useRef(false), sequence = useRef(0), drag = useRef<{ start: { x: number; y: number }; roi: ColonyCircle; resize: boolean } | null>(null);
  const active = wells.find(w => w.id === activeId), loaded = photo?.id === activeId ? photo.value : null;
  const rows = dataRows(wells), tsv = prismTsv(rows), summary = colonySummary(rows);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);
  useEffect(() => {
    if (!canvas.current || !active || !loaded) return;
    const c = canvas.current; c.width = loaded.frame.width; c.height = loaded.frame.height;
    const ctx = c.getContext('2d')!, unit = c.width / (c.getBoundingClientRect().width || 600);
    ctx.drawImage(loaded.canvas, 0, 0); const { cx, cy, r } = active.roi;
    ctx.save(); ctx.fillStyle = '#0006'; ctx.beginPath(); ctx.rect(0, 0, c.width, c.height); ctx.arc(cx, cy, r, 0, Math.PI * 2, true); ctx.fill('evenodd'); ctx.restore();
    ctx.strokeStyle = active.confirmed ? '#14c59c' : '#ffce5b'; ctx.lineWidth = 2 * unit; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    if (mode === 'roi') for (const [x, y] of [[cx + r, cy], [cx - r, cy], [cx, cy + r], [cx, cy - r]]) { ctx.fillStyle = '#fff'; ctx.fillRect(x - 5 * unit, y - 5 * unit, 10 * unit, 10 * unit); }
    if (showMarks) for (const p of active.points ?? []) { ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4 * unit, Math.sqrt(p.area / Math.PI)), 0, Math.PI * 2); ctx.strokeStyle = '#ff684a'; ctx.lineWidth = unit; ctx.stroke(); }
  }, [active, loaded, mode, showMarks, zoom]);
  useEffect(() => {
    let cancelled = false;
    if (!groupsFor(wells).length) { if (layout.current) { layout.current.width = 1; layout.current.height = 1; } return; }
    void montage(wells, title, 320, false).then(c => { if (!cancelled && layout.current) { layout.current.width = c.width; layout.current.height = c.height; layout.current.getContext('2d')!.drawImage(c, 0, 0); setLayoutError(''); } }).catch(e => { if (!cancelled) setLayoutError(msg(e)); });
    return () => { cancelled = true; };
  }, [wells, title]);
  function patch(id: string, change: Partial<Well>) { setDownload(null); setWells(old => old.map(w => w.id === id ? { ...w, ...change } : w)); }
  async function select(w: Well) {
    const token = ++sequence.current; setActiveId(w.id); setPhoto(null); setError('');
    try { const value = await readPhoto(w.file); if (token === sequence.current) setPhoto({ id: w.id, value }); } catch (e) { if (token === sequence.current) setError(msg(e)); }
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length || busy) return; setBusy(true); setError(''); const added: Well[] = []; let failed = 0;
    const files = Array.from(list).filter(f => /\.(jpe?g|png|webp|bmp|tiff?)$/i.test(f.name));
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i], path = file.webkitRelativePath || file.name; setStatus(`读取 ${i + 1}/${files.length}`);
        try {
          const p = await readPhoto(file), { width, height } = p.frame;
          added.push({ id: crypto.randomUUID(), file, path, group: '', replicate: file.name.replace(/\.[^.]+$/, ''), included: true, show: true, width, height, hash: p.hash, roi: circle(width, height), confirmed: false, reviewed: false, manual: false });
        } catch (e) {
          failed++; added.push({ id: crypto.randomUUID(), file, path, group: '', replicate: file.name, included: false, show: false, width: 0, height: 0, hash: '', roi: { cx: 0, cy: 0, r: 0 }, confirmed: false, reviewed: false, manual: false, error: msg(e) });
        }
        await tick();
      }
      setWells(old => [...old, ...added]); if (added.find(w => w.width)) await select(added.find(w => w.width)!);
      setStatus(`已添加 ${added.length} 张，读取失败 ${failed}。请确认每张单孔图的圈选。`);
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  function changeRoi(roi: ColonyCircle) {
    if (!active) return;
    const next = bounded(roi, active.width, active.height);
    if (Math.abs(next.cx - active.roi.cx) + Math.abs(next.cy - active.roi.cy) + Math.abs(next.r - active.roi.r) < 1e-8) return;
    patch(active.id, { roi: next, confirmed: false, result: undefined, points: undefined, parameters: undefined, reviewed: false, manual: false, error: undefined, thumb: undefined, createdAt: undefined });
    setUndo(old => ({ ...old, [active.id]: [] }));
  }
  async function confirmRoi(all = false) {
    if (!active || !loaded || busy) return; setBusy(true); setError('');
    const targets = all ? wells.filter(w => w.included && w.width && !w.reviewed && !w.manual) : [active];
    try {
      for (const w of targets) {
        const roi = all ? bounded({ cx: active.roi.cx / active.width * w.width, cy: active.roi.cy / active.height * w.height, r: active.roi.r / Math.min(active.width, active.height) * Math.min(w.width, w.height) }, w.width, w.height) : active.roi;
        const p = w.id === active.id ? loaded : await readPhoto(w.file), changed = JSON.stringify(roi) !== JSON.stringify(w.roi);
        patch(w.id, { roi, confirmed: true, thumb: cropped(p.canvas, roi, 320).toDataURL('image/png'), ...(changed ? { result: undefined, points: undefined, parameters: undefined, manual: false, reviewed: false, createdAt: undefined } : {}) });
      }
      setStatus(all ? '已应用相同比例圈选；人工修正及已复核图已保留。请逐张检查孔底。' : '圈选已确认。');
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function run(all: boolean) {
    if (busy || !active) return; setBusy(true); setRunning(true); stop.current = false; setError('');
    const targets = all ? wells.filter(w => w.included && !w.reviewed && !w.manual) : [active], frozen = { ...parameters }; let success = 0, failed = 0;
    for (let i = 0; i < targets.length; i++) {
      if (stop.current) break; const w = targets[i]; setStatus(`统计 ${i + 1}/${targets.length} · ${w.path}`);
      try {
        if (!w.confirmed) throw new Error('请先确认单孔圈选。');
        const p = w.id === activeId && loaded ? loaded : await readPhoto(w.file);
        const result = await countPhoto(p, w.roi, frozen);
        patch(w.id, { result, points: result.points, parameters: frozen, manual: false, reviewed: false, error: undefined, createdAt: new Date().toISOString() }); setUndo(old => ({ ...old, [w.id]: [] })); success++;
      } catch (e) { patch(w.id, { error: msg(e) }); failed++; }
      await tick();
    }
    setStatus(`${stop.current ? '已停止' : '统计完成'}：${success} 张成功，${failed} 张失败。批量保留人工修正及已复核结果。`); setBusy(false); setRunning(false);
  }
  function eventPoint(e: PointerEvent<HTMLCanvasElement>) { const r = e.currentTarget.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * e.currentTarget.width, y: (e.clientY - r.top) / r.height * e.currentTarget.height }; }
  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (busy || !active || !loaded || e.button !== 0) return; const p = eventPoint(e), unit = active.width / e.currentTarget.getBoundingClientRect().width;
    if (mode === 'correct') {
      if (!active.points || !inside(p, active.roi) || active.error) return;
      const sorted = active.points.map((v, i) => ({ i, d: Math.hypot(v.x - p.x, v.y - p.y) })).sort((a, b) => a.d - b.d);
      const points = sorted[0]?.d <= 12 * unit ? active.points.filter((_, i) => i !== sorted[0].i) : [...active.points, { ...p, area: 0 }];
      setUndo(old => ({ ...old, [active.id]: [...(old[active.id] ?? []).slice(-19), active.points!] })); patch(active.id, { points, manual: true, reviewed: false }); return;
    }
    const distance = Math.hypot(p.x - active.roi.cx, p.y - active.roi.cy);
    if (distance > active.roi.r + 12 * unit) return;
    drag.current = { start: p, roi: active.roi, resize: Math.abs(distance - active.roi.r) <= 12 * unit }; e.currentTarget.setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent<HTMLCanvasElement>) { if (!drag.current || busy) return; const p = eventPoint(e), d = drag.current; changeRoi(d.resize ? { ...d.roi, r: Math.hypot(p.x - d.roi.cx, p.y - d.roi.cy) } : { ...d.roi, cx: d.roi.cx + p.x - d.start.x, cy: d.roi.cy + p.y - d.start.y }); }
  function end(e: PointerEvent<HTMLCanvasElement>) { if (drag.current) move(e); drag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }
  function offer(name: string, blob: Blob) { const url = URL.createObjectURL(blob); setDownload({ name, url }); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }
  async function exportImages(bundle: boolean) {
    if (busy) return; setBusy(true); setError('');
    try {
      const composed = await png(await montage(wells, title, 600, true));
      if (!bundle) { offer('平板克隆_排版.png', composed); return; }
      const bytes = (s: string) => new TextEncoder().encode(s);
      const entries: ExportArchiveEntry[] = [{ name: '平板克隆_排版.png', data: await composed.arrayBuffer() }, { name: '逐孔统计.csv', data: bytes(colonyCsv(rows)) }, { name: 'Prism.tsv', data: bytes(tsv) }];
      const selected = wells.filter(w => w.included && w.confirmed);
      for (let i = 0; i < selected.length; i++) {
        const w = selected[i]; setStatus(`导出 ${i + 1}/${selected.length}`); const p = await readPhoto(w.file);
        if (p.hash !== w.hash) throw new Error('源图校验不一致');
        const c = cropped(p.canvas, w.roi, Math.ceil(w.roi.r * 2)), ctx = c.getContext('2d')!, scale = c.width / (w.roi.r * 2);
        for (const point of w.points ?? []) { ctx.beginPath(); ctx.arc((point.x - w.roi.cx + w.roi.r) * scale, (point.y - w.roi.cy + w.roi.r) * scale, Math.max(3, Math.sqrt(point.area / Math.PI) * scale), 0, Math.PI * 2); ctx.strokeStyle = '#ff684a'; ctx.lineWidth = 1.5; ctx.stroke(); }
        entries.push({ name: `${String(i + 1).padStart(3, '0')}_${safeFilePart(w.path)}_标记.png`, data: await (await png(c)).arrayBuffer() });
      }
      entries.push({ name: 'metadata.json', data: bytes(JSON.stringify({ schema: 'colony-v1', title, exportedAt: new Date().toISOString(), analysis: 'Native RGB, manually confirmed circular ROI, stain connected components, reviewed correction points', prism: 'One included successful well per value; rows do not imply matching or independent biological replicates', layout: groupsFor(wells).map(([group, entries]) => ({ group, files: entries.map(w => w.path) })), wells: wells.map(({ file, thumb, ...w }) => ({ ...w, sourceName: file.name, hasPreview: !!thumb })) }, null, 2)) });
      offer('平板克隆_全部结果.zip', new Blob([await createStoredZip(entries)], { type: 'application/zip' })); setStatus('图片、逐孔数据和 Prism 表已导出。');
    } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function copyPrism() { try { await navigator.clipboard.writeText(tsv); setStatus('已复制，可直接粘贴到 Prism 的 Column 表。'); } catch { prism.current?.focus(); prism.current?.select(); setStatus('已选中数据，请按 Ctrl+C 复制。'); } }

  return <div className="if-app colony-app">
    <header className="if-header"><a className="if-brand" href="../">✳ <strong>FluoroScope</strong></a><nav aria-label="分析工具"><a href="../intensity/">荧光</a><a href="../edu/">EdU</a><a href="../scratch/">划痕</a><a href="../transwell/">Transwell</a><a href="../cck8/">CCK-8</a><a href="../if-count/">切片计数</a><a href="../colony/" aria-current="page">平板克隆</a></nav></header>
    <main className="if-main"><div className="if-heading"><div><small>COLONY FORMATION</small><h1>平板克隆</h1></div><div className="if-actions"><button disabled={!wells.length || busy} onClick={() => offer('平板克隆_逐孔统计.csv', new Blob([colonyCsv(rows)], { type: 'text/csv;charset=utf-8' }))}>数据 CSV</button><button disabled={!summary.length || busy} onClick={() => void copyPrism()}>复制到 Prism</button><button disabled={!groupsFor(wells).length || busy} onClick={() => void exportImages(true)}>全部导出 ZIP</button></div></div>
    {error && <p className="if-alert" role="alert">{error}</p>}
    <div className="if-layout"><aside className="if-sidebar">
      <section className="if-card"><h2>单孔图片</h2><div className="if-actions"><button disabled={busy} onClick={() => input.current?.click()}>选择图片</button><button disabled={busy} onClick={() => folder.current?.click()}>选择文件夹</button></div>
        <input ref={input} hidden type="file" multiple accept=".jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff" onChange={e => { void importFiles(e.target.files); e.target.value = ''; }} /><input ref={folder} hidden type="file" multiple {...{ webkitdirectory: '' }} onChange={e => { void importFiles(e.target.files); e.target.value = ''; }} />
        <div className="if-files">{wells.map((w, i) => <button key={w.id} disabled={busy || !w.width} aria-pressed={w.id === activeId} onClick={() => void select(w)}><span>{i + 1}. {w.path}</span><small>{!w.included ? '不纳入' : w.error ? '失败' : w.reviewed ? '已复核' : w.points ? `${w.points.length} 个` : w.confirmed ? '待统计' : '待圈选'}</small></button>)}</div>
        <div className="if-actions"><button className="primary" disabled={busy || !active?.confirmed || !loaded} onClick={() => void run(false)}>统计此图</button><button disabled={busy || !wells.length} onClick={() => void run(true)}>统计全部</button>{running && <button onClick={() => { stop.current = true; }}>停止统计</button>}</div><p role="status" className="if-hint">{status || '导入单孔照片 → 圈孔底 → 填组别。'}</p>{download && <a className="if-download" href={download.url} download={download.name}>下载文件 · {download.name}</a>}
      </section>
      <section className="if-card"><h2>圈选与分组</h2><fieldset disabled={busy || !active || !loaded}>
        <label>组别<input aria-label="当前组别" placeholder="由你定义" value={active?.group ?? ''} onChange={e => active && patch(active.id, { group: e.target.value })} maxLength={80} /></label>
        <label>孔号 / 重复<input aria-label="当前孔号" value={active?.replicate ?? ''} onChange={e => active && patch(active.id, { replicate: e.target.value })} /></label>
        <label className="if-check"><input type="checkbox" checked={active?.included ?? false} onChange={e => active && patch(active.id, { included: e.target.checked })} />纳入统计</label>
        <div className="if-actions"><button aria-pressed={mode === 'roi'} onClick={() => setMode('roi')}>调整圆圈</button><button aria-pressed={mode === 'correct'} disabled={!active?.points || !!active?.error} onClick={() => setMode('correct')}>加 / 删克隆</button></div>
        {active && <div className="colony-roi">{(['cx', 'cy', 'r'] as const).map((key, i) => <label key={key}>{['中心 X', '中心 Y', '半径'][i]} %<input aria-label={['圈选中心 X', '圈选中心 Y', '圈选半径'][i]} type="number" min={key === 'r' ? 1 : 0} max={key === 'r' ? 50 : 100} step="0.5" value={Number((active.roi[key] / (key === 'cx' ? active.width : key === 'cy' ? active.height : Math.min(active.width, active.height)) * 100).toFixed(2)) || 0} onChange={e => changeRoi({ ...active.roi, [key]: Number(e.target.value) / 100 * (key === 'cx' ? active.width : key === 'cy' ? active.height : Math.min(active.width, active.height)) })} /></label>)}</div>}
        <div className="if-actions"><button className="primary" onClick={() => void confirmRoi()}>确认圈选</button><button onClick={() => void confirmRoi(true)}>同样圈选应用全部</button></div>
        <p className="if-hint">圈内拖动，边缘缩放。只圈孔底，避开塑料边框；计数为圈内克隆数。</p>
        {active?.points && <><label className="if-check"><input type="checkbox" disabled={!!active.error} checked={active.reviewed} onChange={e => patch(active.id, { reviewed: e.target.checked })} />已人工复核</label><button disabled={!undo[active.id]?.length || !!active.error} onClick={() => { const previous = undo[active.id]; patch(active.id, { points: previous[previous.length - 1], reviewed: false, manual: true }); setUndo(old => ({ ...old, [active.id]: previous.slice(0, -1) })); }}>撤销校正</button></>}
      </fieldset></section>
      <details className="if-card"><summary>识别参数</summary><fieldset disabled={busy}>
        {(['stainThreshold', 'minArea', 'maxArea'] as const).map((key, i) => <label key={key}>{['染色阈值', '最小克隆面积 px²', '最大克隆面积 px²'][i]}<input type="number" min="1" aria-label={['染色阈值', '最小克隆面积', '最大克隆面积'][i]} value={parameters[key]} onChange={e => { setParameters(p => ({ ...p, [key]: Number(e.target.value) })); setStatus('参数将在下次统计时应用，已有结果保留原参数。'); }} /></label>)}
        <label className="if-check"><input type="checkbox" checked={parameters.excludeEdge} onChange={e => setParameters(p => ({ ...p, excludeEdge: e.target.checked }))} />排除触圈边缘对象</label><p className="if-hint">原始像素面积。粘连和深色杂物需人工复核；点击已有标记删除，点击空白补计。</p>
      </fieldset></details>
    </aside><section className="if-results">
      <div className="if-card if-view"><div className="if-viewbar"><strong>{active?.path ?? '单孔预览'}</strong><b>{active?.points ? `${active.points.length} 个克隆` : ''}</b><label className="if-check"><input type="checkbox" checked={showMarks} onChange={e => setShowMarks(e.target.checked)} />显示标记</label><select aria-label="平板预览缩放" value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value="100">适应</option><option value="150">150%</option><option value="250">250%</option><option value="400">400%</option></select></div>
        {loaded ? <div className="colony-canvas"><canvas ref={canvas} style={{ width: zoom === 100 ? 'auto' : `${zoom}%`, maxWidth: zoom === 100 ? '100%' : 'none', maxHeight: zoom === 100 ? 620 : 'none' }} aria-label="平板圈选与克隆标记" onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={() => { drag.current = null; }} /></div> : <div className="if-empty"><span>◉</span><h3>圈选 · 计数 · 排版</h3></div>}
        {active?.error && <p className="if-error">{active.error}{active.points ? '（保留旧结果，暂不进入 Prism）' : ''}</p>}{!!active?.result?.warnings.length && <details className="colony-warnings"><summary>检查提示</summary>{active.result.warnings.map((w, i) => <p key={i}>{w}</p>)}</details>}
      </div>
      <section className="if-card"><div className="if-section-head"><h2>分组与排版</h2><button disabled={busy || !groupsFor(wells).length} onClick={() => void exportImages(false)}>导出排版 PNG</button></div>
        <label className="colony-title">标题<input aria-label="排版标题" value={title} placeholder="例如 HucCT1" maxLength={100} onChange={e => setTitle(e.target.value)} disabled={busy} /></label>
        <div className="if-table"><table><thead><tr><th>原图</th><th>组别</th><th>孔号 / 重复</th><th>纳入</th><th>排版</th><th>克隆数</th></tr></thead><tbody>{wells.map((w, i) => <tr key={w.id}><td title={w.path}>{w.path}</td><td><input aria-label={`组别 ${i + 1}`} value={w.group} disabled={busy} maxLength={80} onChange={e => patch(w.id, { group: e.target.value })} /></td><td><input aria-label={`孔号 ${i + 1}`} value={w.replicate} disabled={busy} onChange={e => patch(w.id, { replicate: e.target.value })} /></td><td><input type="checkbox" aria-label={`纳入 ${i + 1}`} checked={w.included} disabled={busy} onChange={e => patch(w.id, { included: e.target.checked })} /></td><td><input type="checkbox" aria-label={`排版 ${i + 1}`} checked={w.show} disabled={busy} onChange={e => patch(w.id, { show: e.target.checked })} /></td><td>{w.points?.length ?? '—'}</td></tr>)}</tbody></table></div>
        <p className="if-hint">同组自动排成一列；仅展示代表孔时，取消其他孔的“排版”，统计数据仍保留。总览图请取消“纳入”。</p>
        {(!groupsFor(wells).length || layoutError) && <p className="if-hint">{groupsFor(wells).length ? layoutError : '填写组别并确认圈选后自动排版。'}</p>}<div className="colony-layout"><canvas aria-label="平板克隆自动排版" ref={layout} /></div>
      </section>
      <section className="if-card"><div className="if-section-head"><h2>Prism 数据</h2><button disabled={!summary.length || busy} onClick={() => void copyPrism()}>复制数据</button></div><textarea ref={prism} aria-label="Prism 数据表" readOnly value={tsv} rows={Math.min(10, Math.max(3, tsv.split('\n').length))} /><p className="if-hint">每列一组，每个数对应一个孔。未统计、失败、不纳入或未填写组别的图不进入此表；孔不自动视为独立实验。</p>
        {!!summary.length && <div className="if-table"><table><thead><tr><th>组别</th><th>孔数</th><th>均值</th><th>SD</th></tr></thead><tbody>{summary.map(s => <tr key={s.group}><td>{s.group}</td><td>{s.n}</td><td>{s.mean.toFixed(1)}</td><td>{s.sd === null ? '—' : s.sd.toFixed(1)}</td></tr>)}</tbody></table></div>}
      </section>
      <details className="if-method"><summary>方法与导出</summary><p>在原始 RGB 照片的确认圆圈内，按染色强度和面积筛选连通对象，作为克隆数估计。粘连对象不自动拆分；人工加删会保留自动结果。平板照片不能直接验证每个克隆是否达到指定细胞数。相同实验使用统一参数，并逐孔检查标记。</p><p>排版使用原图圆形裁切和等大缩放，不改变孔内颜色。组名按列表首次出现顺序排列，孔按导入顺序排列；图片选择不影响统计纳入。ZIP 含排版图、标记图、逐孔 CSV、Prism TSV 和原图校验值、圈选、参数、自动/人工计数及复核状态。所有处理在浏览器本地完成，关闭前请导出。</p></details>
    </section></div></main>
  </div>;
}
