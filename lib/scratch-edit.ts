import type { ScratchBoundary } from './migration';

export type ScratchSide = 'left' | 'right';
export type TracePoint = { x: number; y: number };

function validate(boundaries: ScratchBoundary[], side: ScratchSide, width: number) {
  if (side !== 'left' && side !== 'right') throw new Error('请选择左边界或右边界。');
  if (!Number.isFinite(width) || width <= 0) throw new Error('图像宽度必须为正数。');
  if (boundaries.length < 2) throw new Error('至少需要两行划痕边界。');
  boundaries.forEach((p, i) => {
    if (![p.y, p.left, p.right].every(Number.isFinite) || p.y < 0 || p.left < 0 || p.right > width || p.left > p.right) throw new Error('划痕边界无效或超出图像范围。');
    if (i && p.y <= boundaries[i - 1].y) throw new Error('边界行的 Y 坐标必须严格递增。');
  });
}

function setSide(boundary: ScratchBoundary, side: ScratchSide, x: number, width: number): ScratchBoundary {
  return { ...boundary, [side]: side === 'left' ? Math.max(0, Math.min(boundary.right, x)) : Math.max(boundary.left, Math.min(width, x)) };
}

/** Shift the existing contour locally; retain its small-scale variations. */
export function moveScratchBoundary(boundaries: ScratchBoundary[], side: ScratchSide, centerY: number, deltaX: number, radiusPx: number, width: number): ScratchBoundary[] {
  validate(boundaries, side, width);
  if (![centerY, deltaX, radiusPx].every(Number.isFinite) || radiusPx <= 0) throw new Error('拖动位置、位移和范围必须为有限数值，且范围必须大于零。');
  const start = Math.max(boundaries[0].y, centerY - radiusPx), end = Math.min(boundaries[boundaries.length - 1].y, centerY + radiusPx);
  if (deltaX === 0 || start >= end) return boundaries.map(boundary => ({ ...boundary }));
  const ys = new Set(boundaries.map(boundary => boundary.y)), steps = Math.ceil((end - start) / 2);
  ys.add(start); ys.add(end);
  if (centerY >= start && centerY <= end) ys.add(centerY);
  for (let i = 1; i < steps; i++) ys.add(start + (end - start) * i / steps);
  return [...ys].sort((a, b) => a - b).map(y => {
    const boundary = boundaryAt(boundaries, y), distance = Math.abs(y - centerY);
    if (distance >= radiusPx) return boundary;
    const weight = (1 + Math.cos(Math.PI * distance / radiusPx)) / 2;
    return setSide(boundary, side, boundary[side] + deltaX * weight, width);
  });
}

function boundaryAt(boundaries: ScratchBoundary[], y: number): ScratchBoundary {
  let low = 0, high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (boundaries[middle].y < y) low = middle + 1; else high = middle;
  }
  const after = boundaries[low];
  if (after.y === y) return { ...after };
  const before = boundaries[low - 1], fraction = (y - before.y) / (after.y - before.y);
  return { y, left: before.left + fraction * (after.left - before.left), right: before.right + fraction * (after.right - before.right) };
}

/** Replace only this pen segment, retaining all existing samples outside it. */
export function traceScratchSegment(boundaries: ScratchBoundary[], side: ScratchSide, from: TracePoint, to: TracePoint, width: number): ScratchBoundary[] {
  validate(boundaries, side, width);
  if (![from.x, from.y, to.x, to.y, to.y - from.y].every(Number.isFinite)) throw new Error('手绘坐标必须为有限数值。');
  const low = from.y <= to.y ? from : to, high = from.y <= to.y ? to : from;
  const start = Math.max(boundaries[0].y, Math.min(from.y, to.y));
  const end = Math.min(boundaries[boundaries.length - 1].y, Math.max(from.y, to.y));
  if (start > end) return boundaries.map(boundary => ({ ...boundary }));
  const ys = new Set(boundaries.map(boundary => boundary.y));
  // Preserve original samples as well as adding a <= 2 px sampling grid.
  const steps = Math.ceil((end - start) / 2);
  ys.add(start); ys.add(end);
  for (let i = 1; i < steps; i++) ys.add(start + (end - start) * i / steps);
  return [...ys].sort((a, b) => a - b).map(y => {
    const boundary = boundaryAt(boundaries, y);
    if (y < start || y > end) return boundary;
    const fraction = low.y === high.y ? 1 : (y - low.y) / (high.y - low.y);
    const x = (1 - fraction) * low.x + fraction * high.x;
    return setSide(boundary, side, x, width);
  });
}
