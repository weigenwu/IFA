'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { renderRoiPseudocolor, type RoiExportChannel } from '../lib/roi-export';
import { saveFile, type PreparedDownload } from '../lib/save-file';
import { safeFilePart } from '../lib/export-archive';
import type { LoadedImage } from '../lib/image';
import {
  analyzeCicPair, validateCicPolygon, upsertCicRecord, summarizeCicExperiments,
  cicRecordsCsv, cicSummaryCsv, cicProjectJson, parseCicProjectJson,
  type CicMeasurement, type CicRois, type CicPolygon,
} from '../lib/cic-intensity';
import './cic-pair.css';

export interface CicDisplayChannel extends RoiExportChannel { label: string }
interface PanelProps {
  image: LoadedImage | null;
  displayChannels: CicDisplayChannel[];
  channelConfirmed: boolean;
  allowDisplayOnly: boolean;
}
type Role = keyof CicRois;
const roles: { id: Role; name: string; color: string }[] = [
  { id: 'inner', name: '内细胞', color: '#46eeac' },
  { id: 'outer', name: '外细胞全轮廓', color: '#ff8492' },
  { id: 'background', name: '背景', color: '#ffd364' },
  { id: 'innerExclusions', name: '内细胞排除区', color: '#83ddff' },
  { id: 'outerExclusions', name: '外细胞排除区', color: '#bc9aff' },
];
function exclusion(role: Role): role is 'innerExclusions' | 'outerExclusions' {
  return role === 'innerExclusions' || role === 'outerExclusions';
}
function blankRois(): CicRois {
  return { inner: [], outer: [], background: [], innerExclusions: [], outerExclusions: [] };
}
interface Draft {
  experimentId: string; fieldId: string; pairId: string; innerLabel: string; outerLabel: string;
  marker: string; channelId: string; rois: CicRois; role: Role; points: CicPolygon; view: string;
  measured: CicMeasurement | null;
}
function blankDraft(fileName: string): Draft {
  return {
    experimentId: '', fieldId: fileName, pairId: '1', innerLabel: 'shHER2', outerLabel: 'WT',
    marker: 'PIEZO1', channelId: '', rois: blankRois(), role: 'inner', points: [], view: 'overlay', measured: null,
  };
}
function contours(rois: CicRois) {
  return roles.flatMap(role => {
    const polygons = exclusion(role.id) ? rois[role.id] : [rois[role.id]];
    return polygons.flatMap((polygon, index) => polygon.length ? [{ ...role, polygon, index }] : []);
  });
}
function fmt(n: number | null) {
  return n === null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
}
const fields = [
  ['experimentId', '独立实验'], ['fieldId', '视野'], ['pairId', 'CIC 编号'],
  ['innerLabel', '内细胞组别'], ['outerLabel', '外细胞组别'],
] as const;

const cacheKey = 'fluoroscope.cic.pairs.v1';

function restoreRecords(): { records: CicMeasurement[]; notice: string } {
  try {
    const stored = typeof window !== 'undefined' && window.localStorage.getItem(cacheKey);
    return { records: stored ? parseCicProjectJson(stored) : [], notice: '' };
  } catch {
    return { records: [], notice: '浏览器未能恢复上次记录，可导入已导出的项目 JSON。' };
  }
}

export default function CicPairPanel({ image, displayChannels, channelConfirmed, allowDisplayOnly }: PanelProps) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [restored] = useState(restoreRecords);
  const [records, setRecords] = useState<CicMeasurement[]>(restored.records);
  const latestRecords = useRef(records);
  const [notice, setNotice] = useState(restored.notice);
  const [zoom, setZoom] = useState(1);
  const [download, setDownload] = useState<PreparedDownload | null>(null);
  const [imageError, setImageError] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  const importer = useRef<HTMLInputElement>(null);
  const hash = image?.hash ?? '';
  const draft = drafts[hash] ?? blankDraft(image?.fileName ?? '');
  const measurementChannels = (image?.channels ?? []).map(raw => ({
    id: raw.id, label: displayChannels.find(item => item.id === raw.id)?.label ?? raw.label,
  }));
  const channel = measurementChannels.find(item => item.id === draft.channelId);
  const actualView = displayChannels.some(item => item.id === draft.view) ? draft.view : 'overlay';
  const available = Boolean(image && channel && channelConfirmed && (!image.displayOnly || allowDisplayOnly));
  const measured = available && draft.measured?.metadata.channelLabel === channel?.label ? draft.measured : null;
  const polygons = contours(draft.rois);
  const active = roles.find(role => role.id === draft.role)!;

  useEffect(() => {
    if (!image || !canvas.current) return;
    const target = canvas.current;
    const frame = requestAnimationFrame(() => {
      try {
        const ctx = target.getContext('2d');
        if (!ctx) throw new Error('浏览器无法显示此图片。');
        target.width = image.width;
        target.height = image.height;
        if (!displayChannels.length) throw new Error('请在左侧勾选至少一个显示通道。');
        const rendered = renderRoiPseudocolor({
          image, channels: displayChannels, view: actualView === 'overlay' ? 'overlay' : `channel:${actualView}`,
        });
        const pixels = ctx.createImageData(rendered.width, rendered.height);
        for (let i = 0, j = 0; i < rendered.rgb.length; i += 3, j += 4) {
          pixels.data[j] = rendered.rgb[i]; pixels.data[j + 1] = rendered.rgb[i + 1];
          pixels.data[j + 2] = rendered.rgb[i + 2]; pixels.data[j + 3] = 255;
        }
        ctx.putImageData(pixels, 0, 0);
        setImageError('');
      } catch (err) { setImageError(err instanceof Error ? err.message : '图片显示失败。'); }
    });
    return () => cancelAnimationFrame(frame);
  }, [image, actualView, displayChannels]);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);

  function update(patch: Partial<Draft>, invalidate = true) {
    if (!image) return;
    setDrafts(prev => ({ ...prev, [hash]: {
      ...(prev[hash] ?? blankDraft(image.fileName)), ...(invalidate ? { measured: null } : {}), ...patch,
    } }));
    setNotice('');
  }
  function addPoint(event: MouseEvent<SVGSVGElement>) {
    if (!image || imageError || event.button !== 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * image.width;
    const y = (event.clientY - bounds.top) / bounds.height * image.height;
    if (x < 0 || y < 0 || x > image.width || y > image.height) return;
    update({ points: [...draft.points, { x, y }] });
  }
  function finishContour() {
    if (!image) return;
    try {
      const poly = validateCicPolygon(draft.points, image.width, image.height, active.name);
      const role = draft.role;
      const rois = { ...draft.rois };
      if (exclusion(role)) rois[role] = [...rois[role], poly];
      else rois[role] = poly;
      update({ rois, points: [], role: role === 'inner' && !rois.outer.length ? 'outer'
        : role === 'outer' && !rois.background.length ? 'background' : role });
      setNotice(`${active.name}轮廓已记录。`);
    } catch (err) { setNotice(err instanceof Error ? err.message : '轮廓无效。'); }
  }
  function removeContour(role: Role, index: number) {
    const rois = { ...draft.rois };
    if (exclusion(role)) rois[role] = rois[role].filter((_, i) => i !== index);
    else rois[role] = [];
    update({ rois, role, points: [] });
  }
  function measure() {
    const raw = image?.channels.find(item => item.id === channel?.id);
    if (!image || !channel || !raw || !available || draft.points.length) return;
    try {
      const result = analyzeCicPair({ channel: raw, width: image.width, height: image.height, rois: draft.rois,
        metadata: { imageHash: hash, fileName: image.fileName, channelId: channel.id, channelLabel: channel.label,
          marker: draft.marker, experimentId: draft.experimentId, fieldId: draft.fieldId, pairId: draft.pairId,
          innerLabel: draft.innerLabel, outerLabel: draft.outerLabel,
          provenance: { sourceFiles: image.sourceFiles, format: image.format, pageCount: image.pageCount,
            displayOnly: image.displayOnly, warnings: image.warnings, bitDepth: raw.bitDepth,
            maxValue: raw.maxValue, pixelSizeUm: image.pixelSizeUm },
        },
      });
      update({ measured: result }, false);
      setNotice('已计算。核对数值后保存本对。');
    } catch (err) { setNotice(err instanceof Error ? err.message : '无法计算此配对。'); }
  }

  function storeRecords(next: CicMeasurement[], message: string) {
    latestRecords.current = next;
    setRecords(next);
    try {
      window.localStorage.setItem(cacheKey, cicProjectJson(next));
      setNotice(message);
    } catch { setNotice(message + ' 浏览器未能写入本地缓存，请导出项目 JSON。'); }
  }
  function nextPair() {
    if (!image || !measured || !records.includes(measured)) return;
    const ids = new Set(records.filter(record => record.metadata.imageHash === hash).map(record => record.metadata.pairId));
    let next = Number(draft.pairId);
    next = Number.isSafeInteger(next) && next >= 0 && next < Number.MAX_SAFE_INTEGER - records.length - 2 ? next + 1 : 1;
    while (ids.has(String(next))) next++;
    update({ pairId: String(next), role: 'inner', points: [], rois: { ...blankRois(), background: draft.rois.background } });
    setNotice('已开始下一对，沿用本视野背景，可重新圈选。');
  }
  function editRecord(record: CicMeasurement) {
    if (!image || hash !== record.metadata.imageHash) {
      setNotice('请先导入对应原图：' + record.metadata.fileName); return;
    }
    if (record.width !== image.width || record.height !== image.height) { setNotice('原图尺寸不匹配。'); return; }
    if (draft.points.length && !window.confirm('放弃当前未闭合的轮廓并打开记录？')) return;
    const m = record.metadata;
    update({ marker: m.marker, channelId: m.channelId, pairId: m.pairId, experimentId: m.experimentId,
      fieldId: m.fieldId, innerLabel: m.innerLabel, outerLabel: m.outerLabel,
      points: [], role: 'inner', rois: record.rois, measured: null });
    setNotice('已载入轮廓，可用原图重新计算。');
  }
  async function exportFile(name: string, mime: string, makeBlob: () => Blob | Promise<Blob>) {
    try {
      const saved = await saveFile(name, mime, makeBlob, setDownload);
      if (saved) setNotice('已准备 ' + name);
    } catch (err) { setNotice(err instanceof Error ? err.message : '导出失败。'); }
  }
  async function importFile(file: File) {
    try {
      const imported = parseCicProjectJson(await file.text());
      if (!imported.length) { setNotice('项目中没有配对记录。'); return; }
      const existing = latestRecords.current;
      const keys = new Set(existing.map(record => record.recordKey));
      const conflicts = imported.filter(record => keys.has(record.recordKey)).length;
      if (conflicts && !window.confirm('有 ' + conflicts + ' 条同图、同通道、同编号记录。使用导入值更新？')) return;
      storeRecords(imported.reduce(upsertCicRecord, existing), '已导入 ' + imported.length + ' 条配对记录。');
    } catch (err) { setNotice(err instanceof Error ? err.message : '无法导入此项目。'); }
  }
  function markedImage(): Promise<Blob> {
    if (!image || !canvas.current) throw new Error('请先导入原图。');
    const output = document.createElement('canvas');
    output.width = image.width; output.height = image.height;
    const ctx = output.getContext('2d');
    if (!ctx) throw new Error('无法创建标注图。');
    ctx.drawImage(canvas.current, 0, 0);
    ctx.lineWidth = Math.max(1, Math.min(image.width, image.height) / 350);
    for (const { polygon, color } of polygons) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      polygon.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.closePath(); ctx.stroke();
    }
    return new Promise((resolve, reject) => output.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法导出标注图。')), 'image/png'));
  }
  function exportTable(summary: boolean) {
    const text = summary ? cicSummaryCsv(summarizeCicExperiments(records)) : cicRecordsCsv(records);
    void exportFile(summary ? 'CIC-experiments.csv' : 'CIC-pairs.csv', 'text/csv', () => new Blob([text], { type: 'text/csv;charset=utf-8' }));
  }
  const selectedPoints = draft.points.map(point => point.x + ',' + point.y).join(' ');
  const blocked = !image ? '' : !channelConfirmed ? '请先在左侧确认通道。'
    : image.displayOnly && !allowDisplayOnly ? '当前是展示图，定量请导入原始单通道。'
    : !channel ? '请选择待测蛋白对应的定量通道。' : '';
  return <section className="cic-editor" aria-label="CIC 内外细胞配对工作区">
    <div className="cic-heading"><h2>CIC 内外细胞配对</h2>
      <p>圈出同一结构的内细胞、外细胞完整边界和邻近背景。外细胞定量会自动扣除内细胞。</p></div>
    {image ? <>
      <div className="cic-metadata">
        <label>定量通道<select value={channel?.id ?? ''} onChange={e => update({ channelId: e.target.value })}>
          <option value="">选择蛋白荧光通道</option>
          {measurementChannels.map(ch => <option value={ch.id} key={ch.id}>{ch.label}</option>)}</select></label>
        <label>蛋白<input value={draft.marker} list="cic-markers" onChange={e => update({ marker: e.target.value })}/></label>
        <datalist id="cic-markers">{['PIEZO1','E-cadherin','CAV1'].map(name => <option key={name} value={name}/>)}</datalist>
        {fields.map(([id, name]) => <label key={id}>{name}<input value={draft[id]} onChange={e => update({ [id]: e.target.value })}/></label>)}
      </div>
      <div className="cic-edit-grid">
        <div className="cic-picture">
          <div className="cic-viewtools">
            <label>显示<select value={actualView} onChange={e => update({ view: e.target.value }, false)}>
              <option value="overlay">Merge</option>{displayChannels.map(ch => <option value={ch.id} key={ch.id}>{ch.label}</option>)}</select></label>
            <label>放大<select value={zoom} onChange={e => setZoom(Number(e.target.value))}>
              {[1,2,4].map(z => <option key={z} value={z}>{z}×</option>)}</select></label>
          </div>
          <div className="cic-scroll"><div className="cic-frame" style={{ width: (100 * zoom) + '%', aspectRatio: image.width + ' / ' + image.height }}>
            <canvas ref={canvas} aria-label="通道图像" />
            <svg role="img" aria-label="CIC 轮廓画布" viewBox={`0 0 ${image.width} ${image.height}`}
              onClick={addPoint}>
              {polygons.map(({id, index, color, polygon}) => <polygon key={id + index} points={polygon.map(p => p.x + ',' + p.y).join(' ')}
                stroke={color} fill={color} fillOpacity=".045" vectorEffect="non-scaling-stroke" strokeWidth="2" />)}
              {draft.points.length > 0 && <><polyline points={selectedPoints} fill="none" stroke={active.color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
                {draft.points.map((p,i) => <circle key={i} cx={p.x} cy={p.y} r={Math.max(.15, Math.min(image.width,image.height)/(170*zoom))}
                  fill={active.color} stroke="#17242b" strokeWidth="1" vectorEffect="non-scaling-stroke"/>)}</>}
            </svg>
          </div></div>
          {imageError && <p role="alert">{imageError}</p>}
        </div>
        <div className="cic-drawtools">
          <label>圈选区域<select value={draft.role} disabled={Boolean(draft.points.length)} onChange={e => update({ role: e.target.value as Role }, false)}>
            {roles.map(role => <option value={role.id} key={role.id}>{role.name}</option>)}</select></label>
          <p>沿边界逐点点击后闭合轮廓。可分别排除细胞核或空腔。</p>
          <div className="cic-actions">
            <button type="button" className="cic-primary" disabled={draft.points.length < 3} onClick={finishContour}>完成轮廓</button>
            <button type="button" disabled={!draft.points.length} onClick={() => update({ points: draft.points.slice(0,-1) })}>撤销一点</button>
            <button type="button" disabled={!draft.points.length} onClick={() => update({ points: [] })}>取消圈选</button>
          </div>
          <span>{active.name} · {draft.points.length} 个待闭合顶点</span>
          {polygons.length > 0 && <ul>{polygons.map(({ id, index, name, color }) => <li key={id + index}>
            <span><i style={{background:color}}/>{name}{exclusion(id) ? ' ' + (index+1) : ''}</span>
            <button aria-label={'删除' + name + (index+1)} disabled={Boolean(draft.points.length)} onClick={() => removeContour(id,index)}>删除</button>
          </li>)}</ul>}
          <button type="button" className="cic-primary" disabled={!available || !!imageError || draft.points.length > 0}
            onClick={measure}>计算本对</button>
          {blocked && <p>{blocked}</p>}
        </div>
      </div>
      {measured && <div className="cic-current">
        <h3>{measured.metadata.marker} · CIC {measured.metadata.pairId}</h3>
        <table><thead><tr><th>区域</th><th>像素数</th><th>原始均值</th><th>校正均值</th><th>CTCF</th></tr></thead>
          <tbody>{(['inner','outer'] as const).map((key,i) => <tr key={key}><th>{i === 0 ? '内细胞' : '外细胞'}</th>
            <td>{measured[key].pixels}</td><td>{fmt(measured[key].mean)}</td><td>{fmt(measured[key].correctedMean)}</td><td>{fmt(measured[key].ctcf)}</td></tr>)}</tbody></table>
        <p>背景均值 {fmt(measured.background.mean)}　内 − 外 {fmt(measured.difference)}　内 / 外 {fmt(measured.ratio)}</p>
        {measured.warnings.length > 0 && <p className="cic-warnings">{measured.warnings.join(' ')}</p>}
        <div className="cic-actions">
          <button type="button" className="cic-primary" onClick={() => storeRecords(upsertCicRecord(records, measured), '本对已保存。')}>保存本对</button>
          <button type="button" disabled={!records.includes(measured)} onClick={nextPair}>下一对</button>
          <button type="button" onClick={() => void exportFile('CIC-' + safeFilePart(draft.marker,'marker') + '-' + safeFilePart(draft.pairId,'pair') + '.png','image/png',markedImage)}>导出标注图</button>
        </div>
      </div>}
    </> : <p className="cic-empty">从左侧导入同一视野的原始通道图，开始圈选。</p>}
    <section className="cic-records" aria-label="已保存的配对">
      <h3>已保存的配对 · {records.length}</h3>
      {records.length > 0 && <div className="cic-table-scroll"><table><thead><tr><th>独立实验 / 视野</th><th>蛋白 / 通道</th><th>CIC</th><th>内校正均值</th><th>外校正均值</th><th>操作</th></tr></thead>
        <tbody>{records.map(record => <tr key={record.recordKey}><td>{record.metadata.experimentId} / {record.metadata.fieldId}</td>
          <td>{record.metadata.marker} / {record.metadata.channelLabel}</td><td>{record.metadata.pairId}</td>
          <td>{fmt(record.inner.correctedMean)}</td><td>{fmt(record.outer.correctedMean)}</td>
          <td><button onClick={() => editRecord(record)}>编辑</button>
          <button onClick={() => { if (window.confirm('删除此配对记录？')) storeRecords(records.filter(r => r.recordKey !== record.recordKey),'已删除该配对。'); }}>删除</button></td></tr>)}</tbody></table>
        <p>独立实验汇总按蛋白、通道和配对组别计算。</p></div>}
      <div className="cic-actions">
        <button type="button" disabled={!records.length} onClick={() => exportTable(false)}>逐对 CSV</button>
        <button type="button" disabled={!records.length} onClick={() => exportTable(true)}>实验汇总 CSV</button>
        <button type="button" disabled={!records.length} onClick={() => void exportFile('CIC-project.json','application/json',() => new Blob([cicProjectJson(records)], {type:'application/json'}))}>导出项目 JSON</button>
        <button type="button" onClick={() => importer.current?.click()}>导入项目 JSON</button>
        <input ref={importer} type="file" accept=".json,application/json" hidden onChange={e => {
          const file = e.target.files?.[0]; e.target.value = ''; if (file) void importFile(file);
        }}/>
      </div>
    </section>
    {notice && <p role="status" className="cic-notice">{notice}</p>}
    {download && <a download={download.name} href={download.url}>下载 {download.name}</a>}
  </section>;
}
