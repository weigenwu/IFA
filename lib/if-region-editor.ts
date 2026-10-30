import type { Point } from './if-count';

const finitePoint = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y);
const samePoint = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-8 && Math.abs(a.y - b.y) < 1e-8;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function checkBounds(points: Point[], width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || points.some(p => !finitePoint(p))) {
    throw new Error('区域坐标或图像尺寸无效。');
  }
}

/** Start at the rightmost point and proceed clockwise in image coordinates. */
export function ellipseControls(start: Point, end: Point): Point[] {
  if (!finitePoint(start) || !finitePoint(end)) throw new Error('区域坐标无效。');
  const rx = Math.abs(end.x - start.x) / 2, ry = Math.abs(end.y - start.y) / 2;
  if (!rx || !ry) return [];
  const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
  return Array.from({ length: 16 }, (_, i) => ({ x: cx + rx * Math.cos(i * Math.PI / 8), y: cy + ry * Math.sin(i * Math.PI / 8) }));
}

/** Periodic monotone cubic interpolation avoids overshooting the image edges. */
export function smoothContour(controls: Point[], width: number, height: number): Point[] {
  checkBounds(controls, width, height);
  const points = controls.map(p => ({ x: clamp(p.x, 0, width), y: clamp(p.y, 0, height) }))
    .filter((p, i, all) => !i || !samePoint(p, all[i - 1]));
  if (points.length > 1 && samePoint(points[0], points[points.length - 1])) points.pop();
  if (points.length < 3) return points;
  const slope = (previous: number, next: number) => previous * next > 0 ? 2 * previous * next / (previous + next) : 0;
  const tangents = points.map((p, i) => {
    const before = points[(i + points.length - 1) % points.length], after = points[(i + 1) % points.length];
    return { x: slope(p.x - before.x, after.x - p.x), y: slope(p.y - before.y, after.y - p.y) };
  });
  const output: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    for (let step = 0; step < 8; step++) {
      const t = step / 8, t2 = t * t, t3 = t2 * t;
      const coordinate = (key: 'x' | 'y', limit: number) => clamp((2 * t3 - 3 * t2 + 1) * points[i][key]
        + (t3 - 2 * t2 + t) * tangents[i][key] + (-2 * t3 + 3 * t2) * points[j][key]
        + (t3 - t2) * tangents[j][key], 0, limit);
      const p = { x: coordinate('x', width), y: coordinate('y', height) };
      if (!output.length || !samePoint(p, output[output.length - 1])) output.push(p);
    }
  }
  if (output.length > 1 && samePoint(output[0], output[output.length - 1])) output.pop();
  return output;
}

/** Apply a single bounded translation so dragging against an edge keeps the shape. */
export function moveContour(controls: Point[], dx: number, dy: number, width: number, height: number): Point[] {
  checkBounds(controls, width, height);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('区域移动距离无效。');
  if (!controls.length) return [];
  const xs = controls.map(p => p.x), ys = controls.map(p => p.y);
  const x = clamp(dx, -Math.min(...xs), width - Math.max(...xs));
  const y = clamp(dy, -Math.min(...ys), height - Math.max(...ys));
  return controls.map(p => ({ x: p.x + x, y: p.y + y }));
}

export function contourBounds(points: Point[]) {
  return points.reduce((box, p) => ({ left: Math.min(box.left, p.x), top: Math.min(box.top, p.y),
    right: Math.max(box.right, p.x), bottom: Math.max(box.bottom, p.y) }),
  { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
}

/** Corners are TL, TR, BR, BL; the opposite corner remains anchored. */
export function resizeContour(controls: Point[], corner: 0 | 1 | 2 | 3, target: Point, width: number, height: number): Point[] {
  checkBounds([...controls, target], width, height);
  if (!Number.isInteger(corner) || corner < 0 || corner > 3) throw new Error('区域缩放位置无效。');
  const box = contourBounds(controls), w = box.right - box.left, h = box.bottom - box.top;
  if (!controls.length || w <= 0 || h <= 0) return controls.map(p => ({ ...p }));
  const leftSide = corner === 0 || corner === 3, topSide = corner < 2;
  const x = clamp(target.x, leftSide ? 0 : box.left + 1, leftSide ? box.right - 1 : width);
  const y = clamp(target.y, topSide ? 0 : box.top + 1, topSide ? box.bottom - 1 : height);
  const left = leftSide ? x : box.left, right = leftSide ? box.right : x;
  const top = topSide ? y : box.top, bottom = topSide ? box.bottom : y;
  return controls.map(p => ({ x: left + (p.x - box.left) / w * (right - left), y: top + (p.y - box.top) / h * (bottom - top) }));
}
