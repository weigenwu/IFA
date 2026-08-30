'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  boundsFor,
  calculateColocalization,
  displayWindow,
  fitSquareRoi,
  intensityStats,
  lineProfile,
  percentileInRoi,
  resizeSquareFromAnchor,
  scatterSample,
  type ColocResult,
  type DisplayPreset,
  type IntensityStats,
  type Line,
  type LineProfile,
  type Rect,
} from '../lib/analysis';
import { loadImages, type LoadedImage } from '../lib/image';
import { createStoredZip, safeFilePart } from '../lib/export-archive';
import { encodePseudocolorTiff, renderRoiPseudocolor, renderedRoiToBlob, resolveDisplayRange } from '../lib/roi-export';

type Tool = 'roi' | 'background' | 'line';
type View = 'overlay' | 'a' | 'b' | 'mask' | `channel:${string}`;
type ThresholdMethod = 'costes' | 'otsu' | 'manual' | 'none';
type BackgroundMethod = 'none' | 'roi' | 'percentile';
type AnalysisMode = 'colocalization' | 'intensity';
type Pseudocolor = 'green' | 'red' | 'blue' | 'cyan' | 'magenta' | 'yellow' | 'orange' | 'violet' | 'gray';
type RoiCorner = 'nw' | 'ne' | 'sw' | 'se';
type RoiSizeUnit = 'px' | 'um' | 'mm' | 'cm';
type RoiExportFormat = 'png' | 'jpg' | 'tiff';
type IntensityExportTarget = 'merge' | 'all' | `channel:${string}`;

interface RoiResizeState {
  anchor: { x: number; y: number };
  directionX: -1 | 1;
  directionY: -1 | 1;
}

interface AnalysisState {
  signature: string;
  coloc: ColocResult | null;
  intensities: Array<{ id: string; stats: IntensityStats }>;
  profile: LineProfile | null;
  createdAt: string;
}

interface ChannelSetting {
  id: string;
  enabled: boolean;
  label: string;
  color: Pseudocolor;
  displayMin: number;
  displayMax: number;
  displayPreset: DisplayPreset | 'manual';
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
const MAX_BATCH_RGB_BYTES = 128 * 1024 * 1024;
const DISPLAY_BACKGROUND_SD_MULTIPLIER = 2;
const MICRONS_PER_UNIT = { um: 1, mm: 1000, cm: 10000 } as const;
const ROI_UNIT_LABELS: Record<RoiSizeUnit, string> = { px: 'px', um: 'µm', mm: 'mm', cm: 'cm' };

function isTransmittedLight(id: string, label: string) {
  const value = `${id} ${label}`.toLowerCase();
  return /(^|[\s_./-])(td\d*|transmitted|transmission|bright[\s_-]*field|bf|dic|phase)(?=$|[\s_./-])|透射|明场/.test(value);
}

function suggestedColor(id: string, label: string, sourceColor: string | null | undefined, index: number): Pseudocolor {
  const lut = sourceColor?.toLowerCase() ?? '';
  if (/magenta/.test(lut)) return 'magenta';
  if (/violet|purple/.test(lut)) return 'violet';
  if (/orange/.test(lut)) return 'orange';
  if (/yellow/.test(lut)) return 'yellow';
  if (/cyan/.test(lut)) return 'cyan';
  if (/blue/.test(lut)) return 'blue';
  if (/green/.test(lut)) return 'green';
  if (/red/.test(lut)) return 'red';
  if (/gr[ae]y|white/.test(lut)) return 'gray';
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

function initialChannelSettings(image: LoadedImage): ChannelSetting[] {
  let enabledCount = 0;
  return image.channels.map((channel, index) => {
    const enabled = !isTransmittedLight(channel.id, channel.label) && enabledCount < 8;
    if (enabled) enabledCount++;
    const range = displayWindow(channel, image.width, image.height, 'imagej');
    return { id: channel.id, enabled, label: channel.label, color: suggestedColor(channel.id, channel.label, channel.sourceColor, index), displayMin: range.min, displayMax: range.max, displayPreset: 'imagej' };
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

function roiSideInUnit(sidePx: number, pixelSizeUm: number, unit: RoiSizeUnit) {
  if (unit === 'px') return sidePx;
  return sidePx * pixelSizeUm / MICRONS_PER_UNIT[unit];
}

function roiUnitPrecision(pixelSizeUm: number, unit: RoiSizeUnit) {
  if (unit === 'px' || !(pixelSizeUm > 0)) return 0;
  const onePixel = roiSideInUnit(1, pixelSizeUm, unit);
  const needed = Math.max(0, Math.ceil(-Math.log10(onePixel)) + 1);
  const base = unit === 'um' ? 2 : unit === 'mm' ? 4 : 6;
  return Math.min(8, Math.max(base, needed));
}

function roiSideLabel(sidePx: number, pixelSizeUm: number, unit: RoiSizeUnit) {
  if (!(pixelSizeUm > 0)) return `${Math.round(sidePx)} px`;
  if (unit === 'px') return `${Math.round(sidePx)} px · ${format(roiSideInUnit(sidePx, pixelSizeUm, 'um'), roiUnitPrecision(pixelSizeUm, 'um'))} µm`;
  return `${format(roiSideInUnit(sidePx, pixelSizeUm, unit), roiUnitPrecision(pixelSizeUm, unit))} ${ROI_UNIT_LABELS[unit]} · ${Math.round(sidePx)} px`;
}

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
  const [channelSettings, setChannelSettings] = useState<ChannelSetting[]>([]);
  const [channelConfirmed, setChannelConfirmed] = useState(false);
  const [displayChannelId, setDisplayChannelId] = useState('');
  const [displayBlackPoint, setDisplayBlackPoint] = useState(0);
  const [suppressDisplayBackground, setSuppressDisplayBackground] = useState(false);
  const [showScaleBar, setShowScaleBar] = useState(true);
  const [scaleBarUm, setScaleBarUm] = useState(20);
  const [layoutSizeRatio, setLayoutSizeRatio] = useState(1000);
  const [roiSizeUnit, setRoiSizeUnit] = useState<RoiSizeUnit>('px');
  const [squareSizeLocked, setSquareSizeLocked] = useState(false);
  const [roiTargetSidePx, setRoiTargetSidePx] = useState(256);
  const [intensityExportTarget, setIntensityExportTarget] = useState<IntensityExportTarget>('merge');
  const [exportingRoi, setExportingRoi] = useState<RoiExportFormat | null>(null);
  const [roiMoveOffset, setRoiMoveOffset] = useState<{ x: number; y: number } | null>(null);
  const [roiResize, setRoiResize] = useState<RoiResizeState | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const imageCanvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const scatterCanvas = useRef<HTMLCanvasElement>(null);
  const profileCanvas = useRef<HTMLCanvasElement>(null);

  const enabledIntensityIds = useMemo(() => channelSettings.filter(setting => setting.enabled).map(setting => setting.id), [channelSettings]);
  const analysisSignature = useMemo(() => JSON.stringify({ mode, channelAId, channelBId, intensityChannels: enabledIntensityIds, roi, backgroundRoi: backgroundMethod === 'roi' ? backgroundRoi : null, scanLine, thresholdMethod, manualA, manualB, backgroundMethod, lineWidth, sigma, pixelSize, allowDisplayOnly }), [mode, channelAId, channelBId, enabledIntensityIds, roi, backgroundRoi, scanLine, thresholdMethod, manualA, manualB, backgroundMethod, lineWidth, sigma, pixelSize, allowDisplayOnly]);
  const analysis = analysisState?.signature === analysisSignature ? analysisState : null;

  const channelA = image?.channels.find(channel => channel.id === channelAId) ?? image?.channels[0];
  const channelB = image?.channels.find(channel => channel.id === channelBId) ?? image?.channels[1] ?? image?.channels[0];
  const intensityChannels = useMemo(() => channelSettings.flatMap(setting => {
    if (!setting.enabled) return [];
    const channel = image?.channels.find(candidate => candidate.id === setting.id);
    return channel ? [{ setting, channel }] : [];
  }), [image, channelSettings]);
  const channelASetting = channelSettings.find(setting => setting.id === channelA?.id);
  const channelBSetting = channelSettings.find(setting => setting.id === channelB?.id);
  const displayColorA = channelASetting?.color ?? 'green';
  const displayColorB = channelBSetting?.color ?? 'red';
  const channelALabel = channelASetting?.label || channelA?.label || '通道 A';
  const channelBLabel = channelBSetting?.label || channelB?.label || '通道 B';
  const activeDisplaySetting = channelSettings.find(setting => setting.id === displayChannelId) ?? channelSettings[0];
  const activeDisplayChannel = image?.channels.find(channel => channel.id === activeDisplaySetting?.id);

  const histogram = useMemo(() => {
    if (!activeDisplayChannel) return null;
    const bins = new Uint32Array(64);
    const axisMin = activeDisplayChannel.integer ? 0 : percentileInRoi(activeDisplayChannel, image!.width, image!.height, null, 0);
    const axisMax = activeDisplayChannel.integer ? activeDisplayChannel.maxValue : percentileInRoi(activeDisplayChannel, image!.width, image!.height, null, 1);
    const range = Math.max(1e-12, axisMax - axisMin);
    const step = Math.max(1, Math.ceil(activeDisplayChannel.data.length / 250000));
    for (let index = 0; index < activeDisplayChannel.data.length; index += step) {
      const bin = Math.min(bins.length - 1, Math.max(0, Math.floor((Number(activeDisplayChannel.data[index]) - axisMin) / range * bins.length)));
      bins[bin]++;
    }
    const peak = Math.max(1, ...Array.from(bins, count => Math.log1p(count)));
    const points = [`0,32`, ...Array.from(bins, (count, index) => `${index / (bins.length - 1) * 100},${32 - Math.log1p(count) / peak * 30}`), `100,32`].join(' ');
    return { axisMin, axisMax, points };
  }, [activeDisplayChannel, image]);

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
      const settings = initialChannelSettings(loaded);
      setChannelSettings(settings); setChannelConfirmed(false); setDisplayChannelId(settings[0]?.id ?? '');
      const fluorescence = settings.filter(setting => setting.enabled);
      const green = loaded.channels.find(channel => channel.id === 'green') ?? loaded.channels.find(channel => channel.id === fluorescence[0]?.id) ?? loaded.channels[0];
      const red = loaded.channels.find(channel => channel.id === 'red') ?? loaded.channels.find(channel => channel.id === fluorescence[1]?.id) ?? loaded.channels[1] ?? loaded.channels[0];
      setChannelAId(green.id); setChannelBId(red.id);
      setRoi(null); setBackgroundRoi(null); setScanLine(null); setView('overlay'); setIntensityExportTarget('merge'); setTool('roi');
      const loadedPixelSize = loaded.pixelSizeUm ?? 0;
      setPixelSize(loadedPixelSize); setScaleBarUm(suggestedScaleBarUm(loaded.width, loadedPixelSize));
      setDisplayBlackPoint(0); setSuppressDisplayBackground(false); setShowScaleBar(true); setAllowDisplayOnly(false);
      setRoiSizeUnit(loadedPixelSize > 0 ? 'um' : 'px'); setSquareSizeLocked(false); setRoiTargetSidePx(Math.min(256, loaded.width, loaded.height)); setRoiMoveOffset(null); setRoiResize(null);
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
      ? [{ channel: channelA, setting: channelASetting, color: displayColorA, key: 'a' }, { channel: channelB, setting: channelBSetting, color: displayColorB, key: 'b' }]
      : intensityChannels.map(({ channel, setting }) => ({ channel, setting, color: setting.color, key: `channel:${channel.id}` }));
    const stretches = displayChannels.map(item => {
      const backgroundFloor = suppressDisplayBackground ? displayBackgroundByChannel.get(item.channel.id)?.floor : undefined;
      const range = resolveDisplayRange(item.channel, image.width, image.height, { displayMin: item.setting?.displayMin, displayMax: item.setting?.displayMax, displayFloor: backgroundFloor, blackPointPercent: displayBlackPoint });
      return { ...item, ...range, rgb: PSEUDOCOLORS[item.color].rgb };
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
        pixels.data[target] = Math.round(red * 255); pixels.data[target + 1] = Math.round(green * 255); pixels.data[target + 2] = Math.round(blue * 255); pixels.data[target + 3] = 255;
      }
    }
    context.putImageData(pixels, 0, 0);
  }, [image, channelA, channelB, channelASetting, channelBSetting, previewSize, view, analysis, background.a, background.b, displayColorA, displayColorB, isColoc, intensityChannels, displayBlackPoint, suppressDisplayBackground, displayBackgroundByChannel]);

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
    const drawRoiHandles = (rect: Rect) => {
      const value = normalizedRect(rect); if (!value) return;
      const corners = [[value.x, value.y], [value.x + value.width, value.y], [value.x, value.y + value.height], [value.x + value.width, value.y + value.height]];
      corners.forEach(([x, y]) => {
        context.beginPath(); context.arc(x * sx, y * sy, 6, 0, Math.PI * 2);
        context.fillStyle = '#fff'; context.fill(); context.strokeStyle = COLORS.cyan; context.lineWidth = 2; context.stroke();
      });
    };
    const roiLabel = !isColoc && roi ? `边长 ${roiSideLabel(roi.width, pixelSize, roiSizeUnit)}` : 'ROI';
    drawRect(roi, COLORS.cyan, roiLabel); drawRect(backgroundRoi, COLORS.magenta, 'BG'); drawLine(scanLine);
    if (!isColoc && tool === 'roi' && roi && !squareSizeLocked) drawRoiHandles(roi);
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
  }, [image, previewSize, roi, backgroundRoi, scanLine, draft, tool, lineWidth, showScaleBar, pixelSize, scaleBarUm, isColoc, squareSizeLocked, roiSizeUnit]);

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
    if (!isColoc && tool === 'roi' && squareSizeLocked && roi && image) {
      return fitSquareRoi(image.width, image.height, end.x - roi.width / 2, end.y - roi.height / 2, roi.width);
    }
    if (!isColoc && tool === 'roi' && squareSizeLocked && image) {
      return fitSquareRoi(image.width, image.height, end.x - roiTargetSidePx / 2, end.y - roiTargetSidePx / 2, roiTargetSidePx);
    }
    const width = end.x - start.x, height = end.y - start.y;
    if (!isColoc && tool === 'roi') {
      const side = Math.max(Math.abs(width), Math.abs(height));
      return { x: start.x, y: start.y, width: (width < 0 ? -1 : 1) * side, height: (height < 0 ? -1 : 1) * side } as Rect;
    }
    return { x: start.x, y: start.y, width, height } as Rect;
  };

  const roiCornerAtPoint = (event: React.PointerEvent<HTMLCanvasElement>, point: { x: number; y: number }, rect: Rect): RoiCorner | null => {
    if (!image) return null;
    const box = event.currentTarget.getBoundingClientRect();
    const scale = Math.min(box.width / image.width, box.height / image.height);
    const hitRadius = 22 / Math.max(scale, 1e-12);
    const corners: Array<{ corner: RoiCorner; x: number; y: number }> = [
      { corner: 'nw', x: rect.x, y: rect.y }, { corner: 'ne', x: rect.x + rect.width, y: rect.y },
      { corner: 'sw', x: rect.x, y: rect.y + rect.height }, { corner: 'se', x: rect.x + rect.width, y: rect.y + rect.height },
    ];
    let nearest: { corner: RoiCorner; distance: number } | null = null;
    for (const candidate of corners) {
      const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
      if (!nearest || distance < nearest.distance) nearest = { corner: candidate.corner, distance };
    }
    return nearest && nearest.distance <= hitRadius ? nearest.corner : null;
  };

  const resizeStateForCorner = (rect: Rect, corner: RoiCorner): RoiResizeState => {
    if (corner === 'nw') return { anchor: { x: rect.x + rect.width, y: rect.y + rect.height }, directionX: -1, directionY: -1 };
    if (corner === 'ne') return { anchor: { x: rect.x, y: rect.y + rect.height }, directionX: 1, directionY: -1 };
    if (corner === 'sw') return { anchor: { x: rect.x + rect.width, y: rect.y }, directionX: -1, directionY: 1 };
    return { anchor: { x: rect.x, y: rect.y }, directionX: 1, directionY: 1 };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!image || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    const selected = normalizedRect(roi);
    if (!isColoc && tool === 'roi' && selected) {
      const corner = squareSizeLocked ? null : roiCornerAtPoint(event, point, selected);
      if (corner) {
        setRoiResize(resizeStateForCorner(selected, corner)); setRoiMoveOffset(null); setDragStart(null); setDraft(null);
        event.currentTarget.style.cursor = corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize';
        return;
      }
    }
    if (!isColoc && tool === 'roi' && selected && point.x >= selected.x && point.x <= selected.x + selected.width && point.y >= selected.y && point.y <= selected.y + selected.height) {
      setRoiMoveOffset({ x: point.x - selected.x, y: point.y - selected.y }); setDragStart(null); setDraft(null); return;
    }
    setRoiResize(null); setDragStart(point); setDraft(makeDraft(point, point));
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(event);
    if (roiResize && image) {
      const resized = resizeSquareFromAnchor(image.width, image.height, roiResize.anchor, point, roiResize.directionX, roiResize.directionY);
      setRoi(resized); setRoiTargetSidePx(resized.width);
      return;
    }
    if (roiMoveOffset && image && roi) {
      setRoi(fitSquareRoi(image.width, image.height, point.x - roiMoveOffset.x, point.y - roiMoveOffset.y, roi.width));
      return;
    }
    if (!dragStart) {
      const selected = normalizedRect(roi);
      if (!isColoc && tool === 'roi' && selected) {
        const corner = squareSizeLocked ? null : roiCornerAtPoint(event, point, selected);
        const inside = point.x >= selected.x && point.x <= selected.x + selected.width && point.y >= selected.y && point.y <= selected.y + selected.height;
        event.currentTarget.style.cursor = corner ? corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize' : inside ? 'move' : 'crosshair';
      } else event.currentTarget.style.cursor = '';
      return;
    }
    setDraft(makeDraft(dragStart, point));
  };
  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (roiResize && image) {
      const resized = resizeSquareFromAnchor(image.width, image.height, roiResize.anchor, pointFromEvent(event), roiResize.directionX, roiResize.directionY);
      setRoi(resized); setRoiTargetSidePx(resized.width); setRoiResize(null); event.currentTarget.style.cursor = ''; return;
    }
    if (roiMoveOffset) { setRoiMoveOffset(null); event.currentTarget.style.cursor = ''; return; }
    if (!dragStart) return;
    const final = makeDraft(dragStart, pointFromEvent(event));
    if ('width' in final && Math.abs(final.width) > 2 && Math.abs(final.height) > 2) {
      if (tool === 'background') setBackgroundRoi(normalizedRect(final));
      else {
        const rect = normalizedRect(final);
        if (!rect || isColoc || !image) setRoi(rect);
        else {
          const fitted = fitSquareRoi(image.width, image.height, rect.x, rect.y, rect.width);
          setRoiTargetSidePx(fitted.width);
          setRoi(fitted);
        }
      }
    } else if ('width' in final && !isColoc && tool === 'roi' && image) {
      const point = pointFromEvent(event);
      const fitted = fitSquareRoi(image.width, image.height, point.x - roiTargetSidePx / 2, point.y - roiTargetSidePx / 2, roiTargetSidePx);
      setRoi(fitted); setRoiTargetSidePx(fitted.width);
    } else if (!('width' in final) && Math.hypot(final.x2 - final.x1, final.y2 - final.y1) > 2) setScanLine(final);
    setDragStart(null); setDraft(null);
  };

  const updateChannelSetting = (id: string, patch: Partial<ChannelSetting>) => {
    setChannelSettings(current => {
      if (patch.enabled && !current.find(setting => setting.id === id)?.enabled && current.filter(setting => setting.enabled).length >= 8) {
        setError('强度分析一次最多选择 8 个通道。');
        return current;
      }
      setError('');
      return current.map(setting => setting.id === id ? { ...setting, ...patch } : setting);
    });
    if ('enabled' in patch || 'label' in patch || 'color' in patch) setChannelConfirmed(false);
  };

  const setChannelDisplayPreset = (id: string, preset: DisplayPreset) => {
    if (!image) return;
    const channel = image.channels.find(candidate => candidate.id === id);
    if (!channel) return;
    const range = displayWindow(channel, image.width, image.height, preset);
    updateChannelSetting(id, { displayMin: range.min, displayMax: range.max, displayPreset: preset });
  };

  const setManualDisplayValue = (id: string, key: 'displayMin' | 'displayMax', value: number) => {
    if (!Number.isFinite(value)) return;
    const setting = channelSettings.find(candidate => candidate.id === id);
    if (!setting || (key === 'displayMin' ? value >= setting.displayMax : value <= setting.displayMin)) {
      setError('显示范围需要 Min 小于 Max。');
      return;
    }
    setError('');
    updateChannelSetting(id, { [key]: value, displayPreset: 'manual' });
  };

  const setSquareRoiSide = (value: number) => {
    if (!image || !Number.isFinite(value)) return;
    const sidePx = roiSizeUnit === 'px' ? value : value * MICRONS_PER_UNIT[roiSizeUnit] / pixelSize;
    if (!Number.isFinite(sidePx) || sidePx <= 0) return;
    const centerX = roi ? roi.x + roi.width / 2 : image.width / 2;
    const centerY = roi ? roi.y + roi.height / 2 : image.height / 2;
    const fitted = fitSquareRoi(image.width, image.height, centerX - sidePx / 2, centerY - sidePx / 2, sidePx);
    setRoiTargetSidePx(fitted.width);
    setRoi(fitted);
  };

  const runAnalysis = () => {
    if (!image || !channelA || !channelB) return;
    if (!channelConfirmed) { setError('请先确认通道名称和伪彩。'); return; }
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
    if (!channelConfirmed) { setError('请先确认通道名称和伪彩。'); return; }
    if (!analysis || !image || !channelA || !channelB) return;
    const rows: (string | number)[][] = [
      ['section', 'channel', 'metric', 'value', 'unit'],
      ['metadata', '', 'file_name', image.fileName, ''], ['metadata', '', 'sha256', image.hash, ''],
      ['metadata', '', 'width', image.width, 'px'], ['metadata', '', 'height', image.height, 'px'],
      ['metadata', '', 'analysis_mode', mode, ''], ['metadata', '', 'display_only_input', image.displayOnly ? 'yes' : 'no', ''], ['metadata', '', 'pixel_size', pixelSize || '', pixelSize ? 'µm/px' : 'not_set'],
      ['metadata', '', 'background_method', backgroundLabels[backgroundMethod], ''],
      ['metadata', '', 'display_black_point', displayBlackPoint, '%'],
      ['metadata', '', 'display_background_suppression', suppressDisplayBackground && backgroundRoi ? `background ROI mean + ${DISPLAY_BACKGROUND_SD_MULTIPLIER} SD` : 'off', ''],
    ];
    if (suppressDisplayBackground && backgroundRoi) displayBackgroundByChannel.forEach((stats, id) => rows.push(['metadata', id, 'display_background_floor', stats.floor, 'A.U.']));
    if (analysis.coloc) {
      rows.push(
        ['metadata', 'A', 'channel_id', channelA.id, ''], ['metadata', 'A', 'source_label', channelA.label, ''], ['metadata', 'A', 'source_color', channelA.sourceColor ?? '', ''], ['metadata', 'A', 'display_label', channelALabel, ''], ['metadata', 'A', 'display_color', PSEUDOCOLORS[displayColorA].label, ''],
        ['metadata', 'B', 'channel_id', channelB.id, ''], ['metadata', 'B', 'source_label', channelB.label, ''], ['metadata', 'B', 'source_color', channelB.sourceColor ?? '', ''], ['metadata', 'B', 'display_label', channelBLabel, ''], ['metadata', 'B', 'display_color', PSEUDOCOLORS[displayColorB].label, ''],
      );
      if (channelASetting) rows.push(['metadata', 'A', 'display_min', channelASetting.displayMin, 'A.U.'], ['metadata', 'A', 'display_max', channelASetting.displayMax, 'A.U.'], ['metadata', 'A', 'display_preset', channelASetting.displayPreset, '']);
      if (channelBSetting) rows.push(['metadata', 'B', 'display_min', channelBSetting.displayMin, 'A.U.'], ['metadata', 'B', 'display_max', channelBSetting.displayMax, 'A.U.'], ['metadata', 'B', 'display_preset', channelBSetting.displayPreset, '']);
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
        const setting = channelSettings.find(candidate => candidate.id === result.id);
        const channel = image.channels.find(candidate => candidate.id === result.id);
        if (setting && channel) {
          const label = setting.label || channel.label;
          rows.push(['metadata', label, 'channel_id', channel.id, ''], ['metadata', label, 'source_label', channel.label, ''], ['metadata', label, 'source_color', channel.sourceColor ?? '', '']);
          rows.push(['metadata', label, 'display_min', setting.displayMin, 'A.U.'], ['metadata', label, 'display_max', setting.displayMax, 'A.U.'], ['metadata', label, 'display_preset', setting.displayPreset, '']);
          addIntensity(label, setting.color, result.stats);
        }
      });
    }
    const warnings = [...image.warnings, ...(image.displayOnly ? ['本结果由展示图风险确认后生成，仅供探索。'] : []), ...(analysis.coloc?.warnings ?? []), ...(mode === 'colocalization' ? ['共定位不等于分子相互作用。'] : [])];
    warnings.forEach((warning, index) => rows.push(['warning', '', `warning_${index + 1}`, warning, '']));
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_${mode}_metrics.csv`, rows.map(row => row.map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8');
  };

  const exportProfile = () => {
    if (!channelConfirmed) { setError('请先确认通道名称和伪彩。'); return; }
    if (!analysis?.profile || !image || !channelA || !channelB) return;
    const profile = analysis.profile;
    const warnings = [...image.warnings, ...(image.displayOnly ? ['本结果由展示图风险确认后生成，仅供探索。'] : [])];
    const header = ['distance_px', 'distance_um', 'valid_count', 'raw_A', 'raw_B', 'background_corrected_A', 'background_corrected_B', 'smoothed_A', 'smoothed_B', 'sd_A', 'sd_B', 'channel_A_id', 'channel_A_source_label', 'channel_A_display_label', 'channel_A_source_color', 'channel_B_id', 'channel_B_source_label', 'channel_B_display_label', 'channel_B_source_color', 'warning_count', 'warnings'];
    const rows = profile.distance.map((distance, index) => [distance, pixelSize ? distance * pixelSize : '', profile.validCount[index], profile.rawA[index], profile.rawB[index], profile.correctedA[index], profile.correctedB[index], profile.smoothA[index], profile.smoothB[index], profile.sdA[index], profile.sdB[index], index === 0 ? channelA.id : '', index === 0 ? channelA.label : '', index === 0 ? channelALabel : '', index === 0 ? channelA.sourceColor ?? '' : '', index === 0 ? channelB.id : '', index === 0 ? channelB.label : '', index === 0 ? channelBLabel : '', index === 0 ? channelB.sourceColor ?? '' : '', index === 0 ? warnings.length : '', index === 0 ? warnings.join(' | ') : '']);
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_line_profile.csv`, [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n'), 'text/csv;charset=utf-8');
  };

  const exportJson = () => {
    if (!channelConfirmed) { setError('请先确认通道名称和伪彩。'); return; }
    if (!analysis || !image || !channelA || !channelB) return;
    const payload = {
      schema: 'FluoroScope analysis 1.3', mode, createdAt: analysis.createdAt,
      source: { fileName: image.fileName, sourceFiles: image.sourceFiles, sha256: image.hash, format: image.format, width: image.width, height: image.height, pageCount: image.pageCount, displayOnly: image.displayOnly },
      channels: mode === 'colocalization'
        ? { a: { id: channelA.id, sourceLabel: channelA.label, label: channelALabel, sourceColor: channelA.sourceColor, bitDepth: channelA.bitDepth }, b: { id: channelB.id, sourceLabel: channelB.label, label: channelBLabel, sourceColor: channelB.sourceColor, bitDepth: channelB.bitDepth } }
        : intensityChannels.map(({ channel, setting }) => ({ id: channel.id, sourceLabel: channel.label, label: setting.label || channel.label, sourceColor: channel.sourceColor, bitDepth: channel.bitDepth, displayColor: setting.color })),
      parameters: { roi, backgroundRoi, backgroundMethod, background: mode === 'colocalization' ? background : Object.fromEntries(intensityChannels.map(({ channel }) => [channel.id, backgroundByChannel.get(channel.id) ?? { mean: 0, sd: 0 }])), thresholdMethod, manualThresholdPercent: { a: manualA, b: manualB }, displayColors: mode === 'colocalization' ? { a: displayColorA, b: displayColorB } : Object.fromEntries(intensityChannels.map(({ channel, setting }) => [channel.id, setting.color])), displayRanges: Object.fromEntries(channelSettings.map(setting => [setting.id, { min: setting.displayMin, max: setting.displayMax, preset: setting.displayPreset }])), displayBlackPointPercent: displayBlackPoint, displayBackgroundSuppression: { enabled: Boolean(suppressDisplayBackground && backgroundRoi), method: `background_roi_mean_plus_${DISPLAY_BACKGROUND_SD_MULTIPLIER}sd`, channels: Object.fromEntries(displayBackgroundByChannel) }, scaleBar: { shown: showScaleBar, lengthUm: scaleBarUm }, scanLine, lineChannels: { a: channelA.id, b: channelB.id }, lineWidthPx: lineWidth, gaussianSigmaPx: sigma, pixelSizeUm: pixelSize || null, comparison: 'strict >', costesSignificanceTest: false },
      results: mode === 'colocalization' ? { colocalization: analysis.coloc } : { intensities: analysis.intensities, lineProfile: analysis.profile },
      warnings: [...image.warnings, ...(image.displayOnly ? ['本结果由展示图风险确认后生成，仅供探索。'] : []), ...(analysis.coloc?.warnings ?? []), ...(mode === 'colocalization' ? ['共定位不等于分子相互作用。'] : [])],
    };
    saveText(`${image.fileName.replace(/\.[^.]+$/, '')}_${mode}_analysis.json`, JSON.stringify(payload, null, 2), 'application/json');
  };

  const exportRoiImage = async (format: RoiExportFormat) => {
    if (!image || !roi || !channelA || !channelB) { setError('请先使用“正方形裁剪”工具框选要导出的区域。'); return; }
    if (!channelConfirmed) { setError('请先确认通道名称和伪彩。'); return; }
    if (!isColoc && !intensityChannels.length) { setError('请至少勾选 1 个要显示和导出的通道。'); return; }
    if (showScaleBar && !(pixelSize > 0)) { setError('要显示比例尺，请先填写像素尺寸（µm/px）；也可以取消“导出显示比例尺”。'); return; }
    if (exportingRoi) return;
    setExportingRoi(format);
    try {
      setError('');
      const channels = isColoc
        ? [{ id: channelA.id, color: PSEUDOCOLORS[displayColorA].rgb, displayMin: channelASetting?.displayMin, displayMax: channelASetting?.displayMax, displayFloor: suppressDisplayBackground ? displayBackgroundByChannel.get(channelA.id)?.floor : undefined }, { id: channelB.id, color: PSEUDOCOLORS[displayColorB].rgb, displayMin: channelBSetting?.displayMin, displayMax: channelBSetting?.displayMax, displayFloor: suppressDisplayBackground ? displayBackgroundByChannel.get(channelB.id)?.floor : undefined }]
        : intensityChannels.map(({ channel, setting }) => ({ id: channel.id, color: PSEUDOCOLORS[setting.color].rgb, displayMin: setting.displayMin, displayMax: setting.displayMax, displayFloor: suppressDisplayBackground ? displayBackgroundByChannel.get(channel.id)?.floor : undefined }));
      const selectedIntensity = intensityChannels.find(({ channel }) => `channel:${channel.id}` === intensityExportTarget);
      const selectedIntensityIndex = intensityChannels.findIndex(({ channel }) => `channel:${channel.id}` === intensityExportTarget);
      const intensityJobs = intensityExportTarget === 'all'
        ? [{ view: 'overlay' as View, suffix: '00_Merge' }, ...intensityChannels.map(({ channel, setting }, index) => ({ view: `channel:${channel.id}` as View, suffix: `${String(index + 1).padStart(2, '0')}_${safeFilePart(setting.label || channel.label, `Channel_${index + 1}`)}` }))]
        : intensityExportTarget === 'merge'
          ? [{ view: 'overlay' as View, suffix: 'Merge' }]
          : [{ view: intensityExportTarget as View, suffix: `${String(Math.max(1, selectedIntensityIndex + 1)).padStart(2, '0')}_${safeFilePart(selectedIntensity?.setting.label || selectedIntensity?.channel.label || 'Channel')}` }];
      const colocSuffix = view === 'overlay' ? 'Merge' : view === 'a' ? `A_${safeFilePart(channelALabel, 'Channel_A')}` : view === 'b' ? `B_${safeFilePart(channelBLabel, 'Channel_B')}` : view === 'mask' ? 'Mask' : safeFilePart(view, 'Channel');
      const jobs = isColoc ? [{ view, suffix: colocSuffix }] : intensityJobs;
      const exportBounds = boundsFor(image.width, image.height, roi);
      const estimatedBatchRgbBytes = (exportBounds.x1 - exportBounds.x0) * (exportBounds.y1 - exportBounds.y0) * 3 * jobs.length;
      if (jobs.length > 1 && estimatedBatchRgbBytes > MAX_BATCH_RGB_BYTES) throw new Error('批量裁剪区域过大。为避免浏览器卡死，请缩小裁剪框，或改为分别导出单通道。');
      const extension = format === 'tiff' ? 'tif' : format;
      const mime = format === 'tiff' ? 'image/tiff' : format === 'jpg' ? 'image/jpeg' : 'image/png';
      const archiveEntries: Array<{ name: string; data: ArrayBuffer }> = [];
      let baseName = '';

      for (const job of jobs) {
        const rendered = renderRoiPseudocolor({
          image,
          channels,
          roi,
          view: job.view,
          blackPointPercent: displayBlackPoint,
          pixelSizeUm: showScaleBar ? pixelSize : null,
          scaleBarUm: showScaleBar ? scaleBarUm : null,
          mask: job.view === 'mask' && analysis?.coloc ? { channelAId: channelA.id, channelBId: channelB.id, thresholdA: analysis.coloc.thresholdA, thresholdB: analysis.coloc.thresholdB, backgroundA: background.a, backgroundB: background.b } : null,
        });
        if (showScaleBar && !rendered.scaleBar?.rendered) throw new Error(`${rendered.scaleBar?.reason ?? '比例尺无法显示。'}请增大裁剪框或缩短比例尺后再导出。`);
        if (!baseName) {
          const source = rendered.sourceRoi;
          baseName = `${safeFilePart(image.fileName.replace(/\.[^.]+$/, ''), 'image')}_ROI-x${source.x}-y${source.y}-${source.width}x${source.height}px`;
        }
        const data = format === 'tiff'
          ? await encodePseudocolorTiff(rendered)
          : await (await renderedRoiToBlob(rendered, format)).arrayBuffer();
        archiveEntries.push({ name: `${baseName}_${job.suffix}.${extension}`, data });
      }

      if (!isColoc && intensityExportTarget === 'all') {
        const archive = await createStoredZip(archiveEntries);
        saveBlob(`${baseName}_Merge+Channels_${format.toUpperCase()}.zip`, new Blob([archive], { type: 'application/zip' }));
      } else {
        saveBlob(archiveEntries[0].name, new Blob([archiveEntries[0].data], { type: mime }));
      }
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'ROI 图片导出失败。'); }
    finally { setExportingRoi(null); }
  };

  const roiText = roi
    ? isColoc
      ? `${Math.round(roi.width)} × ${Math.round(roi.height)} px${pixelSize ? ` / ${format(roi.width * pixelSize, 2)} × ${format(roi.height * pixelSize, 2)} µm` : ''}`
      : `边长 ${roiSideLabel(roi.width, pixelSize, roiSizeUnit)}`
    : '全图';
  const lineLength = scanLine ? Math.hypot(scanLine.x2 - scanLine.x1, scanLine.y2 - scanLine.y1) : 0;
  const allWarnings = [...(image?.warnings ?? []), ...(analysis?.coloc?.warnings ?? [])];
  const visibleWarnings = allWarnings.filter(warning => !warning.startsWith('已在浏览器本地直接读取 OIR') && !warning.startsWith('仅支持同目录不存在同名') && !warning.startsWith('当前直接读取模式已针对'));
  const intensityRows = intensityChannels.map(({ channel, setting }) => ({ channel, setting, stats: analysis?.intensities.find(result => result.id === channel.id)?.stats ?? null }));
  const primaryIntensity = analysis?.intensities[0]?.stats ?? null;
  const primaryIntensityLabel = intensityChannels[0]?.setting.label || intensityChannels[0]?.channel.label || '首个通道';
  const histogramPosition = (value: number) => histogram ? Math.min(100, Math.max(0, (value - histogram.axisMin) / Math.max(1e-12, histogram.axisMax - histogram.axisMin) * 100)) : 0;
  const roiUnitDigits = roiUnitPrecision(pixelSize, roiSizeUnit);
  const roiSideValue = roiSizeUnit === 'px'
    ? Math.round(roi?.width ?? roiTargetSidePx)
    : Number(roiSideInUnit(roi?.width ?? roiTargetSidePx, pixelSize, roiSizeUnit).toFixed(roiUnitDigits));
  const roiSideMin = roiSizeUnit === 'px' ? 1 : roiSideInUnit(1, pixelSize, roiSizeUnit);
  const roiSideMax = image ? roiSideInUnit(Math.min(image.width, image.height), pixelSize, roiSizeUnit) : 1;
  const roiSideStep = roiSideMin;
  const layoutReferenceCm = roi && pixelSize > 0 ? roi.width * pixelSize * layoutSizeRatio / 10000 : null;

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

          <div className={`field-group channel-manager ${channelConfirmed ? 'is-confirmed' : ''}`}>
            <p>02 · {channelConfirmed ? '通道已确认' : '确认通道'}</p>
            {image && channelConfirmed ? <button className="channel-confirm compact" onClick={() => setChannelConfirmed(false)}>{channelSettings.length} 个通道 · 修改</button> : <>
              {channelSettings.map(setting => <div className={`channel-setting-row ${displayChannelId === setting.id ? 'active' : ''}`} key={setting.id} onFocusCapture={() => setDisplayChannelId(setting.id)}>
                {isColoc ? <span className="channel-check" title={setting.id}><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[setting.color].css }} /></span> : <label className="channel-check" title={setting.enabled ? '取消该通道' : '选择该通道'}><input type="checkbox" checked={setting.enabled} disabled={!setting.enabled && enabledIntensityIds.length >= 8} onChange={event => { updateChannelSetting(setting.id, { enabled: event.target.checked }); if (!event.target.checked && (view === `channel:${setting.id}` || intensityExportTarget === `channel:${setting.id}`)) { setView('overlay'); setIntensityExportTarget('merge'); } }} /><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[setting.color].css }} /></label>}
                <input aria-label={`${setting.label} 自定义名称`} value={setting.label} onChange={event => updateChannelSetting(setting.id, { label: event.target.value })} />
                <select aria-label={`${setting.label} 伪彩`} value={setting.color} onChange={event => updateChannelSetting(setting.id, { color: event.target.value as Pseudocolor })}>{Object.entries(PSEUDOCOLORS).map(([value, color]) => <option key={value} value={value}>{color.label}</option>)}</select>
              </div>)}
              {image && <button className="channel-confirm" onClick={() => { setChannelConfirmed(true); setError(''); }}>确认通道</button>}
              {image && <small className="field-help">OIR 优先采用 Olympus 原配色。</small>}
            </>}
          </div>

          {channelConfirmed && <>
          {isColoc && <div className="field-group"><p>共定位通道</p><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorA].css }} />通道 A<select value={channelAId} onChange={event => setChannelAId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{channelSettings.find(setting => setting.id === channel.id)?.label || channel.label}</option>)}</select></label><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorB].css }} />通道 B<select value={channelBId} onChange={event => setChannelBId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{channelSettings.find(setting => setting.id === channel.id)?.label || channel.label}</option>)}</select></label></div>}

          {activeDisplaySetting && activeDisplayChannel && histogram && <div className="field-group display-window">
            <p>显示范围</p>
            <label className="wide-field">通道<select value={activeDisplaySetting.id} onChange={event => setDisplayChannelId(event.target.value)}>{channelSettings.map(setting => <option key={setting.id} value={setting.id}>{setting.label}</option>)}</select></label>
            <div className="display-histogram-control">
              <svg className="display-histogram" viewBox="0 0 100 32" preserveAspectRatio="none" aria-label={`${activeDisplaySetting.label} 强度直方图`}>
                <polygon points={histogram.points} />
                <line className="min-marker" x1={histogramPosition(activeDisplaySetting.displayMin)} x2={histogramPosition(activeDisplaySetting.displayMin)} y1="0" y2="32" />
                <line className="max-marker" x1={histogramPosition(activeDisplaySetting.displayMax)} x2={histogramPosition(activeDisplaySetting.displayMax)} y1="0" y2="32" />
              </svg>
              <input className="display-max-slider" type="range" aria-label={`${activeDisplaySetting.label} 显示上限 Max`} title="拖动调整红色 Max 线" min={histogram.axisMin} max={histogram.axisMax} step={activeDisplayChannel.integer ? 1 : Math.max((histogram.axisMax - histogram.axisMin) / 1000, Number.EPSILON)} value={activeDisplaySetting.displayMax} onChange={event => { const value = Number(event.target.value); if (value > activeDisplaySetting.displayMin) setManualDisplayValue(activeDisplaySetting.id, 'displayMax', value); }} />
            </div>
            <div className="display-presets"><button className={activeDisplaySetting.displayPreset === 'raw' ? 'selected' : ''} onClick={() => setChannelDisplayPreset(activeDisplaySetting.id, 'raw')}>原始</button><button className={activeDisplaySetting.displayPreset === 'auto' ? 'selected' : ''} onClick={() => setChannelDisplayPreset(activeDisplaySetting.id, 'auto')}>自动</button><button className={activeDisplaySetting.displayPreset === 'imagej' ? 'selected' : ''} onClick={() => setChannelDisplayPreset(activeDisplaySetting.id, 'imagej')}>ImageJ</button></div>
            <div className="display-values"><label>Min<input type="number" step={activeDisplayChannel.integer ? 1 : 'any'} value={Number(activeDisplaySetting.displayMin.toPrecision(7))} onChange={event => setManualDisplayValue(activeDisplaySetting.id, 'displayMin', Number(event.target.value))} /></label><label>Max<input type="number" step={activeDisplayChannel.integer ? 1 : 'any'} value={Number(activeDisplaySetting.displayMax.toPrecision(7))} onChange={event => setManualDisplayValue(activeDisplaySetting.id, 'displayMax', Number(event.target.value))} /></label></div>
            <label className="range-field"><span>黑场 {displayBlackPoint}%</span><input type="range" min="0" max="60" value={displayBlackPoint} onChange={event => setDisplayBlackPoint(Number(event.target.value))} /></label>
            <small className="field-help">拖动红线调整 Max；仅影响显示和导图。</small>
          </div>}

          <div className="field-group"><p>显示去杂色</p><label className="scale-toggle"><input type="checkbox" checked={suppressDisplayBackground} disabled={!image || !backgroundRoi} onChange={event => setSuppressDisplayBackground(event.target.checked)} /><span>背景 ROI 均值 + {DISPLAY_BACKGROUND_SD_MULTIPLIER} SD</span></label><small className="field-help">{backgroundRoi ? '仅改变显示和图片导出。' : '先在图中框选背景 ROI。'}</small></div>

          {!isColoc && <>
            <div className="field-group"><p>正方形裁剪与标尺</p>{image && <div className="crop-size-field"><span>实际边长</span><input aria-label="裁剪边长" type="number" min={roiSideMin} max={roiSideMax} step={roiSideStep} value={roiSideValue} onChange={event => setSquareRoiSide(Number(event.target.value))} /><select aria-label="裁剪边长单位" value={roiSizeUnit} onChange={event => setRoiSizeUnit(event.target.value as RoiSizeUnit)}><option value="px">px</option><option value="um" disabled={!pixelSize}>µm</option><option value="mm" disabled={!pixelSize}>mm</option><option value="cm" disabled={!pixelSize}>cm</option></select></div>}<label className="scale-toggle"><input type="checkbox" checked={squareSizeLocked} onChange={event => { setSquareSizeLocked(event.target.checked); setRoiResize(null); }} /><span>固定边长（仅移动）</span></label><small className="field-help">{squareSizeLocked ? '已固定；框内拖动可移动位置。' : '拖四角缩放，框内拖动移动；输入实际边长可精确设置。'}</small><label className="number-field"><span>排版比例</span><input aria-label="排版比例分母" type="number" min="1" max="100000" step="100" value={layoutSizeRatio} onChange={event => setLayoutSizeRatio(Math.min(100000, Math.max(1, Math.round(Number(event.target.value) || 1))))} /><span>倍</span></label><small className="field-help">实际 : 排版 = 1 : {layoutSizeRatio}{layoutReferenceCm !== null ? ` → ${format(layoutReferenceCm, 4)} cm` : ''}；仅换算，不改变 ROI、定量或导出像素。</small><label className="number-field"><span>像素尺寸</span><input type="number" min="0" step="0.001" value={pixelSize} onChange={event => { const value = Math.max(0, Number(event.target.value) || 0); setPixelSize(value); if (!value) setRoiSizeUnit('px'); }} /><span>µm/px</span></label><label className="scale-toggle"><input type="checkbox" checked={showScaleBar} onChange={event => setShowScaleBar(event.target.checked)} /><span>导出显示比例尺</span></label>{showScaleBar && <label className="number-field"><span>比例尺</span><input type="number" min="0.1" step="0.1" value={scaleBarUm} onChange={event => setScaleBarUm(Math.max(.1, Number(event.target.value) || .1))} /><span>µm</span></label>}</div>
            <div className="field-group"><p>线扫描通道（可选）</p><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorA].css }} />通道 A<select value={channelAId} onChange={event => setChannelAId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{channelSettings.find(setting => setting.id === channel.id)?.label || channel.label}</option>)}</select></label><label><span className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorB].css }} />通道 B<select value={channelBId} onChange={event => setChannelBId(event.target.value)} disabled={!image}>{image?.channels.map(channel => <option key={channel.id} value={channel.id}>{channelSettings.find(setting => setting.id === channel.id)?.label || channel.label}</option>)}</select></label></div>
          </>}

          {isColoc && <div className="field-group"><p>阈值</p><label className="wide-field">方法<select value={thresholdMethod} onChange={event => setThresholdMethod(event.target.value as ThresholdMethod)}><option value="costes">Costes 自动</option><option value="otsu">Otsu 自动</option><option value="manual">手动阈值</option><option value="none">零阈值</option></select></label>{thresholdMethod === 'manual' && <div className="range-pair"><label>A {manualA}%<input type="range" min="0" max="100" value={manualA} onChange={event => setManualA(Number(event.target.value))} /></label><label>B {manualB}%<input type="range" min="0" max="100" value={manualB} onChange={event => setManualB(Number(event.target.value))} /></label></div>}</div>}

          <div className="field-group"><p>{isColoc ? '背景与标尺' : '定量扣背景'}</p><label className="wide-field">方法<select value={backgroundMethod} onChange={event => setBackgroundMethod(event.target.value as BackgroundMethod)}><option value="none">不校正</option><option value="roi">背景 ROI 均值</option><option value="percentile">ROI 第 5 百分位</option></select></label>{isColoc && <><label className="number-field"><span>像素尺寸</span><input type="number" min="0" step="0.001" value={pixelSize} onChange={event => setPixelSize(Math.max(0, Number(event.target.value) || 0))} /><span>µm/px</span></label><label className="scale-toggle"><input type="checkbox" checked={showScaleBar} onChange={event => setShowScaleBar(event.target.checked)} /><span>导出比例尺</span></label>{showScaleBar && <label className="number-field"><span>比例尺</span><input type="number" min="0.1" step="0.1" value={scaleBarUm} onChange={event => setScaleBarUm(Math.max(.1, Number(event.target.value) || .1))} /><span>µm</span></label>}</>}<small className="field-help">{isColoc ? '背景用于计算，标尺用于导图。' : '用于数值计算，与显示去杂色分开。'}</small></div>
          {image?.displayOnly && <label className="risk-confirm"><input type="checkbox" checked={allowDisplayOnly} onChange={event => setAllowDisplayOnly(event.target.checked)} /><span><b>当前是展示图</b>仅在理解伪彩/合并 RGB 风险后进行探索性分析。</span></label>}
          </>}
        </aside>

        <div className="image-stage">
          <div className="stage-toolbar"><div className="view-switch"><button className={view === 'overlay' ? 'selected' : ''} onClick={() => { setView('overlay'); if (!isColoc) setIntensityExportTarget('merge'); }}>Merge</button>{isColoc ? <><button className={view === 'a' ? 'selected' : ''} onClick={() => setView('a')}>通道 A</button><button className={view === 'b' ? 'selected' : ''} onClick={() => setView('b')}>通道 B</button><button className={view === 'mask' ? 'selected' : ''} onClick={() => setView('mask')} disabled={!analysis?.coloc}>Mask</button></> : intensityChannels.map(({ channel, setting }) => <button key={channel.id} className={view === `channel:${channel.id}` ? 'selected' : ''} onClick={() => { setView(`channel:${channel.id}`); setIntensityExportTarget(`channel:${channel.id}`); }}><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[setting.color].css }} />{setting.label || channel.label}</button>)}</div><span>显示设置不影响定量</span></div>
          <div className={`canvas-area tool-${tool}`}>
            {!image && <div className="empty-canvas"><div className="scan-grid" /><span className="crosshair" aria-hidden="true" /><p>等待图像</p><small>可直接选择 FV3000 .oir 原始文件</small></div>}
            {image && <div className="canvas-stack" style={{ aspectRatio: `${image.width}/${image.height}`, maxWidth: `${Math.min(previewSize.width, MAX_PREVIEW_HEIGHT * image.width / image.height)}px` }}><canvas ref={imageCanvas} /><canvas ref={overlayCanvas} aria-label={`在图像上绘制${tool === 'roi' ? '分析 ROI' : tool === 'background' ? '背景 ROI' : '线扫描'}`} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={event => { setDragStart(null); setDraft(null); setRoiMoveOffset(null); setRoiResize(null); event.currentTarget.style.cursor = ''; }} /></div>}
          </div>
          <div className="stage-tools" aria-label="绘图工具"><button className={tool === 'roi' ? 'selected' : ''} onClick={() => setTool('roi')}><b>□</b>{isColoc ? '分析 ROI' : '正方形裁剪'}</button><button className={tool === 'background' ? 'selected' : ''} onClick={() => setTool('background')}><b>▧</b>背景 ROI</button>{!isColoc && <button className={tool === 'line' ? 'selected' : ''} onClick={() => setTool('line')}><b>╱</b>线扫描</button>}<span className="tool-spacer" /><button onClick={() => setRoi(null)}>使用全图</button><button onClick={() => { setRoi(null); setBackgroundRoi(null); setScanLine(null); setSuppressDisplayBackground(false); }}>清除标注</button></div>
          <div className="stage-foot"><span>{isColoc ? 'ROI' : '正方形裁剪区'}：{roiText}{!isColoc && layoutReferenceCm !== null ? ` ｜ 排版 1:${layoutSizeRatio} → ${format(layoutReferenceCm, 4)} cm` : ''}</span>{!isColoc && <span>线长：{scanLine ? `${format(lineLength, 1)} px${pixelSize ? ` / ${format(lineLength * pixelSize, 2)} µm` : ''}` : '—'}</span>}<span>{isColoc ? `BG A/B：${format(background.a, 2)} / ${format(background.b, 2)}` : `定量背景：${backgroundLabels[backgroundMethod]}`}</span></div>
          <div className="roi-export-panel"><div><strong>{roi ? isColoc ? `ROI ${Math.round(roi.width)} × ${Math.round(roi.height)} px` : `裁剪边长 ${roiSideLabel(roi.width, pixelSize, roiSizeUnit)}` : `先框选${isColoc ? '分析 ROI' : '正方形'}`}</strong><small>{!isColoc && intensityExportTarget === 'all' ? `批量：Merge + ${intensityChannels.length} 个已勾选单通道，装入一个 ZIP。` : '图片为伪彩；定量用 CSV / JSON。'}{showScaleBar ? ' 比例尺会写入图片。' : ''}</small></div><div className="roi-export-controls">{!isColoc && <select aria-label="导出内容" value={intensityExportTarget} disabled={!image || Boolean(exportingRoi)} onChange={event => { const target = event.target.value as IntensityExportTarget; setIntensityExportTarget(target); setView(target.startsWith('channel:') ? target as `channel:${string}` : 'overlay'); }}><option value="merge">Merge（已勾选通道）</option>{intensityChannels.map(({ channel, setting }) => <option key={channel.id} value={`channel:${channel.id}`}>{setting.label || channel.label}</option>)}<option value="all">全部：Merge + 单通道（ZIP）</option></select>}<div className="export-actions"><button disabled={!roi || !channelConfirmed || Boolean(exportingRoi)} onClick={() => { void exportRoiImage('png'); }}>{exportingRoi === 'png' ? '处理中…' : 'PNG'}</button><button disabled={!roi || !channelConfirmed || Boolean(exportingRoi)} onClick={() => { void exportRoiImage('jpg'); }}>{exportingRoi === 'jpg' ? '处理中…' : 'JPG'}</button><button disabled={!roi || !channelConfirmed || Boolean(exportingRoi)} onClick={() => { void exportRoiImage('tiff'); }}>{exportingRoi === 'tiff' ? '处理中…' : 'TIFF'}</button></div></div></div>
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
            <div className="quick-stats"><span><small>ROI 像素</small><b>{primaryIntensity ? primaryIntensity.pixels.toLocaleString() : '—'}</b></span><span><small>所选通道</small><b>{enabledIntensityIds.length}</b></span><span><small>正方形边长</small><b>{roi ? roiSideLabel(roi.width, pixelSize, roiSizeUnit) : '全图'}</b></span></div>
          </>}
          {error && <p className="error-message" role="alert">{error}</p>}
          <button className="analyze-button" onClick={runAnalysis} disabled={!image || !channelConfirmed || busy || loading || Boolean(image?.displayOnly && !allowDisplayOnly)}>{busy ? '正在计算…' : image && !channelConfirmed ? '先确认通道' : image ? `运行${isColoc ? '共定位' : '强度'}分析` : '载入图像后分析'} <span>→</span></button>
          <p className="run-note">{isColoc ? `${thresholdLabels[thresholdMethod]} · ` : ''}{backgroundLabels[backgroundMethod]}</p>
        </aside>
      </section>

      <section className="detail-section" id="results">
        <div className="section-title"><h2>{isColoc ? '共定位结果' : '强度结果'}</h2>{analysis && <div className="export-actions"><button disabled={!channelConfirmed} onClick={exportRows}>指标 CSV</button><button disabled={!channelConfirmed} onClick={exportJson}>完整 JSON</button>{analysis.profile && <button disabled={!channelConfirmed} onClick={exportProfile}>线扫 CSV</button>}</div>}</div>

        {isColoc && <div className="result-grid">
          <article className="result-card scatter-card"><header><div><span>共定位散点图</span><small>黄线：阈值 · 洋红线：Costes 回归</small></div><b>{analysis?.coloc ? thresholdLabels[thresholdMethod] : '等待分析'}</b></header><canvas ref={scatterCanvas} aria-label="通道 A 与 B 的强度散点图" /><div className="legend"><span><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorA].css }} />X：{channelALabel}</span><span><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorB].css }} />Y：{channelBLabel}</span></div></article>
          <article className="result-card coefficients"><header><div><span>共定位指标</span><small>相关与共现分开报告</small></div></header><dl><div><dt>Pearson（无阈值）</dt><dd>{analysis?.coloc ? format(analysis.coloc.pearson) : '—'}</dd></div><div><dt>Pearson（阈值下）</dt><dd>{analysis?.coloc ? format(analysis.coloc.pearsonBelow) : '—'}</dd></div><div><dt>Pearson（阈值上）</dt><dd>{analysis?.coloc ? format(analysis.coloc.pearsonAbove) : '—'}</dd></div><div><dt>Manders M1 / M2</dt><dd>{analysis?.coloc ? `${format(analysis.coloc.m1)} / ${format(analysis.coloc.m2)}` : '—'}</dd></div><div><dt>Manders tM1 / tM2</dt><dd>{analysis?.coloc ? `${format(analysis.coloc.tm1)} / ${format(analysis.coloc.tm2)}` : '—'}</dd></div><div><dt>Manders overlap</dt><dd>{analysis?.coloc ? format(analysis.coloc.overlap) : '—'}</dd></div><div><dt>Li ICQ</dt><dd>{analysis?.coloc ? format(analysis.coloc.icq) : '—'}</dd></div><div><dt>双阳性像素</dt><dd>{analysis?.coloc ? `${analysis.coloc.colocPixels.toLocaleString()} (${format(analysis.coloc.colocAreaPct, 2)}%)` : '—'}</dd></div></dl></article>
        </div>}

        {!isColoc && <>
          <article className="result-card intensity-card"><header><div><span>正方形 ROI 荧光强度</span><small>所有已勾选通道分别计算；RawIntDen、背景校正与 CTCF 基于原始像素值</small></div><b>{roi ? `ROI ${roiText}` : '全图'}</b></header><div className="table-wrap"><table><thead><tr><th>通道</th><th>像素数</th><th>Mean</th><th>Median</th><th>SD</th><th>Min–Max</th><th>RawIntDen</th><th>Background</th><th>Corrected Mean</th><th>CTCF</th><th>饱和</th></tr></thead><tbody>{intensityRows.map(({ channel, setting, stats }) => <tr key={channel.id}><td><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[setting.color].css }} />{setting.label || channel.label}</td><td>{stats ? stats.pixels.toLocaleString() : '—'}</td><td>{stats ? format(stats.mean, 2) : '—'}</td><td>{stats ? format(stats.median, 2) : '—'}</td><td>{stats ? format(stats.sd, 2) : '—'}</td><td>{stats ? `${format(stats.min, 1)}–${format(stats.max, 1)}` : '—'}</td><td>{stats ? format(stats.sum, 1) : '—'}</td><td>{stats ? format(stats.backgroundMean, 2) : '—'}</td><td>{stats ? format(stats.correctedMean, 2) : '—'}</td><td>{stats ? format(stats.ctcf, 1) : '—'}</td><td>{stats ? `${format(stats.saturationPct, 2)}%` : '—'}</td></tr>)}</tbody></table></div></article>
          <article className="result-card profile-card"><header><div><span>荧光线扫描</span><small>沿线每 1 px 双线性采样；线宽内取 mean ± sample SD</small></div><div className="profile-controls"><label>线宽<input type="number" min="1" max="101" value={lineWidth} onChange={event => setLineWidth(Math.max(1, Math.min(101, Number(event.target.value) || 1)))} />px</label><label>Gaussian σ<input type="number" min="0" max="20" step="0.5" value={sigma} onChange={event => setSigma(Math.max(0, Math.min(20, Number(event.target.value) || 0)))} />px</label></div></header>{!scanLine && <p className="profile-empty">选择“线扫描”工具，在图像上拖出一条线；然后运行分析。</p>}<canvas ref={profileCanvas} aria-label="通道 A 与 B 的线扫描曲线" /><div className="legend"><span><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorA].css }} />通道 A · {channelALabel}</span><span><i className="dot" style={{ backgroundColor: PSEUDOCOLORS[displayColorB].css }} />通道 B · {channelBLabel}</span><span>横轴：{pixelSize ? `µm（${pixelSize} µm/px）` : 'pixel（未标定）'}</span><span>{sigma > 0 ? `显示 Gaussian σ=${sigma}px；CSV 保留原始曲线` : '未平滑'}</span></div></article>
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
