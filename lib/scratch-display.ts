import type { ScratchBoundary } from './migration';

export type ScratchLineType = 'contour' | 'straight';

/** Display-only edges; measurements always use the original contour. */
export function scratchDisplayEdges(boundaries: ScratchBoundary[], type: ScratchLineType, width: number): ScratchBoundary[] {
  if (type !== 'straight' || boundaries.length < 2 || !Number.isFinite(width) || width <= 0) return boundaries;
  if (boundaries.some((point, i) =>
    ![point.y, point.left, point.right].every(Number.isFinite) || point.y < 0 ||
    point.left < 0 || point.left > point.right || point.right > width ||
    (i > 0 && point.y <= boundaries[i - 1].y))) return boundaries;

  const firstY = boundaries[0].y, lastY = boundaries[boundaries.length - 1].y, height = lastY - firstY;
  const fits = (['left', 'right'] as const).map(side => {
    let mean = 0, moment = 0;
    for (let i = 1; i < boundaries.length; i++) {
      const before = boundaries[i - 1], after = boundaries[i];
      const start = (before.y - firstY) / height, end = (after.y - firstY) / height, span = end - start;
      const a = before[side] / width, b = after[side] / width;
      // Exact integrals of x(t) and t*x(t) over each linear segment prevent
      // dense manual tracing from giving a short section extra weight.
      mean += span * (a + b) / 2;
      moment += span * ((2 * start + end) * a + (start + 2 * end) * b) / 6;
    }
    const slope = 12 * (moment - mean / 2);
    return [mean - slope / 2, mean + slope / 2].map(x => Math.max(0, Math.min(1, x)) * width);
  });
  return [firstY, lastY].map((y, i) => {
    let left = fits[0][i], right = fits[1][i];
    if (left > right) left = right = left / 2 + right / 2;
    return { y, left, right };
  });
}
