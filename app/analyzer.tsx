'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  calculateColocalization,
  intensityStats,
  lineProfile,
  percentileInRoi,
  scatterSample,
  type ColocResult,
  type IntensityStats,
  type Line,
  type LineProfile,
  type Rect,
} from '../lib/analysis';
import { loadImage, type LoadedImage } from '../lib/image';

type Tool = 'roi' | 'background' | 'line';
type View = 'overlay' | 'a' | 'b' | 'mask';
type ThresholdMethod = 'costes' | 'otsu' | 'manual' | 'none';
type BackgroundMethod = 'none' | 'roi' | 'percentile';

interface AnalysisState {
  signature: string;
  coloc: ColocResult;
  intensityA: IntensityStats;
  intensityB: IntensityStats;
  profile: LineProfile | null;
  createdAt: string;
}

const COLORS = { ink: '#10222a', cyan: '#18c4c7', magenta: '#f1538a', grid: '#35535b' };
const thresholdLabels: Record<ThresholdMethod, string> = { costes: 'Costes 自动', otsu: 'Otsu 自动', manual: '手动阈值', none: '零阈值' };
const backgroundLabels: Record<BackgroundMethod, string> = { none: '未校正', roi: '背景 ROI 均值', percentile: '分析 ROI 第 5 百分位' };

const format = (value: number, digits = 3) => {
  if (!Number.isFinite(value)) return 'NA';
  const absolute = Math.abs(value);
  if (absolute >= 10000 || (absolute > 0 && absolute < 0.001)) return value.toExponential(3);
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
};

const csvCell = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;

function saveText(name: string, text: string, type = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  URL.revokeObjectURL(url);
}

function normalizedRect(rect: Rect | null) {
  if (!rect) return null;
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

export default function Analyzer() {
  const [image, setImage] = useState<LoadedImage | null>(null);
  const [channelAId, setChannelAId] = useState('green');
  const [channelBId, setChannelBId] = useState('red');
  const [roi, setRoi] = useState<Rect | null>(null);
  const [backgroundRoi, setBackgroundRoi] = useState<Rect | null>(null);
  const [scanLine, setScanLine] = useState<Line | null>(null);
  const [tool, setTool] = useState<Tool>('roi');
  const [view, setView] = useState<View>('overlay');
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Rect | Line | null>(null);
  const [thresholdMethod, setThresholdMethod] = useState<ThresholdMethod>('costes');
  const [manualA, setManualA] = useState(15);
  const [manualB, setManualB] = useState(15);
  const [backgroundMethod, setBackgroundMethod] = useState<BackgroundMethod>('none');
  const [lineWidth, setLineWidth] = useState(5);
  const [sigma, setSigma] = useState(0);
  const [pixelSize, setPixelSize] = useState(1);
  const [analysisState, setAnalysis] = useState<AnalysisState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draggingFile, setDraggingFile] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const scatterCanvas = useRef<HTMLCanvasElement>(null);
  const profileCanvas = useRef<HTMLCanvasElement>(null);

  const analysisSignature = useMemo(() => JSON.stringify({ channelAId, channelBId, roi, backgroundRoi, thresholdMethod, manualA, manualB, backgroundMethod, lineWidth, sigma, pixelSize }), [channelAId, channelBId, roi, backgroundRoi, thresholdMethod, manualA, manualB, backgroundMethod, lineWidth, sigma, pixelSize]);
  const analysis = analysisState?.signature === analysisSignature ? analysisState : null;

  const channelA = image?.channels.find(channel => channel.id === channelAId) ?? image?.channels[0];
  const channelB = image?.channels.find(channel => channel.id === channelBId) ?? image?.channels[1] ?? image?.channels[0];

  const previewSize = useMemo(() => {
    if (!image) return { width: 900, height: 540 };
    const scale = Math.min(1, 1500 / Math.max(image.width, image.height));
    return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
  }, [image]);

  const background = useMemo(() => {
    if (!image || !channelA || !channelB) return { a: 0, b: 0, sdA: 0, sdB: 0 };
    if (backgroundMethod === 'roi' && backgroundRoi) {
      const statsA = intensityStats(channelA, image.width, image.height, backgroundRoi);
      const statsB = intensityStats(channelB, image.width, image.height, backgroundRoi);
      return { a: statsA.mean, b: statsB.mean, sdA: statsA.sd, sdB: statsB.sd };
    }
    if (backgroundMethod === 'percentile') return {
      a: percentileInRoi(channelA, image.width, image.height, roi, 0.05),
      b: percentileInRoi(channelB, image.width, image.height, roi, 0.05),
      sdA: 0,
      sdB: 0,
    };
    return { a: 0, b: 0, sdA: 0, sdB: 0 };
  }, [image, channelA, channelB, backgroundMethod, backgroundRoi, roi]);

  const load = useCallback(async (file?: File) => {
    if (!file) return;
    setLoading(true); setError(''); setAnalysis(null);
    try {
      const loaded = await loadImage(file);
      setImage(loaded);
      const green = loaded.channels.find(channel => channel.id === 'green') ?? loaded.channels[0];
      const red = loaded.channels.find(channel => channel.id === 'red') ?? loaded.channels[1] ?? loaded.channels[0];
      setChannelAId(green.id); setChannelBId(red.id);
      setRoi(null); setBackgroundRoi(null); setScanLine(null); setView('overlay');
    } catch (problem) {
      setImage(null);
      setError(problem instanceof Error ? problem.message : '无法读取该图像。');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const canvas = imageCanvas.current;
    if (!canvas || !image || !channelA || !channelB) return;
    canvas.width = previewSize.width; canvas.height = previewSize.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const pixels = context.createImageData(canvas.width, canvas.height);
    const lowA = percentileInRoi(channelA, image.width, image.height, null, 0.01);
    const highA = percentileInRoi(channelA, image.width, image.height, null, 0.995);
    const lowB = percentileInRoi(channelB, image.width, image.height, null, 0.01);
    const highB = percentileInRoi(channelB, image.width, image.height, null, 0.995);
    const rangeA = Math.max(1e-12, highA - lowA), rangeB = Math.max(1e-12, highB - lowB);
    for (let y = 0; y < canvas.height; y++) {
      const sourceY = Math.min(image.height - 1, Math.floor(y / canvas.height * image.height));
      for (let x = 0; x < canvas.width; x++) {
        const sourceX = Math.min(image.width - 1, Math.floor(x / canvas.width * image.width));
        const source = sourceY * image.width + sourceX;
        const target = (y * canvas.width + x) * 4;
        const a = Math.min(1, Math.max(0, (Number(channelA.data[source]) - lowA) / rangeA));
        const b = Math.min(1, Math.max(0, (Number(channelB.data[source]) - lowB) / rangeB));
        let red = b, green = a, blue = Math.max(a, b);
        if (view === 'a') { red = 0; green = a; blue = a; }
        if (view === 'b') { red = b; green = 0; blue = b; }
        if (view === 'mask') {
          const positive = analysis && Number(channelA.data[source]) - background.a > analysis.coloc.thresholdA && Number(channelB.data[source]) - background.b > analysis.coloc.thresholdB;
          if (positive) { red = green = blue = 1; } else { red *= .18; green *= .18; blue *= .18; }
        }
        pixels.data[target] = red * 255; pixels.data[target + 1] = green * 255; pixels.data[target + 2] = blue * 255; pixels.data[target + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
  }, [image, channelA, channelB, previewSize, view, analysis, background]);

  useEffect(() => {
    const canvas = overlayCanvas.current;
    if (!canvas || !image) return;
    canvas.width = previewSize.width; canvas.height = previewSize.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const sx = canvas.width / image.width, sy = canvas.height / image.height;
    const drawRect = (rect: Rect | null, color: string, label: string) => {
      const value = normalizedRect(rect); if (!value) return;
      context.strokeStyle = color; context.fillStyle = `${color}22`; context.lineWidth = 2;
      context.setLineDash([7, 5]); context.strokeRect(value.x * sx, value.y * sy, value.width * sx, value.height * sy);
      context.fillRect(value.x * sx, value.y * sy, value.width * sx, value.height * sy);
      context.setLineDash([]); context.font = '700 11px Arial'; context.fillStyle = color; context.fillText(label, value.x * sx + 7, value.y * sy + 16);
    };
    const drawLine = (line: Line | null) => {
      if (!line) return;
      context.strokeStyle = '#ffe487'; context.lineWidth = Math.max(2, lineWidth * (sx + sy) / 2); context.globalAlpha = .9;
      context.beginPath(); context.moveTo(line.x1 * sx, line.y1 * sy); context.lineTo(line.x2 * sx, line.y2 * sy); context.stroke(); context.globalAlpha = 1;
      context.fillStyle = '#ffe487'; context.beginPath(); context.arc(line.x1 * sx, line.y1 * sy, 4, 0, Math.PI * 2); context.arc(line.x2 * sx, line.y2 * sy, 4, 0, Math.PI * 2); context.fill();
    };
    drawRect(roi, COLORS.cyan, 'ROI'); drawRect(backgroundRoi, COLORS.magenta, 'BG'); drawLine(scanLine);
    if (draft) {
      if ('width' in draft) drawRect(draft, tool === 'background' ? COLORS.magenta : '#ffffff', tool === 'background' ? 'BG' : 'ROI');
      else drawLine(draft);
    }
  }, [image, previewSize, roi, backgroundRoi, scanLine, draft, tool, lineWidth]);

  useEffect(() => {
    const canvas = scatterCanvas.current;
    if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const width = canvas.width = 640, height = canvas.height = 350;
    context.fillStyle = '#13272f'; context.fillRect(0, 0, width, height);
    context.strokeStyle = COLORS.grid; context.lineWidth = 1;
    for (let i = 1; i < 5; i++) { context.beginPath(); context.moveTo(i * width / 5, 0); context.lineTo(i * width / 5, height); context.moveTo(0, i * height / 5); context.lineTo(width, i * height / 5); context.stroke(); }
    if (!analysis || !image || !channelA || !channelB) return;
    const points = scatterSample(channelA, channelB, image.width, image.height, roi, background.a, background.b);
    const maxA = Math.max(1, channelA.maxValue - background.a), maxB = Math.max(1, channelB.maxValue - background.b);
    context.fillStyle = 'rgba(78,234,231,.12)';
    for (let i = 0; i < points.a.length; i++) {
      const x = Math.min(width - 1, Math.max(0, points.a[i] / maxA * width));
      const y = height - Math.min(height - 1, Math.max(0, points.b[i] / maxB * height));
      context.fillRect(x, y, 2, 2);
    }
    const tx = analysis.coloc.thresholdA / maxA * width;
    const ty = height - analysis.coloc.thresholdB / maxB * height;
    context.strokeStyle = '#ffdb75'; context.lineWidth = 2; context.setLineDash([7, 5]);
    context.beginPath(); context.moveTo(tx, 0); context.lineTo(tx, height); context.moveTo(0, ty); context.lineTo(width, ty); context.stroke(); context.setLineDash([]);
    if (Number.isFinite(analysis.coloc.regressionSlope)) {
      context.strokeStyle = COLORS.magenta; context.lineWidth = 1.5;
      const y0 = height - analysis.coloc.regressionIntercept / maxB * height;
      const y1 = height - (analysis.coloc.regressionSlope * maxA + analysis.coloc.regressionIntercept) / maxB * height;
      context.beginPath(); context.moveTo(0, y0); context.lineTo(width, y1); context.stroke();
    }
  }, [analysis, image, channelA, channelB, roi, background]);

  useEffect(() => {
    const canvas = profileCanvas.current;
    if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const width = canvas.width = 900, height = canvas.height = 300;
    context.fillStyle = '#fbfdfc'; context.fillRect(0, 0, width, height);
    context.strokeStyle = '#dbe5e5'; context.lineWidth = 1;
    for (let i = 1; i < 6; i++) { context.beginPath(); context.moveTo(0, i * height / 6); context.lineTo(width, i * height / 6); context.stroke(); }
    const profile = analysis?.profile; if (!profile?.distance.length) return;
    const valuesA = sigma > 0 ? profile.smoothA : profile.correctedA;
    const valuesB = sigma > 0 ? profile.smoothB : profile.correctedB;
    const min = Math.min(0, ...valuesA, ...valuesB), max = Math.max(1, ...valuesA, ...valuesB), range = max - min;
    const draw = (values: number[], color: string) => {
      context.strokeStyle = color; context.lineWidth = 3; context.beginPath();
      values.forEach((value, index) => { const x = index / Math.max(1, values.length - 1) * width; const y = height - (value - min) / range * height; if (!index) context.moveTo(x, y); else context.lineTo(x, y); });
      context.stroke();
    };
    draw(valuesA, COLORS.cyan); draw(valuesB, COLORS.magenta);
  }, [analysis, sigma]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return image ? {
      x: Math.min(image.width, Math.max(0, (event.clientX - box.left) / box.width * image.width)),
      y: Math.min(image.height, Math.max(0, (event.clientY - box.top) / box.height * image.height)),
    } : { x: 0, y: 0 };
  };

  const makeDraft = (start: { x: number; y: number }, end: { x: number; y: number }) => tool === 'line'
    ? { x1: start.x, y1: start.y, x2: end.x, y2: end.y } as Line
    : { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y } as Rect;

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!image) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event); setDragStart(point); setDraft(makeDraft(point, point));
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStart) return; setDraft(makeDraft(dragStart, pointFromEvent(event)));
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStart) return;
    const final = makeDraft(dragStart, pointFromEvent(event));
    if ('width' in final && Math.abs(final.width) > 2 && Math.abs(final.height) > 2) {
      if (tool === 'background') setBackgroundRoi(normalizedRect(final)); else setRoi(normalizedRect(final));
    } else if (!('width' in final) && Math.hypot(final.x2 - final.x1, final.y2 - final.y1) > 2) setScanLine(final);
    setDragStart(null); setDraft(null);
  };

  const runAnalysis = () => {
    if (!image || !channelA || !channelB) return;
    if (backgroundMethod === 'roi' && !backgroundRoi) { setError('请先选择“背景 ROI”工具并在图像上框选背景区域。'); return; }
    setBusy(true); setError('');
    requestAnimationFrame(() => {
      try {
        const coloc = calculateColocalization(channelA, channelB, image.width, image.height, roi, thresholdMethod, manualA, manualB, background.a, background.b);
        const intensityA = intensityStats(channelA, image.width, image.height, roi, background.a, background.sdA);
        const intensityB = intensityStats(channelB, image.width, image.height, roi, background.b, background.sdB);
        const profile = scanLine ? lineProfile(channelA, channelB, image.width, image.height, scanLine, lineWidth, sigma, background.a, background.b) : null;
        setAnalysis({ signature: analysisSignature, coloc, intensityA, intensityB, profile, createdAt: new Date().toISOString() });
      } catch (problem) { setError(problem instanceof Error ? problem.message : '分析失败。'); }
      finally { setBusy(false); }
    });
  };

  const exportRows = () => {
    if (!analysis || !image || !channelA || !channelB) return;
    const rows: (string | number)[][] = [
      ['section', 'channel', 'metric', 'value', 'unit'],
      ['metadata', '', 'file_name', image.fileName, ''], ['metadata', '', 'sha256', image.hash, ''],
      ['metadata', '', 'width', image.width, 'px'], ['metadata', '', 'height', image.height, 'px'],
      ['metadata', '', 'pixel_size', pixelSize, 'µm/px'], ['metadata', '', 'threshold_method', thresholdLabels[thresholdMethod], ''],
      ['metadata', '', 'background_method', backgroundLabels[backgroundMethod], ''],
    ];
    const colocEntries: [string, number, string][] = [
      ['pearson_r', analysis.coloc.pearson, ''], ['pearson_below', analysis.coloc.pearsonBelow, ''], ['pearson_above', analysis.coloc.pearsonAbove, ''],
      ['M1_A_to_B', analysis.coloc.m1, ''], ['M2_B_to_A', analysis.coloc.m2, ''], ['tM1_A_to_B', analysis.coloc.tm1, ''], ['tM2_B_to_A', analysis.coloc.tm2, ''],
      ['manders_overlap', analysis.coloc.overlap, ''], ['Li_ICQ', analysis.coloc.icq, ''], ['coloc_pixels', analysis.coloc.colocPixels, 'px'], ['coloc_area', analysis.coloc.colocAreaPct, '%'],
      ['threshold_A', analysis.coloc.thresholdA, 'A.U.'], ['threshold_B', analysis.coloc.thresholdB, 'A.U.'],
    ];
    colocEntries.forEach(([metric, value, unit]) => rows.push(['colocalization', '', metric, value, unit]));
    const addIntensity = (label: string, stats: IntensityStats) => Object.entries(stats).forEach(([metric, value]) => rows.push(['intensity', label, metric, value, metric.includes('Pct') ? '%' : metric === 'pixels' ? 'px' : 'A.U.']));
    addIntensity(channelA.label, analysis.intensityA); addIntensity(channelB.label, analysis.intensityB);
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_metrics.csv`, rows.map(row => row.map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8');
  };

  const exportProfile = () => {
    if (!analysis?.profile || !image) return;
    const profile = analysis.profile;
    const header = ['distance_px', 'distance_um', 'raw_A', 'raw_B', 'background_corrected_A', 'background_corrected_B', 'smoothed_A', 'smoothed_B', 'sd_A', 'sd_B'];
    const rows = profile.distance.map((distance, index) => [distance, distance * pixelSize, profile.rawA[index], profile.rawB[index], profile.correctedA[index], profile.correctedB[index], profile.smoothA[index], profile.smoothB[index], profile.sdA[index], profile.sdB[index]]);
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_line_profile.csv`, [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8');
  };

  const exportJson = () => {
    if (!analysis || !image || !channelA || !channelB) return;
    const payload = {
      schema: 'FluoroScope analysis 1.0', createdAt: analysis.createdAt,
      source: { fileName: image.fileName, sha256: image.hash, format: image.format, width: image.width, height: image.height, pageCount: image.pageCount },
      channels: { a: { id: channelA.id, label: channelA.label, bitDepth: channelA.bitDepth }, b: { id: channelB.id, label: channelB.label, bitDepth: channelB.bitDepth } },
      parameters: { roi, backgroundRoi, backgroundMethod, background, thresholdMethod, manualThresholdPercent: { a: manualA, b: manualB }, scanLine, lineWidthPx: lineWidth, gaussianSigmaPx: sigma, pixelSizeUm: pixelSize, comparison: 'strict >', costesSignificanceTest: false },
      results: analysis,
      warnings: [...image.warnings, ...analysis.coloc.warnings, '共定位不等于分子相互作用。'],
    };
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_analysis.json`, JSON.stringify(payload, null, 2), 'application/json');
  };

  const roiText = roi ? `${Math.round(roi.width)} × ${Math.round(roi.height)} px` : '全图';
  const lineLength = scanLine ? Math.hypot(scanLine.x2 - scanLine.x1, scanLine.y2 - scanLine.y1) : 0;
  const allWarnings = [...(image?.warnings ?? []), ...(analysis?.coloc.warnings ?? [])];

  return (
    <main className="app-shell" id="top">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="FluoroScope 首页"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>FluoroScope</span></a>
        <nav aria-label="页内导航"><a href="#workspace">工作台</a><a href="#results">结果</a><a href="#methods">方法说明</a></nav>
        <span className="privacy-badge"><i /> 本地分析 · 图像不上传</span>
      </header>

      <section className="intro">
        <div><p className="eyebrow">COLOCALIZATION + INTENSITY</p><h1>把荧光图像，变成可复核的结果。</h1><p className="lede">二维、两通道免疫荧光分析。保留 TIFF 原始位深，量化共定位、ROI 荧光强度与线扫描，并把参数一并导出。</p></div>
        <div className="workflow" aria-label="分析流程"><span className={image ? '' : 'active'}>01 上传</span><i /><span className={image && !analysis ? 'active' : ''}>02 选区</span><i /><span className={analysis ? 'active' : ''}>03 分析</span><i /><span>04 导出</span></div>
      </section>

      <section className="workspace" id="workspace" aria-label="荧光分析工作台">
        <aside className="control-panel">
          <div className="panel-heading"><span>输入与参数</span><small>SETUP</small></div>
          <div className={`dropzone ${draggingFile ? 'dragging' : ''}`} role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click(); }} onDragOver={event => { event.preventDefault(); setDraggingFile(true); }} onDragLeave={() => setDraggingFile(false)} onDrop={event => { event.preventDefault(); setDraggingFile(false); void load(event.dataTransfer.files[0]); }}>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/tiff,.tif,.tiff" onChange={event => void load(event.target.files?.[0])} />
            <span className="upload-glyph" aria-hidden="true">↑</span><strong>{loading ? '正在读取…' : image ? '更换图像' : '拖入或选择图像'}</strong><small>原始 TIFF、PNG 或 JPEG<br />支持 8/16/32-bit TIFF</small><em>{image ? image.fileName : '选择文件'}</em>
          </div>
          {image && <div className="file-facts"><span>{image.format}</span><span>{image.width} × {image.height}</span><span>{image.channels.map(channel => `${channel.bitDepth}-bit`).join(' / ')}</span></div>}

          <div className="field-group"><p>通道映射</p><label><span className="dot cyan" />通道 A<select value={channelAId} onChange={event => setChannelAId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.label}</option>)}</select></label><label><span className="dot magenta" />通道 B<select value={channelBId} onChange={event => setChannelBId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.label}</option>)}</select></label></div>

          <div className="field-group"><p>阈值</p><label className="wide-field">方法<select value={thresholdMethod} onChange={event => setThresholdMethod(event.target.value as ThresholdMethod)}><option value="costes">Costes 自动</option><option value="otsu">Otsu 自动</option><option value="manual">手动阈值</option><option value="none">零阈值</option></select></label>{thresholdMethod === 'manual' && <div className="range-pair"><label>A {manualA}%<input type="range" min="0" max="100" value={manualA} onChange={event => setManualA(Number(event.target.value))} /></label><label>B {manualB}%<input type="range" min="0" max="100" value={manualB} onChange={event => setManualB(Number(event.target.value))} /></label></div>}</div>

          <div className="field-group"><p>背景与标尺</p><label className="wide-field">背景<select value={backgroundMethod} onChange={event => setBackgroundMethod(event.target.value as BackgroundMethod)}><option value="none">不校正</option><option value="roi">背景 ROI 均值</option><option value="percentile">ROI 第 5 百分位</option></select></label><label className="number-field">像素尺寸<input type="number" min="0.000001" step="0.01" value={pixelSize} onChange={event => setPixelSize(Math.max(0.000001, Number(event.target.value) || 1))} /><span>µm/px</span></label></div>
        </aside>

        <div className="image-stage">
          <div className="stage-toolbar"><div className="view-switch"><button className={view === 'overlay' ? 'selected' : ''} onClick={() => setView('overlay')}>叠加</button><button className={view === 'a' ? 'selected' : ''} onClick={() => setView('a')}>通道 A</button><button className={view === 'b' ? 'selected' : ''} onClick={() => setView('b')}>通道 B</button><button className={view === 'mask' ? 'selected' : ''} onClick={() => setView('mask')} disabled={!analysis}>共定位 Mask</button></div><span>显示自动拉伸 · 计算用原始值</span></div>
          <div className={`canvas-area tool-${tool}`}>
            {!image && <div className="empty-canvas"><div className="scan-grid" /><span className="crosshair" aria-hidden="true" /><p>等待图像</p><small>图像只在当前浏览器内解码和计算</small></div>}
            {image && <div className="canvas-stack" style={{ aspectRatio: `${image.width}/${image.height}` }}><canvas ref={imageCanvas} /><canvas ref={overlayCanvas} aria-label={`在图像上绘制${tool === 'roi' ? '分析 ROI' : tool === 'background' ? '背景 ROI' : '线扫描'}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={() => { setDragStart(null); setDraft(null); }} /></div>}
          </div>
          <div className="stage-tools" aria-label="绘图工具"><button className={tool === 'roi' ? 'selected' : ''} onClick={() => setTool('roi')}><b>□</b>分析 ROI</button><button className={tool === 'background' ? 'selected' : ''} onClick={() => setTool('background')}><b>▧</b>背景 ROI</button><button className={tool === 'line' ? 'selected' : ''} onClick={() => setTool('line')}><b>╱</b>线扫描</button><span className="tool-spacer" /><button onClick={() => setRoi(null)}>全图</button><button onClick={() => { setRoi(null); setBackgroundRoi(null); setScanLine(null); }}>清除标注</button></div>
          <div className="stage-foot"><span>ROI：{roiText}</span><span>线长：{scanLine ? `${format(lineLength, 1)} px / ${format(lineLength * pixelSize, 2)} µm` : '—'}</span><span>BG A/B：{format(background.a, 2)} / {format(background.b, 2)}</span></div>
        </div>

        <aside className="results-panel">
          <div className="panel-heading"><span>即时结果</span><small>{analysis ? 'READY' : 'PREVIEW'}</small></div>
          <div className="metric hero-metric"><small>Pearson&apos;s r</small><strong>{analysis ? format(analysis.coloc.pearson) : '—'}</strong><span>强度线性相关</span></div>
          <div className="metric-row"><div className="metric"><small>tM1 · A→B</small><strong>{analysis ? format(analysis.coloc.tm1) : '—'}</strong><span>A 信号与 B 共现</span></div><div className="metric"><small>tM2 · B→A</small><strong>{analysis ? format(analysis.coloc.tm2) : '—'}</strong><span>B 信号与 A 共现</span></div></div>
          <div className="quick-stats"><span><small>双阳面积</small><b>{analysis ? `${format(analysis.coloc.colocAreaPct, 2)}%` : '—'}</b></span><span><small>阈值 A</small><b>{analysis ? format(analysis.coloc.thresholdA, 2) : '—'}</b></span><span><small>阈值 B</small><b>{analysis ? format(analysis.coloc.thresholdB, 2) : '—'}</b></span></div>
          {error && <p className="error-message" role="alert">{error}</p>}
          <button className="analyze-button" onClick={runAnalysis} disabled={!image || busy || loading}>{busy ? '正在计算…' : image ? '运行分析' : '载入图像后分析'} <span>→</span></button>
          <p className="run-note">{thresholdLabels[thresholdMethod]} · {backgroundLabels[backgroundMethod]}<br />所有积和以浮点数计算，避免 16-bit 溢出。</p>
        </aside>
      </section>

      <section className="detail-section" id="results">
        <div className="section-title"><div><p className="eyebrow">RESULTS</p><h2>结果与质控</h2></div>{analysis && <div className="export-actions"><button onClick={exportRows}>导出指标 CSV</button><button onClick={exportJson}>导出完整 JSON</button>{analysis.profile && <button onClick={exportProfile}>导出线扫 CSV</button>}</div>}</div>
        <div className="result-grid">
          <article className="result-card scatter-card"><header><div><span>共定位散点图</span><small>黄线：阈值 · 洋红线：Costes 回归</small></div><b>{analysis ? thresholdLabels[thresholdMethod] : '等待分析'}</b></header><canvas ref={scatterCanvas} aria-label="通道 A 与 B 的强度散点图" /><div className="legend"><span><i className="dot cyan" />X：通道 A</span><span><i className="dot magenta" />Y：通道 B</span></div></article>
          <article className="result-card coefficients"><header><div><span>共定位指标</span><small>相关与共现分开报告</small></div></header><dl><div><dt>Pearson（无阈值）</dt><dd>{analysis ? format(analysis.coloc.pearson) : '—'}</dd></div><div><dt>Pearson（阈值下）</dt><dd>{analysis ? format(analysis.coloc.pearsonBelow) : '—'}</dd></div><div><dt>Pearson（阈值上）</dt><dd>{analysis ? format(analysis.coloc.pearsonAbove) : '—'}</dd></div><div><dt>Manders M1 / M2</dt><dd>{analysis ? `${format(analysis.coloc.m1)} / ${format(analysis.coloc.m2)}` : '—'}</dd></div><div><dt>Manders tM1 / tM2</dt><dd>{analysis ? `${format(analysis.coloc.tm1)} / ${format(analysis.coloc.tm2)}` : '—'}</dd></div><div><dt>Manders overlap</dt><dd>{analysis ? format(analysis.coloc.overlap) : '—'}</dd></div><div><dt>Li ICQ</dt><dd>{analysis ? format(analysis.coloc.icq) : '—'}</dd></div><div><dt>双阳性像素</dt><dd>{analysis ? `${analysis.coloc.colocPixels.toLocaleString()} (${format(analysis.coloc.colocAreaPct, 2)}%)` : '—'}</dd></div></dl></article>
        </div>

        <article className="result-card intensity-card"><header><div><span>ROI 荧光强度</span><small>RawIntDen、背景校正与 CTCF 均基于原始像素值</small></div><b>{roi ? `ROI ${roiText}` : '全图'}</b></header><div className="table-wrap"><table><thead><tr><th>通道</th><th>像素数</th><th>Mean</th><th>Median</th><th>SD</th><th>Min–Max</th><th>RawIntDen</th><th>Background</th><th>Corrected Mean</th><th>CTCF</th><th>饱和</th></tr></thead><tbody>{[channelA, channelB].map((channel, index) => { const stats = index ? analysis?.intensityB : analysis?.intensityA; return <tr key={`${channel?.id}-${index}`}><td><i className={`dot ${index ? 'magenta' : 'cyan'}`} />{channel?.label ?? `通道 ${index ? 'B' : 'A'}`}</td><td>{stats ? stats.pixels.toLocaleString() : '—'}</td><td>{stats ? format(stats.mean, 2) : '—'}</td><td>{stats ? format(stats.median, 2) : '—'}</td><td>{stats ? format(stats.sd, 2) : '—'}</td><td>{stats ? `${format(stats.min, 1)}–${format(stats.max, 1)}` : '—'}</td><td>{stats ? format(stats.sum, 1) : '—'}</td><td>{stats ? format(stats.backgroundMean, 2) : '—'}</td><td>{stats ? format(stats.correctedMean, 2) : '—'}</td><td>{stats ? format(stats.ctcf, 1) : '—'}</td><td>{stats ? `${format(stats.saturationPct, 2)}%` : '—'}</td></tr>; })}</tbody></table></div></article>

        <article className="result-card profile-card"><header><div><span>荧光线扫描</span><small>沿线每 1 px 双线性采样；线宽内取 mean ± sample SD</small></div><div className="profile-controls"><label>线宽<input type="number" min="1" max="101" value={lineWidth} onChange={event => setLineWidth(Math.max(1, Math.min(101, Number(event.target.value) || 1)))} />px</label><label>Gaussian σ<input type="number" min="0" max="20" step="0.5" value={sigma} onChange={event => setSigma(Math.max(0, Math.min(20, Number(event.target.value) || 0)))} />px</label></div></header>{!scanLine && <p className="profile-empty">选择“线扫描”工具，在图像上拖出一条线；然后重新运行分析。</p>}<canvas ref={profileCanvas} aria-label="通道 A 与 B 的线扫描曲线" /><div className="legend"><span><i className="dot cyan" />通道 A</span><span><i className="dot magenta" />通道 B</span><span>横轴：{pixelSize === 1 ? 'pixel' : `µm（${pixelSize} µm/px）`}</span><span>{sigma > 0 ? `显示 Gaussian σ=${sigma}px；CSV 保留原始曲线` : '未平滑'}</span></div></article>

        <div className="qa-grid">
          <article className="qa-card"><span>输入质控</span>{image ? <ul><li>{image.fileName}</li><li>SHA-256：{image.hash.slice(0, 12)}…</li><li>{image.width} × {image.height} px · {image.format}</li><li>通道位深：{image.channels.map(channel => `${channel.label} ${channel.bitDepth}-bit`).join('；')}</li></ul> : <p>载入图像后显示来源与位深。</p>}</article>
          <article className="qa-card warning"><span>结果警示</span><ul>{allWarnings.length ? allWarnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>) : <li>运行分析后显示自动质控提示。</li>}<li>共定位表示光学分辨率下的共现/相关，不能证明分子相互作用。</li><li>跨样本强度比较需保持曝光、增益、激光功率与位深一致。</li></ul></article>
        </div>
      </section>

      <section className="methods" id="methods"><div><p className="eyebrow">METHODS & SCOPE</p><h2>明确边界，结果才可复核。</h2></div><div className="method-list"><article><b>01</b><span><strong>共定位</strong><p>Pearson 报告强度相关；Manders 报告信号共现。Costes 自动阈值采用正交回归与阈值下 Pearson 二分搜索，不包含随机化显著性检验。</p></span></article><article><b>02</b><span><strong>强度</strong><p>Mean、sample SD、RawIntDen 与 ImageJ 常用定义一致；CTCF = RawIntDen − 像素数 × 背景均值，负值保留。</p></span></article><article><b>03</b><span><strong>线扫描</strong><p>每 1 px 双线性采样，指定线宽内求 mean ± SD。平滑只生成派生曲线，不覆盖原始强度。</p></span></article><article><b>04</b><span><strong>首版范围</strong><p>仅分析单张二维、两通道图像；不做对象分割、配准、Z-stack、时间序列或统计学重复推断。</p></span></article></div><p className="source-note">方法依据：Fiji Coloc 2、ImageJ Analyze/Plot Profile 文档与 Costes、Manders 定义。参考工具 FluoQuant 与本机 WLab 仅用于功能梳理，未复制其未授权源码。</p></section>

      <footer><span>FluoroScope · browser-local fluorescence analysis</span><a href="https://github.com/weigenwu/IFA" target="_blank" rel="noreferrer">GitHub ↗</a></footer>
    </main>
  );
}
