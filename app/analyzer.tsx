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
import { loadImages, type LoadedImage } from '../lib/image';
import { encodePseudocolorTiff, renderRoiPseudocolor, renderedRoiToBlob } from '../lib/roi-export';

type Tool = 'roi' | 'background' | 'line';
type View = 'overlay' | 'a' | 'b' | 'mask' | `channel:${string}`;
type ThresholdMethod = 'costes' | 'otsu' | 'manual' | 'none';
type BackgroundMethod = 'none' | 'roi' | 'percentile';
type AnalysisMode = 'colocalization' | 'intensity';
type Pseudocolor = 'green' | 'red' | 'blue' | 'cyan' | 'magenta' | 'yellow' | 'orange' | 'violet' | 'gray';

interface AnalysisState {
  signature: string;
  coloc: ColocResult | null;
  intensities: Array<{ id: string; stats: IntensityStats }>;
  profile: LineProfile | null;
  createdAt: string;
}

interface IntensityChannelSetting {
  id: string;
  enabled: boolean;
  label: string;
  color: Pseudocolor;
}

const COLORS = { ink: '#10222a', cyan: '#18c4c7', magenta: '#f1538a', grid: '#35535b' };
const PSEUDOCOLORS: Record<Pseudocolor, { label: string; css: string; rgb: [number, number, number] }> = {
  green: { label: '绿色', css: '#00ff00', rgb: [0, 1, 0] },
  red: { label: '红色', css: '#ff0000', rgb: [1, 0, 0] },
  blue: { label: '蓝色', css: '#0000ff', rgb: [0, 0, 1] },
  cyan: { label: '青色', css: '#00ffff', rgb: [0, 1, 1] },
  magenta: { label: '洋红', css: '#ff00ff', rgb: [1, 0, 1] },
  yellow: { label: '黄色', css: '#ffff00', rgb: [1, 1, 0] },
  orange: { label: '橙色', css: '#ff9338', rgb: [1, 0.52, 0.12] },
  violet: { label: '紫色', css: '#9b6dff', rgb: [0.61, 0.43, 1] },
  gray: { label: '白色 / 灰度', css: '#ffffff', rgb: [1, 1, 1] },
};
const thresholdLabels: Record<ThresholdMethod, string> = { costes: 'Costes 自动', otsu: 'Otsu 自动', manual: '手动阈值', none: '零阈值' };
const backgroundLabels: Record<BackgroundMethod, string> = { none: '未校正', roi: '背景 ROI 均值', percentile: '分析 ROI 第 5 百分位' };
const FALLBACK_COLORS: Pseudocolor[] = ['blue', 'green', 'red', 'magenta', 'cyan', 'yellow', 'orange', 'violet', 'gray'];
const MAX_PREVIEW_HEIGHT = 800;
const DISPLAY_BACKGROUND_SD_MULTIPLIER = 2;

function isTransmittedLight(id: string, label: string) {
  const value = `${id} ${label}`.toLowerCase();
  return /(^|[\s_./-])(td\d*|transmitted|transmission|bright[\s_-]*field|bf|dic|phase)(?=$|[\s_./-])|透射|明场/.test(value);
}

function suggestedColor(id: string, label: string, index: number): Pseudocolor {
  const value = `${id} ${label}`.toLowerCase();
  if (isTransmittedLight(id, label)) return 'gray';
  if (/dapi|hoechst|405|核/.test(value)) return 'blue';
  if (/488|fitc|gfp|alexa[^0-9]*488/.test(value)) return 'green';
  if (/647|640|633|cy5|alexa[^0-9]*647/.test(value)) return 'magenta';
  if (/555|561|568|594|tritc|cy3|alexa[^0-9]*(555|568|594)/.test(value)) return 'red';
  if (/(^|[\s_./-])(red|r)(?=$|[\s_./-])|红色/.test(value)) return 'red';
  if (/(^|[\s_./-])(green|g)(?=$|[\s_./-])|绿色/.test(value)) return 'green';
  if (/(^|[\s_./-])(blue|b)(?=$|[\s_./-])|蓝色/.test(value)) return 'blue';
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function initialIntensitySettings(image: LoadedImage): IntensityChannelSetting[] {
  let enabledCount = 0;
  return image.channels.map((channel, index) => {
    const enabled = !isTransmittedLight(channel.id, channel.label) && enabledCount < 8;
    if (enabled) enabledCount++;
    return { id: channel.id, enabled, label: channel.label, color: suggestedColor(channel.id, channel.label, index) };
  });
}

function suggestedScaleBarUm(width: number, pixelSizeUm: number) {
  if (!(pixelSizeUm > 0)) return 20;
  const target = width * pixelSizeUm * 0.22;
  const choices = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
  return choices.filter(value => value <= target).at(-1) ?? choices[0];
}

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
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

function saveBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
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

export default function Analyzer({ mode }: { mode: AnalysisMode }) {
  const isColoc = mode === 'colocalization';
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
  const [pixelSize, setPixelSize] = useState(0);
  const [analysisState, setAnalysis] = useState<AnalysisState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [draggingFile, setDraggingFile] = useState(false);
  const [allowDisplayOnly, setAllowDisplayOnly] = useState(false);
  const [colorA, setColorA] = useState<Pseudocolor>('green');
  const [colorB, setColorB] = useState<Pseudocolor>('red');
  const [intensitySettings, setIntensitySettings] = useState<IntensityChannelSetting[]>([]);
  const [displayBlackPoint, setDisplayBlackPoint] = useState(0);
  const [suppressDisplayBackground, setSuppressDisplayBackground] = useState(false);
  const [showScaleBar, setShowScaleBar] = useState(true);
  const [scaleBarUm, setScaleBarUm] = useState(20);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const scatterCanvas = useRef<HTMLCanvasElement>(null);
  const profileCanvas = useRef<HTMLCanvasElement>(null);

  const enabledIntensityIds = useMemo(() => intensitySettings.filter(setting => setting.enabled).map(setting => setting.id), [intensitySettings]);
  const analysisSignature = useMemo(() => JSON.stringify({ mode, channelAId, channelBId, intensityChannels: enabledIntensityIds, roi, backgroundRoi: backgroundMethod === 'roi' ? backgroundRoi : null, scanLine, thresholdMethod, manualA, manualB, backgroundMethod, lineWidth, sigma, pixelSize, allowDisplayOnly }), [mode, channelAId, channelBId, enabledIntensityIds, roi, backgroundRoi, scanLine, thresholdMethod, manualA, manualB, backgroundMethod, lineWidth, sigma, pixelSize, allowDisplayOnly]);
  const analysis = analysisState?.signature === analysisSignature ? analysisState : null;

  const channelA = image?.channels.find(channel => channel.id === channelAId) ?? image?.channels[0];
  const channelB = image?.channels.find(channel => channel.id === channelBId) ?? image?.channels[1] ?? image?.channels[0];
  const intensityChannels = useMemo(() => intensitySettings.flatMap(setting => {
    if (!setting.enabled) return [];
    const channel = image?.channels.find(candidate => candidate.id === setting.id);
    return channel ? [{ setting, channel }] : [];
  }), [image, intensitySettings]);
  const displayColorA = isColoc ? colorA : intensitySettings.find(setting => setting.id === channelA?.id)?.color ?? colorA;
  const displayColorB = isColoc ? colorB : intensitySettings.find(setting => setting.id === channelB?.id)?.color ?? colorB;

  const previewSize = useMemo(() => {
    if (!image) return { width: 900, height: 540 };
    const scale = Math.min(1, 1500 / Math.max(image.width, image.height));
    return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
  }, [image]);

  const backgroundByChannel = useMemo(() => {
    const result = new Map<string, { mean: number; sd: number }>();
    if (!image) return result;
    image.channels.forEach(channel => {
      if (backgroundMethod === 'roi' && backgroundRoi) {
        const stats = intensityStats(channel, image.width, image.height, backgroundRoi);
        result.set(channel.id, { mean: stats.mean, sd: stats.sd });
      } else if (backgroundMethod === 'percentile') {
        result.set(channel.id, { mean: percentileInRoi(channel, image.width, image.height, roi, 0.05), sd: 0 });
      } else result.set(channel.id, { mean: 0, sd: 0 });
    });
    return result;
  }, [image, backgroundMethod, backgroundRoi, roi]);
  const displayBackgroundByChannel = useMemo(() => {
    const result = new Map<string, { mean: number; sd: number; floor: number }>();
    if (!image || !backgroundRoi) return result;
    image.channels.forEach(channel => {
      const stats = intensityStats(channel, image.width, image.height, backgroundRoi);
      const floor = stats.mean + DISPLAY_BACKGROUND_SD_MULTIPLIER * stats.sd;
      if (Number.isFinite(floor)) result.set(channel.id, { mean: stats.mean, sd: stats.sd, floor });
    });
    return result;
  }, [image, backgroundRoi]);
  const background = useMemo(() => ({
    a: backgroundByChannel.get(channelA?.id ?? '')?.mean ?? 0,
    b: backgroundByChannel.get(channelB?.id ?? '')?.mean ?? 0,
    sdA: backgroundByChannel.get(channelA?.id ?? '')?.sd ?? 0,
    sdB: backgroundByChannel.get(channelB?.id ?? '')?.sd ?? 0,
  }), [backgroundByChannel, channelA?.id, channelB?.id]);

  const load = useCallback(async (files?: FileList | File[]) => {
    const selected = Array.from(files ?? []);
    if (!selected.length) return;
    setLoading(true); setError(''); setAnalysis(null);
    try {
      const loaded = await loadImages(selected);
      setImage(loaded);
      const settings = initialIntensitySettings(loaded);
      setIntensitySettings(settings);
      const fluorescence = settings.filter(setting => setting.enabled);
      const green = loaded.channels.find(channel => channel.id === 'green') ?? loaded.channels.find(channel => channel.id === fluorescence[0]?.id) ?? loaded.channels[0];
      const red = loaded.channels.find(channel => channel.id === 'red') ?? loaded.channels.find(channel => channel.id === fluorescence[1]?.id) ?? loaded.channels[1] ?? loaded.channels[0];
      setChannelAId(green.id); setChannelBId(red.id);
      setRoi(null); setBackgroundRoi(null); setScanLine(null); setView('overlay'); setTool('roi');
      const loadedPixelSize = loaded.pixelSizeUm ?? 0;
      setPixelSize(loadedPixelSize); setScaleBarUm(suggestedScaleBarUm(loaded.width, loadedPixelSize));
      setDisplayBlackPoint(0); setSuppressDisplayBackground(false); setShowScaleBar(true); setAllowDisplayOnly(false);
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
    const displayChannels = isColoc
      ? [{ channel: channelA, color: colorA, key: 'a' }, { channel: channelB, color: colorB, key: 'b' }]
      : intensityChannels.map(({ channel, setting }) => ({ channel, color: setting.color, key: `channel:${channel.id}` }));
    const stretches = displayChannels.map(item => {
      const baseLow = percentileInRoi(item.channel, image.width, image.height, null, 0);
      const high = percentileInRoi(item.channel, image.width, image.height, null, 1);
      const backgroundFloor = suppressDisplayBackground ? displayBackgroundByChannel.get(item.channel.id)?.floor : undefined;
      const displayLow = Number.isFinite(backgroundFloor) ? Math.min(high, Math.max(baseLow, Number(backgroundFloor))) : baseLow;
      const low = displayLow + Math.max(0, high - displayLow) * displayBlackPoint / 100;
      return { ...item, low, range: Math.max(1e-12, high - low), rgb: PSEUDOCOLORS[item.color].rgb };
    });
    for (let y = 0; y < canvas.height; y++) {
      const sourceY = Math.min(image.height - 1, Math.floor(y / canvas.height * image.height));
      for (let x = 0; x < canvas.width; x++) {
        const sourceX = Math.min(image.width - 1, Math.floor(x / canvas.width * image.width));
        const source = sourceY * image.width + sourceX;
        const target = (y * canvas.width + x) * 4;
        let red = 0, green = 0, blue = 0;
        stretches.forEach(item => {
          if (view !== 'overlay' && view !== 'mask' && view !== item.key) return;
          const value = Math.min(1, Math.max(0, (Number(item.channel.data[source]) - item.low) / item.range));
          red = Math.min(1, red + value * item.rgb[0]);
          green = Math.min(1, green + value * item.rgb[1]);
          blue = Math.min(1, blue + value * item.rgb[2]);
        });
        if (view === 'mask') {
          const positive = analysis?.coloc && Number(channelA.data[source]) - background.a > analysis.coloc.thresholdA && Number(channelB.data[source]) - background.b > analysis.coloc.thresholdB;
          if (positive) { red = green = blue = 1; } else { red *= .18; green *= .18; blue *= .18; }
        }
        pixels.data[target] = red * 255; pixels.data[target + 1] = green * 255; pixels.data[target + 2] = blue * 255; pixels.data[target + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
  }, [image, channelA, channelB, previewSize, view, analysis, background.a, background.b, colorA, colorB, isColoc, intensityChannels, displayBlackPoint, suppressDisplayBackground, displayBackgroundByChannel]);

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
    const roiLabel = !isColoc && roi ? `${Math.round(roi.width)} px${pixelSize > 0 ? ` · ${format(roi.width * pixelSize, 1)} µm` : ''}` : 'ROI';
    drawRect(roi, COLORS.cyan, roiLabel); drawRect(backgroundRoi, COLORS.magenta, 'BG'); drawLine(scanLine);
    if (showScaleBar && pixelSize > 0 && scaleBarUm > 0) {
      const barPixels = scaleBarUm / pixelSize * sx;
      if (barPixels > 2 && barPixels < canvas.width * .8) {
        const endX = canvas.width - 20, y = canvas.height - 22, startX = endX - barPixels;
        context.strokeStyle = 'rgba(0,0,0,.7)'; context.lineWidth = 7; context.beginPath(); context.moveTo(startX, y); context.lineTo(endX, y); context.stroke();
        context.strokeStyle = '#fff'; context.lineWidth = 3; context.beginPath(); context.moveTo(startX, y); context.lineTo(endX, y); context.stroke();
        context.font = '700 12px Arial'; context.textAlign = 'center'; context.fillStyle = '#fff'; context.fillText(`${scaleBarUm} µm`, (startX + endX) / 2, y - 8); context.textAlign = 'start';
      }
    }
    if (draft) {
      if ('width' in draft) drawRect(draft, tool === 'background' ? COLORS.magenta : '#ffffff', tool === 'background' ? 'BG' : 'ROI');
      else drawLine(draft);
    }
  }, [image, previewSize, roi, backgroundRoi, scanLine, draft, tool, lineWidth, showScaleBar, pixelSize, scaleBarUm, isColoc]);

  useEffect(() => {
    const canvas = scatterCanvas.current;
    if (!canvas) return;
    const context = canvas.getContext('2d'); if (!context) return;
    const width = canvas.width = 640, height = canvas.height = 350;
    context.fillStyle = '#13272f'; context.fillRect(0, 0, width, height);
    context.strokeStyle = COLORS.grid; context.lineWidth = 1;
    for (let i = 1; i < 5; i++) { context.beginPath(); context.moveTo(i * width / 5, 0); context.lineTo(i * width / 5, height); context.moveTo(0, i * height / 5); context.lineTo(width, i * height / 5); context.stroke(); }
    if (!analysis?.coloc || !image || !channelA || !channelB) return;
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
    draw(valuesA, PSEUDOCOLORS[displayColorA].css); draw(valuesB, PSEUDOCOLORS[displayColorB].css);
  }, [analysis, sigma, displayColorA, displayColorB]);

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!image || box.width <= 0 || box.height <= 0) return { x: 0, y: 0 };
    const scale = Math.min(box.width / image.width, box.height / image.height);
    const contentWidth = image.width * scale, contentHeight = image.height * scale;
    const offsetX = (box.width - contentWidth) / 2, offsetY = (box.height - contentHeight) / 2;
    return {
      x: Math.min(image.width, Math.max(0, (event.clientX - box.left - offsetX) / scale)),
      y: Math.min(image.height, Math.max(0, (event.clientY - box.top - offsetY) / scale)),
    };
  };

  const makeDraft = (start: { x: number; y: number }, end: { x: number; y: number }) => {
    if (tool === 'line') return { x1: start.x, y1: start.y, x2: end.x, y2: end.y } as Line;
    const width = end.x - start.x, height = end.y - start.y;
    if (!isColoc && tool === 'roi') {
      const side = Math.max(Math.abs(width), Math.abs(height));
      return { x: start.x, y: start.y, width: (width < 0 ? -1 : 1) * side, height: (height < 0 ? -1 : 1) * side } as Rect;
    }
    return { x: start.x, y: start.y, width, height } as Rect;
  };

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
      if (tool === 'background') setBackgroundRoi(normalizedRect(final));
      else {
        const rect = normalizedRect(final);
        if (!rect || isColoc || !image) setRoi(rect);
        else {
          const x = Math.max(0, Math.min(image.width - 1, Math.round(rect.x)));
          const y = Math.max(0, Math.min(image.height - 1, Math.round(rect.y)));
          const side = Math.max(1, Math.min(image.width - x, image.height - y, Math.round(rect.width)));
          setRoi({ x, y, width: side, height: side });
        }
      }
    } else if (!('width' in final) && Math.hypot(final.x2 - final.x1, final.y2 - final.y1) > 2) setScanLine(final);
    setDragStart(null); setDraft(null);
  };

  const updateIntensitySetting = (id: string, patch: Partial<IntensityChannelSetting>) => {
    setIntensitySettings(current => {
      if (patch.enabled && !current.find(setting => setting.id === id)?.enabled && current.filter(setting => setting.enabled).length >= 8) {
        setError('强度分析一次最多选择 8 个通道。');
        return current;
      }
      setError('');
      return current.map(setting => setting.id === id ? { ...setting, ...patch } : setting);
    });
  };

  const setSquareRoiSide = (value: number) => {
    if (!image || !roi || !Number.isFinite(value)) return;
    setRoi(current => {
      if (!current) return current;
      const x = Math.max(0, Math.min(image.width - 1, Math.round(current.x)));
      const y = Math.max(0, Math.min(image.height - 1, Math.round(current.y)));
      const side = Math.max(1, Math.min(image.width - x, image.height - y, Math.round(value)));
      return { x, y, width: side, height: side };
    });
  };

  const runAnalysis = () => {
    if (!image || !channelA || !channelB) return;
    if (image.displayOnly && !allowDisplayOnly) { setError('当前输入是伪彩、RGB 合并图或浏览器解码图。严谨定量请改用原始 OME-TIFF/灰度 TIFF；如只做探索，请先勾选风险确认。'); return; }
    if (mode === 'colocalization' && channelA.id === channelB.id) { setError('共定位必须选择两个不同的原始通道。'); return; }
    if (mode === 'intensity' && !intensityChannels.length) { setError('请至少勾选 1 个强度分析通道。'); return; }
    if (backgroundMethod === 'roi' && !backgroundRoi) { setError('请先选择“背景 ROI”工具并在图像上框选背景区域。'); return; }
    setBusy(true); setError('');
    requestAnimationFrame(() => {
      try {
        const coloc = mode === 'colocalization' ? calculateColocalization(channelA, channelB, image.width, image.height, roi, thresholdMethod, manualA, manualB, background.a, background.b) : null;
        const intensities = mode === 'intensity' ? intensityChannels.map(({ channel }) => {
          const channelBackground = backgroundByChannel.get(channel.id) ?? { mean: 0, sd: 0 };
          return { id: channel.id, stats: intensityStats(channel, image.width, image.height, roi, channelBackground.mean, channelBackground.sd) };
        }) : [];
        const profile = mode === 'intensity' && scanLine ? lineProfile(channelA, channelB, image.width, image.height, scanLine, lineWidth, sigma, background.a, background.b) : null;
        setAnalysis({ signature: analysisSignature, coloc, intensities, profile, createdAt: new Date().toISOString() });
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
      ['metadata', '', 'analysis_mode', mode, ''], ['metadata', '', 'display_only_input', image.displayOnly ? 'yes' : 'no', ''], ['metadata', '', 'pixel_size', pixelSize || '', pixelSize ? 'µm/px' : 'not_set'],
      ['metadata', '', 'background_method', backgroundLabels[backgroundMethod], ''],
      ['metadata', '', 'display_background_suppression', suppressDisplayBackground && backgroundRoi ? `background ROI mean + ${DISPLAY_BACKGROUND_SD_MULTIPLIER} SD` : 'off', ''],
    ];
    if (suppressDisplayBackground && backgroundRoi) displayBackgroundByChannel.forEach((stats, id) => rows.push(['metadata', id, 'display_background_floor', stats.floor, 'A.U.']));
    if (analysis.coloc) {
      rows.push(['metadata', 'A', 'display_color', PSEUDOCOLORS[colorA].label, ''], ['metadata', 'B', 'display_color', PSEUDOCOLORS[colorB].label, '']);
      rows.push(['metadata', '', 'threshold_method', thresholdLabels[thresholdMethod], '']);
      const entries: [string, number, string][] = [
        ['pearson_r', analysis.coloc.pearson, ''], ['pearson_below', analysis.coloc.pearsonBelow, ''], ['pearson_above', analysis.coloc.pearsonAbove, ''],
        ['M1_A_to_B', analysis.coloc.m1, ''], ['M2_B_to_A', analysis.coloc.m2, ''], ['tM1_A_to_B', analysis.coloc.tm1, ''], ['tM2_B_to_A', analysis.coloc.tm2, ''],
        ['manders_overlap', analysis.coloc.overlap, ''], ['Li_ICQ', analysis.coloc.icq, ''], ['coloc_pixels', analysis.coloc.colocPixels, 'px'], ['coloc_area', analysis.coloc.colocAreaPct, '%'],
        ['threshold_A', analysis.coloc.thresholdA, 'A.U.'], ['threshold_B', analysis.coloc.thresholdB, 'A.U.'],
      ];
      entries.forEach(([metric, value, unit]) => rows.push(['colocalization', '', metric, value, unit]));
    } else if (analysis.intensities.length) {
      const addIntensity = (label: string, color: Pseudocolor, stats: IntensityStats) => {
        rows.push(['metadata', label, 'display_color', PSEUDOCOLORS[color].label, '']);
        if (pixelSize) rows.push(['intensity', label, 'area', stats.pixels * pixelSize * pixelSize, 'µm²']);
        Object.entries(stats).forEach(([metric, value]) => rows.push(['intensity', label, metric, value, metric.includes('Pct') ? '%' : metric === 'pixels' ? 'px' : 'A.U.']));
      };
      analysis.intensities.forEach(result => {
        const setting = intensitySettings.find(candidate => candidate.id === result.id);
        const channel = image.channels.find(candidate => candidate.id === result.id);
        if (setting && channel) {
          const label = setting.label || channel.label;
          rows.push(['metadata', label, 'channel_id', channel.id, ''], ['metadata', label, 'source_label', channel.label, '']);
          addIntensity(label, setting.color, result.stats);
        }
      });
    }
    const warnings = [...image.warnings, ...(image.displayOnly ? ['本结果由展示图风险确认后生成，仅供探索。'] : []), ...(analysis.coloc?.warnings ?? []), ...(mode === 'colocalization' ? ['共定位不等于分子相互作用。'] : [])];
    warnings.forEach((warning, index) => rows.push(['warning', '', `warning_${index + 1}`, warning, '']));
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_${mode}_metrics.csv`, rows.map(row => row.map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8');
  };

  const exportProfile = () => {
    if (!analysis?.profile || !image) return;
    const profile = analysis.profile;
    const warnings = [...image.warnings, ...(image.displayOnly ? ['本结果由展示图风险确认后生成，仅供探索。'] : [])];
    const header = ['distance_px', 'distance_um', 'valid_count', 'raw_A', 'raw_B', 'background_corrected_A', 'background_corrected_B', 'smoothed_A', 'smoothed_B', 'sd_A', 'sd_B', 'warning_count', 'warnings'];
    const rows = profile.distance.map((distance, index) => [distance, pixelSize ? distance * pixelSize : '', profile.validCount[index], profile.rawA[index], profile.rawB[index], profile.correctedA[index], profile.correctedB[index], profile.smoothA[index], profile.smoothB[index], profile.sdA[index], profile.sdB[index], index === 0 ? warnings.length : '', index === 0 ? warnings.join(' | ') : '']);
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_line_profile.csv`, [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8');
  };

  const exportJson = () => {
    if (!analysis || !image || !channelA || !channelB) return;
    const payload = {
      schema: 'FluoroScope analysis 1.2', mode, createdAt: analysis.createdAt,
      source: { fileName: image.fileName, sourceFiles: image.sourceFiles, sha256: image.hash, format: image.format, width: image.width, height: image.height, pageCount: image.pageCount, displayOnly: image.displayOnly },
      channels: mode === 'colocalization'
        ? { a: { id: channelA.id, label: channelA.label, bitDepth: channelA.bitDepth }, b: { id: channelB.id, label: channelB.label, bitDepth: channelB.bitDepth } }
        : intensityChannels.map(({ channel, setting }) => ({ id: channel.id, sourceLabel: channel.label, label: setting.label || channel.label, bitDepth: channel.bitDepth, displayColor: setting.color })),
      parameters: { roi, backgroundRoi, backgroundMethod, background: mode === 'colocalization' ? background : Object.fromEntries(intensityChannels.map(({ channel }) => [channel.id, backgroundByChannel.get(channel.id) ?? { mean: 0, sd: 0 }])), thresholdMethod, manualThresholdPercent: { a: manualA, b: manualB }, displayColors: mode === 'colocalization' ? { a: colorA, b: colorB } : Object.fromEntries(intensityChannels.map(({ channel, setting }) => [channel.id, setting.color])), displayBlackPointPercent: displayBlackPoint, displayBackgroundSuppression: { enabled: Boolean(suppressDisplayBackground && backgroundRoi), method: `background_roi_mean_plus_${DISPLAY_BACKGROUND_SD_MULTIPLIER}sd`, channels: Object.fromEntries(displayBackgroundByChannel) }, scaleBar: { shown: showScaleBar, lengthUm: scaleBarUm }, scanLine, lineChannels: { a: channelA.id, b: channelB.id }, lineWidthPx: lineWidth, gaussianSigmaPx: sigma, pixelSizeUm: pixelSize || null, comparison: 'strict >', costesSignificanceTest: false },
      results: mode === 'colocalization' ? { colocalization: analysis.coloc } : { intensities: analysis.intensities, lineProfile: analysis.profile },
      warnings: [...image.warnings, ...(image.displayOnly ? ['本结果由展示图风险确认后生成，仅供探索。'] : []), ...(analysis.coloc?.warnings ?? []), ...(mode === 'colocalization' ? ['共定位不等于分子相互作用。'] : [])],
    };
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_${mode}_analysis.json`, JSON.stringify(payload, null, 2), 'application/json');
  };

  const exportRoiImage = async (format: 'png' | 'jpg' | 'tiff') => {
    if (!image || !roi || !channelA || !channelB) { setError('请先使用“正方形裁剪”工具框选要导出的区域。'); return; }
    if (!isColoc && !intensityChannels.length) { setError('请至少勾选 1 个要显示和导出的通道。'); return; }
    if (showScaleBar && !(pixelSize > 0)) { setError('要显示比例尺，请先填写像素尺寸（µm/px）；也可以取消“导出显示比例尺”。'); return; }
    try {
      setError('');
      const channels = isColoc
        ? [{ id: channelA.id, color: PSEUDOCOLORS[colorA].rgb, displayFloor: suppressDisplayBackground ? displayBackgroundByChannel.get(channelA.id)?.floor : undefined }, { id: channelB.id, color: PSEUDOCOLORS[colorB].rgb, displayFloor: suppressDisplayBackground ? displayBackgroundByChannel.get(channelB.id)?.floor : undefined }]
        : intensityChannels.map(({ channel, setting }) => ({ id: channel.id, color: PSEUDOCOLORS[setting.color].rgb, displayFloor: suppressDisplayBackground ? displayBackgroundByChannel.get(channel.id)?.floor : undefined }));
      const rendered = renderRoiPseudocolor({
        image,
        channels,
        roi,
        view,
        blackPointPercent: displayBlackPoint,
        pixelSizeUm: showScaleBar ? pixelSize : null,
        scaleBarUm: showScaleBar ? scaleBarUm : null,
        mask: view === 'mask' && analysis?.coloc ? { channelAId: channelA.id, channelBId: channelB.id, thresholdA: analysis.coloc.thresholdA, thresholdB: analysis.coloc.thresholdB, backgroundA: background.a, backgroundB: background.b } : null,
      });
      const stem = image.fileName.replace(/\.[^.]+$/, '');
      const name = `${stem}_ROI_${rendered.width}x${rendered.height}`;
      if (format === 'tiff') saveBlob(`${name}_pseudocolor.tif`, new Blob([await encodePseudocolorTiff(rendered)], { type: 'image/tiff' }));
      else saveBlob(`${name}.${format}`, await renderedRoiToBlob(rendered, format));
      if (rendered.scaleBar && !rendered.scaleBar.rendered) setError(`图片已导出，但${rendered.scaleBar.reason}`);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'ROI 图片导出失败。'); }
  };

  const roiText = roi ? `${Math.round(roi.width)} × ${Math.round(roi.height)} px${pixelSize ? ` / ${format(roi.width * pixelSize, 2)} × ${format(roi.height * pixelSize, 2)} µm` : ''}` : '全图';
  const lineLength = scanLine ? Math.hypot(scanLine.x2 - scanLine.x1, scanLine.y2 - scanLine.y1) : 0;
  const allWarnings = [...(image?.warnings ?? []), ...(analysis?.coloc?.warnings ?? [])];
  const visibleWarnings = allWarnings.filter(warning => !warning.startsWith('已在浏览器本地直接读取 OIR') && !warning.startsWith('仅支持同目录不存在同名') && !warning.startsWith('当前直接读取模式已针对'));
  const intensityRows = intensityChannels.map(({ channel, setting }) => ({ channel, setting, stats: analysis?.intensities.find(result => result.id === channel.id)?.stats ?? null }));
  const primaryIntensity = analysis?.intensities[0]?.stats ?? null;
  const primaryIntensityLabel = intensityChannels[0]?.setting.label || intensityChannels[0]?.channel.label || '首个通道';

  return (
    <main className="app-shell" id="top">
      <header className="topbar">
        <a className="brand" href="../" aria-label="FluoroScope 首页"><span className="brand-mark" aria-hidden="true"><i /><i /></span><span>FluoroScope</span></a>
        <nav aria-label="分析工具"><a className={isColoc ? 'active' : ''} href="../colocalization/">荧光共定位</a><a className={!isColoc ? 'active' : ''} href="../intensity/">荧光强度</a></nav>
        <span className="privacy-badge"><i /> 本地分析 · 无需登录</span>
      </header>

      <section className="intro analyzer-intro">
        <div><p className="eyebrow">{isColoc ? 'COLOCALIZATION' : 'INTENSITY'}</p><h1>{isColoc ? '荧光共定位分析' : '荧光强度分析'}</h1></div>
      </section>

      <section className="workspace" id="workspace" aria-label={isColoc ? '荧光共定位工作台' : '荧光强度工作台'}>
        <aside className="control-panel">
          <div className="panel-heading"><span>输入与参数</span><small>{isColoc ? 'COLOC' : 'INTENSITY'}</small></div>
          <div className={`dropzone ${draggingFile ? 'dragging' : ''}`} role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click(); }} onDragOver={event => { event.preventDefault(); setDraggingFile(true); }} onDragLeave={() => setDraggingFile(false)} onDrop={event => { event.preventDefault(); setDraggingFile(false); void load(event.dataTransfer.files); }}>
            <input ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/tiff,.tif,.tiff,.ome.tif,.ome.tiff,.oir" onChange={event => { void load(event.target.files ?? undefined); event.currentTarget.value = ''; }} />
            <span className="upload-glyph" aria-hidden="true">↑</span><strong>{loading ? '正在读取原始像素…' : image ? '更换图像' : '选择一个或多个文件'}</strong><small>Olympus FV3000 OIR 可直接打开<br />也支持 OME-TIFF 与分通道 TIFF</small><em>{image ? `${image.sourceFiles.length} 个文件 · ${image.channels.length} 个通道` : '选择文件'}</em>
          </div>
          {image && <div className="file-facts"><span>{image.format}</span><span>{image.width} × {image.height}</span><span>{image.channels.length} CH</span><span>{image.channels.map(channel => `${channel.bitDepth}-bit`).join(' / ')}</span></div>}

          {isColoc ? <>
            <div className="field-group"><p>02 · 共定位通道</p><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[colorA].css }} />通道 A<select value={channelAId} onChange={event => setChannelAId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.label}</option>)}</select></label><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[colorB].css }} />通道 B<select value={channelBId} onChange={event => setChannelBId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.label}</option>)}</select></label></div>
            <div className="field-group"><p>显示伪彩</p><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[colorA].css }} />通道 A<select value={colorA} onChange={event => setColorA(event.target.value as Pseudocolor)}>{Object.entries(PSEUDOCOLORS).map(([value, color]) => <option key={value} value={value}>{color.label}</option>)}</select></label><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[colorB].css }} />通道 B<select value={colorB} onChange={event => setColorB(event.target.value as Pseudocolor)}>{Object.entries(PSEUDOCOLORS).map(([value, color]) => <option key={value} value={value}>{color.label}</option>)}</select></label><small className="field-help">仅改显示，不改数据。</small></div>
          </> : <>
            <div className="field-group channel-manager"><p>02 · 通道与伪彩</p>{intensitySettings.map(setting => <div className="channel-setting-row" key={setting.id}><label className="channel-check" title={setting.enabled ? '取消该通道' : '选择该通道'}><input type="checkbox" checked={setting.enabled} disabled={!setting.enabled && enabledIntensityIds.length >= 8} onChange={event => { updateIntensitySetting(setting.id, { enabled: event.target.checked }); if (!event.target.checked && view === `channel:${setting.id}`) setView('overlay'); }} /><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[setting.color].css }} /></label><input aria-label={`${setting.label} 自定义名称`} value={setting.label} onChange={event => updateIntensitySetting(setting.id, { label: event.target.value })} /><select aria-label={`${setting.label} 伪彩`} value={setting.color} onChange={event => updateIntensitySetting(setting.id, { color: event.target.value as Pseudocolor })}>{Object.entries(PSEUDOCOLORS).map(([value, color]) => <option key={value} value={value}>{color.label}</option>)}</select></div>)}{image && <small className="field-help">自动匹配 DAPI / 488 / 555 / 647；最多 8 通道。</small>}</div>
          </>}

          <div className="field-group"><p>{isColoc ? '显示去杂色' : '03 · 去除背景杂色'}</p><label className="scale-toggle"><input type="checkbox" checked={suppressDisplayBackground} disabled={!image || !backgroundRoi} onChange={event => setSuppressDisplayBackground(event.target.checked)} /><span>背景 ROI 均值 + {DISPLAY_BACKGROUND_SD_MULTIPLIER} SD</span></label><label className="range-field"><span>黑场 {displayBlackPoint}%</span><input type="range" min="0" max="60" value={displayBlackPoint} disabled={!image} onChange={event => setDisplayBlackPoint(Number(event.target.value))} /></label><small className="field-help">{backgroundRoi ? '勾选后仅改变显示和图片导出。' : '先用图下方“背景 ROI”框选无信号暗区。'}</small></div>

          {!isColoc && <>
            <div className="field-group"><p>04 · 正方形裁剪与标尺</p>{roi ? <label className="number-field"><span>边长</span><input type="number" min="1" max={image ? Math.min(image.width, image.height) : undefined} value={Math.round(roi.width)} onChange={event => setSquareRoiSide(Number(event.target.value))} /><span>px</span></label> : <small className="field-help">点击图下方“正方形裁剪”，再在图中拖拽框选。</small>}{roi && pixelSize > 0 && <small className="field-help">实际边长：{format(roi.width * pixelSize, 2)} µm；导出保持 {Math.round(roi.width)} × {Math.round(roi.height)} px。</small>}<label className="number-field"><span>像素尺寸</span><input type="number" min="0" step="0.001" value={pixelSize} onChange={event => setPixelSize(Math.max(0, Number(event.target.value) || 0))} /><span>µm/px</span></label><label className="scale-toggle"><input type="checkbox" checked={showScaleBar} onChange={event => setShowScaleBar(event.target.checked)} /><span>导出显示比例尺</span></label>{showScaleBar && <label className="number-field"><span>比例尺</span><input type="number" min="0.1" step="0.1" value={scaleBarUm} onChange={event => setScaleBarUm(Math.max(.1, Number(event.target.value) || .1))} /><span>µm</span></label>}</div>
            <div className="field-group"><p>线扫描通道（可选）</p><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorA].css }} />通道 A<select value={channelAId} onChange={event => setChannelAId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{intensitySettings.find(setting => setting.id === channel.id)?.label || channel.label}</option>)}</select></label><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorB].css }} />通道 B<select value={channelBId} onChange={event => setChannelBId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{intensitySettings.find(setting => setting.id === channel.id)?.label || channel.label}</option>)}</select></label></div>
          </>}

          {isColoc && <div className="field-group"><p>阈值</p><label className="wide-field">方法<select value={thresholdMethod} onChange={event => setThresholdMethod(event.target.value as ThresholdMethod)}><option value="costes">Costes 自动</option><option value="otsu">Otsu 自动</option><option value="manual">手动阈值</option><option value="none">零阈值</option></select></label>{thresholdMethod === 'manual' && <div className="range-pair"><label>A {manualA}%<input type="range" min="0" max="100" value={manualA} onChange={event => setManualA(Number(event.target.value))} /></label><label>B {manualB}%<input type="range" min="0" max="100" value={manualB} onChange={event => setManualB(Number(event.target.value))} /></label></div>}</div>}

          <div className="field-group"><p>{isColoc ? '背景与标尺' : '定量扣背景'}</p><label className="wide-field">方法<select value={backgroundMethod} onChange={event => setBackgroundMethod(event.target.value as BackgroundMethod)}><option value="none">不校正</option><option value="roi">背景 ROI 均值</option><option value="percentile">ROI 第 5 百分位</option></select></label>{isColoc && <><label className="number-field"><span>像素尺寸</span><input type="number" min="0" step="0.001" value={pixelSize} onChange={event => setPixelSize(Math.max(0, Number(event.target.value) || 0))} /><span>µm/px</span></label><label className="scale-toggle"><input type="checkbox" checked={showScaleBar} onChange={event => setShowScaleBar(event.target.checked)} /><span>导出比例尺</span></label>{showScaleBar && <label className="number-field"><span>比例尺</span><input type="number" min="0.1" step="0.1" value={scaleBarUm} onChange={event => setScaleBarUm(Math.max(.1, Number(event.target.value) || .1))} /><span>µm</span></label>}</>}<small className="field-help">{isColoc ? '背景用于计算，标尺用于导图。' : '用于数值计算，与显示去杂色分开。'}</small></div>
          {image?.displayOnly && <label className="risk-confirm"><input type="checkbox" checked={allowDisplayOnly} onChange={event => setAllowDisplayOnly(event.target.checked)} /><span><b>当前是展示图</b>仅在理解伪彩/合并 RGB 风险后进行探索性分析。</span></label>}
        </aside>

        <div className="image-stage">
          <div className="stage-toolbar"><div className="view-switch"><button className={view === 'overlay' ? 'selected' : ''} onClick={() => setView('overlay')}>叠加</button>{isColoc ? <><button className={view === 'a' ? 'selected' : ''} onClick={() => setView('a')}>通道 A</button><button className={view === 'b' ? 'selected' : ''} onClick={() => setView('b')}>通道 B</button><button className={view === 'mask' ? 'selected' : ''} onClick={() => setView('mask')} disabled={!analysis?.coloc}>Mask</button></> : intensityChannels.map(({ channel, setting }) => <button key={channel.id} className={view === `channel:${channel.id}` ? 'selected' : ''} onClick={() => setView(`channel:${channel.id}`)}><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[setting.color].css }} />{setting.label || channel.label}</button>)}</div><span>显示设置不影响定量</span></div>
          <div className={`canvas-area tool-${tool}`}>
            {!image && <div className="empty-canvas"><div className="scan-grid" /><span className="crosshair" aria-hidden="true" /><p>等待图像</p><small>可直接选择 FV3000 .oir 原始文件</small></div>}
            {image && <div className="canvas-stack" style={{ aspectRatio: `${image.width}/${image.height}`, maxWidth: `${Math.min(previewSize.width, MAX_PREVIEW_HEIGHT * image.width / image.height)}px` }}><canvas ref={imageCanvas} /><canvas ref={overlayCanvas} aria-label={`在图像上绘制${tool === 'roi' ? '分析 ROI' : tool === 'background' ? '背景 ROI' : '线扫描'}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={() => { setDragStart(null); setDraft(null); }} /></div>}
          </div>
          <div className="stage-tools" aria-label="绘图工具"><button className={tool === 'roi' ? 'selected' : ''} onClick={() => setTool('roi')}><b>□</b>{isColoc ? '分析 ROI' : '正方形裁剪'}</button><button className={tool === 'background' ? 'selected' : ''} onClick={() => setTool('background')}><b>▧</b>背景 ROI</button>{!isColoc && <button className={tool === 'line' ? 'selected' : ''} onClick={() => setTool('line')}><b>╱</b>线扫描</button>}<span className="tool-spacer" /><button onClick={() => setRoi(null)}>使用全图</button><button onClick={() => { setRoi(null); setBackgroundRoi(null); setScanLine(null); setSuppressDisplayBackground(false); }}>清除标注</button></div>
          <div className="stage-foot"><span>{isColoc ? 'ROI' : '正方形裁剪区'}：{roiText}</span>{!isColoc && <span>线长：{scanLine ? `${format(lineLength, 1)} px${pixelSize ? ` / ${format(lineLength * pixelSize, 2)} µm` : ''}` : '—'}</span>}<span>{isColoc ? `BG A/B：${format(background.a, 2)} / ${format(background.b, 2)}` : `定量背景：${backgroundLabels[backgroundMethod]}`}</span></div>
          <div className="roi-export-panel"><div><strong>{roi ? isColoc ? `ROI ${Math.round(roi.width)} × ${Math.round(roi.height)} px` : `裁剪边长 ${Math.round(roi.width)} px${pixelSize ? ` · ${format(roi.width * pixelSize, 2)} µm` : ''}` : `先框选${isColoc ? '分析 ROI' : '正方形'}`}</strong><small>图片为伪彩；定量用 CSV / JSON。</small></div><div className="export-actions"><button disabled={!roi} onClick={() => { void exportRoiImage('png'); }}>PNG</button><button disabled={!roi} onClick={() => { void exportRoiImage('jpg'); }}>JPG</button><button disabled={!roi} onClick={() => { void exportRoiImage('tiff'); }}>TIFF</button></div></div>
        </div>

        <aside className="results-panel">
          <div className="panel-heading"><span>即时结果</span><small>{analysis ? 'READY' : 'PREVIEW'}</small></div>
          {isColoc ? <>
            <div className="metric hero-metric"><small>Pearson&apos;s r</small><strong>{analysis?.coloc ? format(analysis.coloc.pearson) : '—'}</strong><span>强度线性相关</span></div>
            <div className="metric-row"><div className="metric"><small>tM1 · A→B</small><strong>{analysis?.coloc ? format(analysis.coloc.tm1) : '—'}</strong><span>A 信号与 B 共现</span></div><div className="metric"><small>tM2 · B→A</small><strong>{analysis?.coloc ? format(analysis.coloc.tm2) : '—'}</strong><span>B 信号与 A 共现</span></div></div>
            <div className="quick-stats"><span><small>双阳面积</small><b>{analysis?.coloc ? `${format(analysis.coloc.colocAreaPct, 2)}%` : '—'}</b></span><span><small>阈值 A</small><b>{analysis?.coloc ? format(analysis.coloc.thresholdA, 2) : '—'}</b></span><span><small>阈值 B</small><b>{analysis?.coloc ? format(analysis.coloc.thresholdB, 2) : '—'}</b></span></div>
          </> : <>
            <div className="metric hero-metric"><small>Corrected Mean · {primaryIntensityLabel}</small><strong>{primaryIntensity ? format(primaryIntensity.correctedMean, 2) : '—'}</strong><span>首个所选通道的背景校正平均强度</span></div>
            <div className="metric-row"><div className="metric"><small>CTCF</small><strong>{primaryIntensity ? format(primaryIntensity.ctcf, 1) : '—'}</strong><span>{primaryIntensityLabel}</span></div><div className="metric"><small>饱和</small><strong>{primaryIntensity ? `${format(primaryIntensity.saturationPct, 2)}%` : '—'}</strong><span>有效位深上限</span></div></div>
            <div className="quick-stats"><span><small>ROI 像素</small><b>{primaryIntensity ? primaryIntensity.pixels.toLocaleString() : '—'}</b></span><span><small>所选通道</small><b>{enabledIntensityIds.length}</b></span><span><small>正方形边长</small><b>{roi ? `${Math.round(roi.width)} px` : '全图'}</b></span></div>
          </>}
          {error && <p className="error-message" role="alert">{error}</p>}
          <button className="analyze-button" onClick={runAnalysis} disabled={!image || busy || loading || Boolean(image?.displayOnly && !allowDisplayOnly)}>{busy ? '正在计算…' : image ? `运行${isColoc ? '共定位' : '强度'}分析` : '载入图像后分析'} <span>→</span></button>
          <p className="run-note">{isColoc ? `${thresholdLabels[thresholdMethod]} · ` : ''}{backgroundLabels[backgroundMethod]}</p>
        </aside>
      </section>

      <section className="detail-section" id="results">
        <div className="section-title"><h2>{isColoc ? '共定位结果' : '强度结果'}</h2>{analysis && <div className="export-actions"><button onClick={exportRows}>指标 CSV</button><button onClick={exportJson}>完整 JSON</button>{analysis.profile && <button onClick={exportProfile}>线扫 CSV</button>}</div>}</div>

        {isColoc && <div className="result-grid">
          <article className="result-card scatter-card"><header><div><span>共定位散点图</span><small>黄线：阈值 · 洋红线：Costes 回归</small></div><b>{analysis?.coloc ? thresholdLabels[thresholdMethod] : '等待分析'}</b></header><canvas ref={scatterCanvas} aria-label="通道 A 与 B 的强度散点图" /><div className="legend"><span><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[colorA].css }} />X：通道 A</span><span><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[colorB].css }} />Y：通道 B</span></div></article>
          <article className="result-card coefficients"><header><div><span>共定位指标</span><small>相关与共现分开报告</small></div></header><dl><div><dt>Pearson（无阈值）</dt><dd>{analysis?.coloc ? format(analysis.coloc.pearson) : '—'}</dd></div><div><dt>Pearson（阈值下）</dt><dd>{analysis?.coloc ? format(analysis.coloc.pearsonBelow) : '—'}</dd></div><div><dt>Pearson（阈值上）</dt><dd>{analysis?.coloc ? format(analysis.coloc.pearsonAbove) : '—'}</dd></div><div><dt>Manders M1 / M2</dt><dd>{analysis?.coloc ? `${format(analysis.coloc.m1)} / ${format(analysis.coloc.m2)}` : '—'}</dd></div><div><dt>Manders tM1 / tM2</dt><dd>{analysis?.coloc ? `${format(analysis.coloc.tm1)} / ${format(analysis.coloc.tm2)}` : '—'}</dd></div><div><dt>Manders overlap</dt><dd>{analysis?.coloc ? format(analysis.coloc.overlap) : '—'}</dd></div><div><dt>Li ICQ</dt><dd>{analysis?.coloc ? format(analysis.coloc.icq) : '—'}</dd></div><div><dt>双阳性像素</dt><dd>{analysis?.coloc ? `${analysis.coloc.colocPixels.toLocaleString()} (${format(analysis.coloc.colocAreaPct, 2)}%)` : '—'}</dd></div></dl></article>
        </div>}

        {!isColoc && <>
          <article className="result-card intensity-card"><header><div><span>正方形 ROI 荧光强度</span><small>所有已勾选通道分别计算；RawIntDen、背景校正与 CTCF 基于原始像素值</small></div><b>{roi ? `ROI ${roiText}` : '全图'}</b></header><div className="table-wrap"><table><thead><tr><th>通道</th><th>像素数</th><th>Mean</th><th>Median</th><th>SD</th><th>Min–Max</th><th>RawIntDen</th><th>Background</th><th>Corrected Mean</th><th>CTCF</th><th>饱和</th></tr></thead><tbody>{intensityRows.map(({ channel, setting, stats }) => <tr key={channel.id}><td><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[setting.color].css }} />{setting.label || channel.label}</td><td>{stats ? stats.pixels.toLocaleString() : '—'}</td><td>{stats ? format(stats.mean, 2) : '—'}</td><td>{stats ? format(stats.median, 2) : '—'}</td><td>{stats ? format(stats.sd, 2) : '—'}</td><td>{stats ? `${format(stats.min, 1)}–${format(stats.max, 1)}` : '—'}</td><td>{stats ? format(stats.sum, 1) : '—'}</td><td>{stats ? format(stats.backgroundMean, 2) : '—'}</td><td>{stats ? format(stats.correctedMean, 2) : '—'}</td><td>{stats ? format(stats.ctcf, 1) : '—'}</td><td>{stats ? `${format(stats.saturationPct, 2)}%` : '—'}</td></tr>)}</tbody></table></div></article>
          <article className="result-card profile-card"><header><div><span>荧光线扫描</span><small>沿线每 1 px 双线性采样；线宽内取 mean ± sample SD</small></div><div className="profile-controls"><label>线宽<input type="number" min="1" max="101" value={lineWidth} onChange={event => setLineWidth(Math.max(1, Math.min(101, Number(event.target.value) || 1)))} />px</label><label>Gaussian σ<input type="number" min="0" max="20" step="0.5" value={sigma} onChange={event => setSigma(Math.max(0, Math.min(20, Number(event.target.value) || 0)))} />px</label></div></header>{!scanLine && <p className="profile-empty">选择“线扫描”工具，在图像上拖出一条线；然后运行分析。</p>}<canvas ref={profileCanvas} aria-label="通道 A 与 B 的线扫描曲线" /><div className="legend"><span><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorA].css }} />通道 A · {intensitySettings.find(setting => setting.id === channelA?.id)?.label || channelA?.label}</span><span><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorB].css }} />通道 B · {intensitySettings.find(setting => setting.id === channelB?.id)?.label || channelB?.label}</span><span>横轴：{pixelSize ? `µm（${pixelSize} µm/px）` : 'pixel（未标定）'}</span><span>{sigma > 0 ? `显示 Gaussian σ=${sigma}px；CSV 保留原始曲线` : '未平滑'}</span></div></article>
        </>}

        <div className="qa-grid">
          <article className="qa-card"><span>输入</span>{image ? <p>{image.fileName} · {image.width} × {image.height} px · {image.channels.length} 通道 · {image.channels.map(channel => `${channel.bitDepth}-bit`).join(' / ')}{pixelSize > 0 ? ` · ${pixelSize} µm/px` : ''}</p> : <p>尚未载入图像。</p>}</article>
          <article className="qa-card warning"><span>提示</span><ul>{visibleWarnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}{isColoc && <li>共定位不能证明分子相互作用。</li>}<li>跨样本比较须保持采集参数一致。</li></ul></article>
        </div>
      </section>
      <footer><span>FluoroScope</span><span className="footer-links"><a href="../">首页</a><a href="https://github.com/weigenwu/IFA" target="_blank" rel="noreferrer">GitHub ↗</a></span></footer>
    </main>
  );
}
