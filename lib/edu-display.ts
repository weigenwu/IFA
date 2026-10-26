import type { LoadedImage } from './image';

export type WhiteRulerOverlay = {
  indices: Uint32Array;
  values: Uint8Array;
  bounds: { x: number; y: number; width: number; height: number };
  sourceRgb: string;
};
type RulerImage = Pick<LoadedImage, 'width' | 'height' | 'channels' | 'sourceFiles'>;
type Component = { pixels: Uint32Array; left: number; top: number; right: number; bottom: number; bright: boolean; clipped: boolean };

function findInRgb(image: RulerImage, channels: RulerImage['channels'], sourceRgb: string): WhiteRulerOverlay | null | 'ambiguous' {
  const { width, height } = image;
  if (channels.some(channel => channel.data.length !== width * height || !Number.isFinite(channel.maxValue) || channel.maxValue <= 0)) return null;
  const rw = Math.min(width, Math.max(128, Math.ceil(width * 0.08))), rh = Math.min(height, Math.max(48, Math.ceil(height * 0.04)));
  const x0 = width - rw, y0 = height - rh, mask = new Uint8Array(rw * rh), values = new Uint8Array(mask.length);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const at = (y + y0) * width + x + x0, local = y * rw + x;
    const rgb = channels.map(channel => Number(channel.data[at]) / channel.maxValue * 255);
    if (rgb.some(value => !Number.isFinite(value) || value < 0 || value > 255)) continue;
    const min = Math.min(...rgb), max = Math.max(...rgb);
    if (min < 16 || max - min > 2) continue;
    mask[local] = 1; values[local] = Math.round((rgb[0] + rgb[1] + rgb[2]) / 3);
  }
  const components: Component[] = [], queue = new Uint32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    let size = 1; queue[0] = start; mask[start] = 0;
    let left = width, top = height, right = -1, bottom = -1, bright = false, clipped = false;
    for (let head = 0; head < size; head++) {
      const at = queue[head], x = at % rw, y = Math.floor(at / rw);
      left = Math.min(left, x + x0); right = Math.max(right, x + x0); top = Math.min(top, y + y0); bottom = Math.max(bottom, y + y0);
      bright ||= values[at] >= 192;
      clipped ||= (x === 0 && x0 > 0) || (y === 0 && y0 > 0);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(rh - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(rw - 1, x + 1); xx++) {
        const next = yy * rw + xx;
        if (mask[next]) { mask[next] = 0; queue[size++] = next; }
      }
    }
    components.push({ pixels: queue.slice(0, size), left, top, right, bottom, bright, clipped });
  }
  const bars = components.filter(c => {
    const w = c.right - c.left + 1, h = c.bottom - c.top + 1;
    return !c.clipped && c.bright && w >= 24 && w / h >= 6 && c.pixels.length / (w * h) >= 0.8
      && width - 1 - c.right <= Math.max(8, width * 0.02) && height - 1 - c.bottom <= Math.max(8, height * 0.02);
  });
  if (bars.length > 1) return 'ambiguous';
  if (!bars.length) return null;
  const bar = bars[0], barWidth = bar.right - bar.left + 1, barHeight = bar.bottom - bar.top + 1, pad = Math.max(4, barWidth * 0.1);
  const selected = components.filter(c => {
    const w = c.right - c.left + 1, h = c.bottom - c.top + 1;
    // Keep sparse glyphs or narrow strokes, not dense neutral cell-sized blobs.
    const textLike = Math.min(w, h) <= Math.max(3, barHeight) || c.pixels.length / (w * h) <= 0.6;
    return c.bright && !c.clipped && c.left >= bar.left - pad && c.right <= bar.right + pad
      && c.top >= bar.top - Math.max(48, barWidth * 0.5) && c.bottom <= bar.bottom + 2 && (c === bar || textLike);
  });
  const pixels = selected.flatMap(c => Array.from(c.pixels)).sort((a, b) => a - b);
  const left = Math.min(...selected.map(c => c.left)), top = Math.min(...selected.map(c => c.top));
  const right = Math.max(...selected.map(c => c.right)), bottom = Math.max(...selected.map(c => c.bottom));
  return {
    indices: Uint32Array.from(pixels, at => (Math.floor(at / rw) + y0) * width + at % rw + x0),
    values: Uint8Array.from(pixels, at => values[at]),
    bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, sourceRgb,
  };
}

/** Detect only a conservative annotation mask in a single original RGB triplet. */
export function findWhiteRuler(image: RulerImage): WhiteRulerOverlay | null {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 0xffffffff) return null;
  const groups = new Map<string, { channels: RulerImage['channels']; source: number }>();
  for (const channel of image.channels) {
    const match = /^(?:file-([1-9]\d*)-)?(red|green|blue)$/.exec(channel.id);
    if (!match || (!match[1] && image.sourceFiles.length !== 1)) continue;
    const source = match[1] ? Number(match[1]) - 1 : 0;
    if (!Number.isSafeInteger(source) || !image.sourceFiles[source]) continue;
    const key = match[1] ? `file-${match[1]}` : 'rgb', group = groups.get(key) ?? { channels: [], source };
    group.channels.push(channel); groups.set(key, group);
  }
  let found: WhiteRulerOverlay | null = null;
  for (const group of groups.values()) {
    if (group.channels.length !== 3 || new Set(group.channels.map(channel => channel.id.replace(/^file-\d+-/, ''))).size !== 3) continue;
    const candidate = findInRgb(image, group.channels, image.sourceFiles[group.source]);
    if (candidate === 'ambiguous') return null;
    if (!candidate) continue;
    if (found && (candidate.indices.length !== found.indices.length || candidate.indices.some((at, i) => at !== found!.indices[i] || candidate.values[i] !== found!.values[i]))) return null;
    found ??= candidate;
  }
  return found;
}

/** Paint only detected original annotation pixels onto a derived RGBA display. */
export function restoreWhiteRuler(rgba: Uint8ClampedArray, ruler: WhiteRulerOverlay | null): void {
  if (!ruler) return;
  if (rgba.length % 4 || ruler.indices.length !== ruler.values.length || ruler.indices.some(at => at >= rgba.length / 4)) throw new Error('标尺像素与输出图像尺寸不一致。');
  for (let i = 0; i < ruler.indices.length; i++) {
    const at = ruler.indices[i] * 4;
    rgba[at] = rgba[at + 1] = rgba[at + 2] = ruler.values[i]; rgba[at + 3] = 255;
  }
}
