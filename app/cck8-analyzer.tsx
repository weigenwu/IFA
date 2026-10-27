'use client';

import { useEffect, useRef, useState } from 'react';
import { strToU8, zipSync } from 'fflate';
import { analyzeCck8, serializeCck8Csv, type Cck8Analysis, type Cck8Row } from '../lib/cck8';
import { CCK8_DEMO, CCK8_TEMPLATE, parseCck8Input } from '../lib/cck8-import';
import { saveFile, type PreparedDownload } from '../lib/save-file';
import './cck8.css';

type Source = { name: string; text: string; rows: Cck8Row[] };
type Result = { data: Cck8Analysis; rows: Cck8Row[]; blankMode: 'measured' | 'already-corrected'; at: string };
type EditField = 'plate' | 'time' | 'group' | 'sample' | 'role';
const textNumber = (value: number | null, digits = 3) => value === null ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
const unitText = (unit: string) => unit === 'biological samples' ? '样本' : '技术孔';

function summaryCsv(data: Cck8Analysis) {
  return serializeCck8Csv([
    ['批次', '时间', '组别', '总孔数', '排除孔数', '校正OD有效孔数', '校正OD汇总单位', '校正OD_n', '校正OD均值', '校正OD_SD', '活力有效孔数', '活力汇总单位', '活力_n', '相对活力均值_%', '相对活力_SD', 'QC'],
    ...data.summaries.map(r => [r.plate, r.time, r.group, r.totalWells, r.excludedWells, r.correctedWells, unitText(r.correctedUnit), r.correctedN, r.meanCorrected, r.sdCorrected, r.validWells, unitText(r.unit), r.n, r.mean, r.sd, r.qc.join('；')]),
  ]);
}

export default function Cck8Analyzer() {
  const [mode, setMode] = useState<'grouped' | 'plate'>('grouped');
  const [input, setInput] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [rows, setRows] = useState<Cck8Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editField, setEditField] = useState<EditField>('group');
  const [editValue, setEditValue] = useState('');
  const [blankMode, setBlankMode] = useState<'measured' | 'already-corrected'>('measured');
  const [metric, setMetric] = useState<'od' | 'viability'>('od');
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [download, setDownload] = useState<(PreparedDownload & { rows: Cck8Row[]; result: Result | null; blankMode: string; metric: string }) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const chart = useRef<SVGSVGElement>(null);
  const sequence = useRef(0);
  const stale = !!result && (result.rows !== rows || result.blankMode !== blankMode);
  const data = result?.data;
  const currentRows = rows.slice(page * 96, (page + 1) * 96);
  const resultRows = new Map(data?.rows.map(row => [row.id, row]));

  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);

  function appendInputs(inputs: { name: string; text: string }[], importMode = mode) {
    const names = new Set(sources.map(source => source.name));
    const next: Source[] = [];
    const warnings: string[] = [];
    for (const source of inputs) {
      if (names.has(source.name)) throw new Error(`已导入同名数据：${source.name}。请避免重复导入。`);
      names.add(source.name);
      let parsed;
      try { parsed = parseCck8Input(source.text, source.name, importMode); }
      catch (problem) { throw new Error(`${source.name}：${problem instanceof Error ? problem.message : String(problem)}`); }
      const prefix = ++sequence.current;
      next.push({ ...source, rows: parsed.rows.map(row => ({ ...row, id: `${prefix}:${row.id}` })) });
      warnings.push(...parsed.warnings);
    }
    const added = next.flatMap(source => source.rows);
    if (rows.length + added.length > 10000) throw new Error('单次工作区最多 10,000 孔，请分批处理。');
    setSources(old => [...old, ...next]);
    setRows(old => [...old, ...added]);
    setPage(Math.floor(rows.length / 96));
    setMappingOpen(importMode === 'plate');
    setError('');
    setMessage(`已添加 ${added.length} 孔${warnings.length ? `；${warnings.join('；')}` : ''}`);
  }

  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError('');
    try {
      const inputs = [];
      for (const file of Array.from(files)) {
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MB。`);
        if (!/\.(csv|tsv|txt)$/i.test(file.name)) throw new Error('请从 Excel 复制表格，或另存为 CSV / TSV 后导入。');
        inputs.push({ name: file.name, text: await file.text() });
      }
      appendInputs(inputs);
    } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  function editRow(id: string, patch: Partial<Cck8Row>) {
    setRows(old => old.map(row => row.id === id ? { ...row, ...patch } : row));
  }

  function bulkEdit() {
    setRows(old => old.map(row => {
      if (!selected.has(row.id)) return row;
      if (editField === 'role') {
        const role = editValue as Cck8Row['role'];
        return { ...row, role, group: role === 'blank' ? '' : row.group || (role === 'control' ? '对照' : '') };
      }
      return { ...row, [editField]: editValue };
    }));
    setMessage(`已更新 ${selected.size} 孔`);
  }

  async function exportFile(name: string, mime: string, blob: Blob) {
    setError('');
    setDownload({ name, url: URL.createObjectURL(blob), rows, result, blankMode, metric });
    try { await saveFile(name, mime, () => blob, item => setDownload({ ...item, rows, result, blankMode, metric })); }
    catch { setError('未能自动保存，请点击结果区的下载链接。'); }
  }

  function exportAll() {
    if (!result || stale) return;
    const original = new Map(sources.flatMap(source => source.rows.map(row => [row.id, row] as const)));
    const details = serializeCck8Csv([
      ['来源文件', '来源行', '批次', '时间', '组别', '样本', '孔位', '类型', '排除', '原始OD', '原始参考OD', '当前OD', '当前参考OD', 'OD减参考', '空白均值', '校正OD', '对照均值', '相对活力_%', 'QC'],
      ...result.data.rows.map(row => [row.source, row.sourceRow, row.plate, row.time, row.group, row.sample, row.well, row.role, row.excluded ? '是' : '否', original.get(row.id)?.od, original.get(row.id)?.reference, row.od, row.reference, row.signal, row.blankMean, row.corrected, row.controlMean, row.viability, row.qc.join('；')]),
    ]);
    const sampleCsv = serializeCck8Csv([
      ['批次', '时间', '组别', '样本', '技术孔数', '校正OD均值', '相对活力均值_%', '技术孔活力_SD'],
      ...result.data.samples.map(row => [row.plate, row.time, row.group, row.sample, row.wellCount, row.meanCorrected, row.mean, row.sd]),
    ]);
    const files: Record<string, Uint8Array> = {
      'CCK8_汇总.csv': strToU8(summaryCsv(result.data)),
      'CCK8_逐孔明细.csv': strToU8(details),
      'CCK8_活力样本均值.csv': strToU8(sampleCsv),
      'CCK8_原始输入与设置.json': strToU8(JSON.stringify({ version: 'cck8-v1', analyzedAt: result.at, blankMode: result.blankMode, sources, mapping: result.rows, qc: result.data.qc }, null, 2)),
    };
    if (chart.current) files['CCK8_当前图.svg'] = strToU8(new XMLSerializer().serializeToString(chart.current));
    const bytes = zipSync(files);
    void exportFile('CCK8_全部结果.zip', 'application/zip', new Blob([new Uint8Array(bytes).buffer], { type: 'application/zip' }));
  }

  const plots = (data?.summaries ?? []).map(row => ({ ...row, value: metric === 'od' ? row.meanCorrected : row.mean, deviation: metric === 'od' ? row.sdCorrected : row.sd, count: metric === 'od' ? row.correctedN : row.n, units: metric === 'od' ? row.correctedUnit : row.unit })).filter(row => row.value !== null);
  const low = Math.min(0, ...plots.map(row => row.value! - (row.deviation ?? 0)));
  const high = Math.max(metric === 'od' ? .1 : 100, ...plots.map(row => row.value! + (row.deviation ?? 0))) * 1.1;
  const x = (value: number) => 250 + (value - low) / (high - low) * 420;
  const chartHeight = 65 + plots.length * 45;

  return <div className="cck8-app">
    <header className="cck8-header"><a className="cck8-brand" href="../">✳ <span>FluoroScope</span></a><nav aria-label="分析工具"><a href="../intensity/">荧光</a><a href="../edu/">EdU</a><a href="../scratch/">划痕</a><a href="../transwell/">Transwell</a><a href="../cck8/" aria-current="page">CCK-8</a></nav><small>数据仅在本地处理</small></header>
    <main className="cck8-main">
      <div className="cck8-heading"><div><span className="cck8-eyebrow">CELL VIABILITY</span><h1>CCK-8 数据分析</h1></div><div className="cck8-actions"><button disabled={!data || stale || busy} onClick={() => { if (data) void exportFile('CCK8_汇总.csv', 'text/csv;charset=utf-8', new Blob([summaryCsv(data)], { type: 'text/csv;charset=utf-8' })); }}>导出 CSV</button><button disabled={!data || stale || busy} onClick={exportAll}>完整数据 ZIP</button></div></div>
      {error && <div role="alert" className="cck8-alert">{error}</div>}
      <div className="cck8-workspace">
        <section className="cck8-card cck8-import"><h2>导入数据</h2><div className="cck8-tabs"><button aria-pressed={mode === 'grouped'} onClick={() => setMode('grouped')}>分组表格</button><button aria-pressed={mode === 'plate'} onClick={() => setMode('plate')}>96 孔板</button></div>
          <textarea aria-label="粘贴 CCK-8 数据" placeholder={mode === 'grouped' ? '从 Excel 复制并粘贴\n\n组别\t时间\t重复1\t重复2\t重复3\n对照\t24h\t…\t…\t…' : '粘贴 8 行 × 12 列 OD 值\n可包含 A–H 行号和 1–12 列号'} value={input} onChange={event => setInput(event.target.value)} />
          <div className="cck8-actions"><button disabled={!input.trim() || busy} onClick={() => { try { appendInputs([{ name: `粘贴数据${sequence.current + 1}`, text: input }]); setInput(''); } catch (problem) { setError(problem instanceof Error ? problem.message : String(problem)); } }}>添加表格</button><button disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? '导入中…' : '导入 CSV'}</button></div><input ref={fileInput} hidden type="file" multiple accept=".csv,.tsv,.txt" onChange={event => void importFiles(event.target.files)} />
          <div className="cck8-minor"><button onClick={() => void exportFile('CCK8_填写模板.tsv', 'text/tab-separated-values', new Blob(['\uFEFF' + CCK8_TEMPLATE], { type: 'text/tab-separated-values' }))}>下载模板</button><button disabled={rows.length > 0 || busy} onClick={() => { try { appendInputs([{ name: '模拟示例.tsv', text: CCK8_DEMO }], 'grouped'); } catch (problem) { setError(String(problem)); } }}>试用示例</button></div>
          <label className="cck8-label">空白处理<select value={blankMode} onChange={event => setBlankMode(event.target.value as typeof blankMode)}><option value="measured">按空白孔扣除</option><option value="already-corrected">输入值已扣空白</option></select></label>
          <button className="primary cck8-run" disabled={!rows.length || busy} onClick={() => { setResult({ data: analyzeCck8(rows, { blankMode }), rows, blankMode, at: new Date().toISOString() }); setError(''); setMessage('全部计算完成'); }}>计算全部 · {rows.length} 孔</button>
          <p className="cck8-status" role="status">{message || '支持多文件，按批次和时间分别计算。'}</p>
          {!!rows.length && <button className="cck8-text-button" disabled={busy} onClick={() => { setRows([]); setSources([]); setSelected(new Set()); setResult(null); setPage(0); setDownload(null); setMessage('已清空工作区'); setError(''); }}>清空工作区</button>}
        </section>

        <section className="cck8-card cck8-results"><div className="cck8-section-head"><h2>结果预览</h2><select aria-label="结果指标" value={metric} onChange={event => setMetric(event.target.value as typeof metric)}><option value="od">校正 OD</option><option value="viability">相对活力 %</option></select></div>
          {stale && <p className="cck8-alert">数据或设置已修改，请重新计算。</p>}
          {!data ? <div className="cck8-empty"><span>▥</span><h3>从一张数据表开始</h3><p>导入 → 核对分组 → 计算全部</p></div> : plots.length ? <><div className="cck8-chart"><svg ref={chart} xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 800 ${chartHeight}`} role="img" aria-label={`${metric === 'od' ? '校正 OD' : '相对活力'}均值与 SD`} style={{ background: '#fff', fontFamily: 'Arial, Microsoft YaHei, sans-serif', fontSize: 11 }}>
            <text x="250" y="18" fill="#49665e">{metric === 'od' ? '校正 OD · 均值 ± SD' : '相对活力 (%) · 均值 ± SD'}</text>
            {Array.from({ length: 5 }, (_, index) => { const value = low + (high - low) * index / 4; return <g key={index}><line x1={x(value)} x2={x(value)} y1="30" y2={chartHeight - 26} stroke="#e5eeea" /><text x={x(value)} y={chartHeight - 8} textAnchor="middle" fill="#6a8278">{textNumber(value, 2)}</text></g>; })}
            <line x1={x(0)} x2={x(0)} y1="30" y2={chartHeight - 26} stroke="#80978c" />
            {plots.map((row, index) => { const y = 48 + index * 45; return <g key={JSON.stringify([row.plate, row.time, row.group])}><title>{`${row.plate} / ${row.time} / ${row.group}：${row.value} ± ${row.deviation ?? '无 SD'}，n=${row.count} ${unitText(row.units)}`}</title><text x="235" y={y - 2} textAnchor="end" fill="#28483e">{`${row.group} ${row.time}`.slice(0, 26)}</text><text x="235" y={y + 13} textAnchor="end" fill="#81958b" fontSize="9">{row.plate.slice(0, 22)} · n={row.count} {unitText(row.units)}</text><rect x={Math.min(x(0), x(row.value!))} y={y - 10} width={Math.abs(x(row.value!) - x(0))} height="21" rx="2" fill={index % 2 ? '#77ac99' : '#288973'} />{row.deviation !== null && <g stroke="#263f36" strokeWidth="1.4"><line x1={x(row.value! - row.deviation)} x2={x(row.value! + row.deviation)} y1={y} y2={y} /><line x1={x(row.value! - row.deviation)} x2={x(row.value! - row.deviation)} y1={y - 5} y2={y + 5} /><line x1={x(row.value! + row.deviation)} x2={x(row.value! + row.deviation)} y1={y - 5} y2={y + 5} /></g>}<text x="700" y={y + 4} fill="#28483e">{textNumber(row.value, metric === 'od' ? 3 : 1)}</text></g>; })}
          </svg></div><p className="cck8-hint">误差线为 SD；样本编号相同时先合并复孔。数据不足时不画误差线。</p></> : <div className="cck8-empty"><h3>此指标暂无有效结果</h3><p>请检查下方数据与提示。</p></div>}
          {data && <div className="cck8-table-scroll"><table className="cck8-summary"><thead><tr><th>批次 / 时间</th><th>组别</th><th>校正 OD</th><th>相对活力 %</th><th>n（OD / 活力）</th></tr></thead><tbody>{data.summaries.map(row => <tr key={JSON.stringify([row.plate, row.time, row.group])}><td>{row.plate}<small>{row.time}</small></td><td>{row.group}</td><td>{textNumber(row.meanCorrected)}<small>SD {textNumber(row.sdCorrected)}</small></td><td>{textNumber(row.mean, 1)}<small>SD {textNumber(row.sd, 1)}</small></td><td>{row.correctedN} {unitText(row.correctedUnit)}<small>{row.n} {unitText(row.unit)}</small></td></tr>)}</tbody></table></div>}
          {download && download.rows === rows && download.result === result && download.blankMode === blankMode && download.metric === metric && <a className="cck8-download" href={download.url} download={download.name}>下载：{download.name}</a>}
        </section>
      </div>

      {!!rows.length && <details className="cck8-card cck8-mapping" open={mappingOpen} onToggle={event => setMappingOpen(event.currentTarget.open)}><summary>数据与分组 <span>{rows.length} 孔 · {sources.length} 份数据</span></summary><p className="cck8-hint">空白不含细胞；公共空白的组别留空。样本列只填写独立样本编号，技术复孔使用同一编号。</p>
        <div className="cck8-bulk"><span>已选 {selected.size} 孔</span><select aria-label="批量修改字段" value={editField} onChange={event => { const field = event.target.value as EditField; setEditField(field); setEditValue(field === 'role' ? 'sample' : ''); }}><option value="group">组别</option><option value="role">孔类型</option><option value="time">时间</option><option value="plate">批次</option><option value="sample">样本编号</option></select>{editField === 'role' ? <select aria-label="批量孔类型" value={editValue} onChange={event => setEditValue(event.target.value)}><option value="sample">实验孔</option><option value="control">对照孔</option><option value="blank">公共空白孔</option></select> : <input aria-label="批量填写值" value={editValue} onChange={event => setEditValue(event.target.value)} placeholder="填写值" />}<button disabled={!selected.size} onClick={bulkEdit}>应用到选中孔</button><button disabled={!selected.size} onClick={() => setRows(old => old.map(row => selected.has(row.id) ? { ...row, excluded: true } : row))}>排除选中孔</button><button disabled={!selected.size} onClick={() => setRows(old => old.map(row => selected.has(row.id) ? { ...row, excluded: false } : row))}>恢复选中孔</button></div>
        <div className="cck8-table-scroll cck8-data"><table><thead><tr><th><input type="checkbox" aria-label="全选当前页" checked={currentRows.length > 0 && currentRows.every(row => selected.has(row.id))} onChange={event => setSelected(old => { const next = new Set(old); for (const row of currentRows) { if (event.target.checked) next.add(row.id); else next.delete(row.id); } return next; })} /></th><th>孔位</th><th>批次</th><th>时间</th><th>组别</th><th>样本</th><th>类型</th><th>OD450</th><th>参考 OD</th><th>校正 OD</th><th>活力 %</th><th>排除</th></tr></thead><tbody>{currentRows.map(row => <tr key={row.id} className={row.excluded ? 'excluded' : ''} title={`${row.source} 第 ${row.sourceRow} 行${!stale && resultRows.get(row.id)?.qc.length ? '\n' + resultRows.get(row.id)!.qc.join('；') : ''}`}><td><input type="checkbox" aria-label={`选择 ${row.well || row.sourceRow} ${row.id}`} checked={selected.has(row.id)} onChange={event => setSelected(old => { const next = new Set(old); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; })} /></td><td>{row.well || row.sourceRow}</td>{(['plate', 'time', 'group', 'sample'] as const).map(field => <td key={field}><input aria-label={`${row.id} ${field}`} value={row[field]} onChange={event => editRow(row.id, { [field]: event.target.value })} /></td>)}<td><select aria-label={`${row.id} 类型`} value={row.role} onChange={event => editRow(row.id, { role: event.target.value as Cck8Row['role'] })}><option value="sample">实验</option><option value="control">对照</option><option value="blank">空白</option></select></td>{(['od', 'reference'] as const).map(field => <td key={field}><input inputMode="decimal" aria-label={`${row.id} ${field}`} value={row[field]} onChange={event => editRow(row.id, { [field]: event.target.value })} /></td>)}<td>{stale ? '—' : textNumber(resultRows.get(row.id)?.corrected ?? null)}</td><td>{stale ? '—' : textNumber(resultRows.get(row.id)?.viability ?? null, 1)}</td><td><input type="checkbox" aria-label={`${row.id} 排除`} checked={row.excluded} onChange={event => editRow(row.id, { excluded: event.target.checked })} /></td></tr>)}</tbody></table></div>
        <div className="cck8-pagination"><button disabled={page === 0} onClick={() => setPage(old => old - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(rows.length / 96))}</span><button disabled={(page + 1) * 96 >= rows.length} onClick={() => setPage(old => old + 1)}>下一页</button><button onClick={() => setSelected(new Set())}>取消选择</button></div>
      </details>}
      {!!data?.qc.length && <details className="cck8-card cck8-qc"><summary>计算提示 · {data.qc.length}</summary><ul>{data.qc.map((issue, index) => <li key={index}>{issue}</li>)}</ul></details>}
      <details className="cck8-method"><summary>计算方法</summary><p>校正 OD = (OD450 − 参考 OD) − 同批次、同时间的空白均值。没有参考波长时只用 OD450；若该批次有参考值，每个参与孔都须填写。分组空白优先于公共空白。</p><p>相对活力 (%) = 校正 OD ÷ 对照校正 OD 均值 × 100。同批次、同时间只设置一个对照组。填写了全部样本编号时，先平均各样本的技术复孔，再对样本等权汇总；未填编号时只报告技术孔均值与 SD。独立性由实验设计确定，不自动进行显著性检验。</p><p>负值、超过 100% 的结果保留；缺失与无效值不按零处理。CCK-8 反映代谢活性相关信号，须在线性测量范围内解释。模板和示例数字仅用于演示。完整 ZIP 保留原始输入、修改后分组、逐孔计算、汇总与当前图。关闭页面前请导出。</p></details>
    </main>
  </div>;
}
