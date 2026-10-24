import assert from 'node:assert/strict';
import test from 'node:test';
import { moveScratchBoundary, traceScratchSegment } from '../lib/scratch-edit.ts';
import { measureScratch, type ScratchBoundary } from '../lib/migration.ts';

const jagged: ScratchBoundary[] = [20, 25, 18, 27, 19, 25, 20].map((left, i) => ({ y: i * 10, left, right: [80, 82, 74, 86, 78, 83, 80][i] }));
function assertGeometry(boundaries: ScratchBoundary[], width: number) {
  boundaries.forEach((p, i) => {
    assert.ok([p.y, p.left, p.right].every(Number.isFinite));
    assert.ok(p.left >= 0 && p.left <= p.right && p.right <= width);
    if (i) assert.ok(p.y > boundaries[i - 1].y);
  });
}

test('local drag retains jagged details, leaves the other side and out-of-range points unchanged, and does not mutate input', () => {
  const raw = structuredClone(jagged), result = moveScratchBoundary(jagged, 'left', 30, 10, 25, 100);
  const at = (y: number) => result.find(p => p.y === y)!;
  assert.equal(at(30).left, 37);
  assert.deepEqual(at(0), jagged[0]); assert.deepEqual(at(60), jagged[6]);
  for (const point of jagged) assert.equal(at(point.y).right, point.right);
  assert.equal(at(5).right, 81); assert.equal(at(55).right, 81.5);
  // The original small valley survives; replacing the neighborhood by two
  // straight segments would erase it.
  assert.ok(at(20).left < at(10).left);
  assert.ok(at(40).left < at(50).left);
  assert.ok(at(10).left > jagged[1].left && at(10).left - jagged[1].left < 2);
  const affected = result.filter(p => p.y >= 5 && p.y <= 55);
  affected.forEach((p, i) => { if (i) assert.ok(p.y - affected[i - 1].y <= 2); });
  assertGeometry(result, 100); assert.deepEqual(jagged, raw);
});

test('local drag clamps the selected side without crossing or shifting the opposite side', () => {
  const left = moveScratchBoundary(jagged, 'left', 30, 1000, 25, 100);
  assert.equal(left.find(p => p.y === 30)!.left, jagged[3].right);
  for (const point of jagged) assert.equal(left.find(p => p.y === point.y)!.right, point.right);
  const right = moveScratchBoundary(jagged, 'right', 30, -1000, 25, 100);
  assert.equal(right.find(p => p.y === 30)!.right, jagged[3].left);
  for (const point of jagged) assert.equal(right.find(p => p.y === point.y)!.left, point.left);
  assert.equal(moveScratchBoundary(jagged, 'right', 30, 1000, 25, 100).find(p => p.y === 30)!.right, 100);
  assert.equal(moveScratchBoundary(jagged, 'left', 30, -1000, 25, 100).find(p => p.y === 30)!.left, 0);
  assertGeometry(left, 100); assertGeometry(right, 100);
  assert.deepEqual(moveScratchBoundary(jagged, 'left', 30, 0, 25, 100), jagged);
});

test('a one-pixel brush between original samples moves the interpolated contour and preserves the outside vertices', () => {
  const result = moveScratchBoundary(jagged, 'left', 15, 10, 1, 100);
  assert.deepEqual(result.find(p => p.y === 15), { y: 15, left: 31.5, right: 78 });
  assert.deepEqual(result.filter(p => p.y < 14 || p.y > 16), jagged);
  assert.deepEqual(result.find(p => p.y === 14), { y: 14, left: 22.2, right: 78.8 });
  assert.deepEqual(result.find(p => p.y === 16), { y: 16, left: 20.8, right: 77.2 });
  assert.deepEqual(moveScratchBoundary(jagged, 'left', 15, 0, 1, 100), jagged);
  assertGeometry(result, 100);
});

test('pen replaces only the covered segment, inserts dense samples, and preserves the opposite piecewise curve', () => {
  const raw = structuredClone(jagged), result = traceScratchSegment(jagged, 'left', { x: 32, y: 13 }, { x: 45, y: 27 }, 100);
  for (const point of jagged) {
    const found = result.find(p => p.y === point.y)!;
    assert.equal(found.right, point.right);
    if (point.y < 13 || point.y > 27) assert.deepEqual(found, point);
  }
  const segment = result.filter(p => p.y >= 13 && p.y <= 27);
  assert.equal(segment[0].left, 32); assert.equal(segment.at(-1)!.left, 45);
  assert.equal(segment[0].right, 79.6);
  assert.equal(segment.at(-1)!.right, 82.4);
  segment.forEach((p, i) => { if (i) assert.ok(p.y - segment[i - 1].y <= 2); });
  assertGeometry(result, 100); assert.deepEqual(jagged, raw);
});

test('reverse strokes agree and backtracking replaces only the small revisited section', () => {
  const forward = traceScratchSegment(jagged, 'left', { x: 32, y: 13 }, { x: 45, y: 27 }, 100);
  const reverse = traceScratchSegment(jagged, 'left', { x: 45, y: 27 }, { x: 32, y: 13 }, 100);
  assert.deepEqual(reverse, forward);
  const back = traceScratchSegment(forward, 'left', { x: 45, y: 27 }, { x: 21, y: 21 }, 100);
  for (const point of forward) if (point.y < 21 || point.y > 27) assert.deepEqual(back.find(p => p.y === point.y), point);
  assert.equal(back.find(p => p.y === 21)!.left, 21);
  assert.equal(back.find(p => p.y === 23)!.left, 29);
  assert.deepEqual(back.map(p => p.y), forward.map(p => p.y));
  assertGeometry(back, 100);
});

test('horizontal pen motion uses its latest X, clips to the ROI and cannot cross the other boundary', () => {
  const horizontal = traceScratchSegment(jagged, 'right', { x: 82, y: 15 }, { x: 50, y: 15 }, 100);
  const inserted = horizontal.find(p => p.y === 15)!;
  assert.equal(inserted.right, 50); assert.equal(inserted.left, 21.5);
  assert.equal(horizontal.length, jagged.length + 1);
  assert.deepEqual(horizontal.filter(p => p.y !== 15), jagged);
  const crossing = traceScratchSegment(jagged, 'right', { x: -20, y: 20 }, { x: -20, y: 40 }, 100);
  assert.ok(crossing.filter(p => p.y >= 20 && p.y <= 40).every(p => p.right === p.left));
  const clipped = traceScratchSegment(jagged, 'left', { x: 10, y: -10 }, { x: 30, y: 10 }, 100);
  assert.equal(clipped[0].y, 0); assert.equal(clipped[0].left, 20);
  assert.equal(clipped.at(-1)!.y, 60);
  assert.deepEqual(traceScratchSegment(jagged, 'left', { x: 10, y: -20 }, { x: 20, y: -10 }, 100), jagged);
  assertGeometry(horizontal, 100); assertGeometry(crossing, 100); assertGeometry(clipped, 100);
});

test('area is integrated from the actual edited samples, including their connecting segments', () => {
  const input = [0, 20, 40, 60].map(y => ({ y, left: 10, right: 90 }));
  const edited = traceScratchSegment(input, 'left', { x: 20, y: 20 }, { x: 40, y: 40 }, 100);
  // Width trapezoids: 0..20 = 1500, 20..40 = 1200, 40..60 = 1300.
  const measured = measureScratch(edited, 100, 60);
  assert.equal(measured.areaPx, 4000); assert.equal(measured.meanWidthPx, 4000 / 60);
  assert.equal(measured.roiAreaPx, 6000);
  assert.equal(measureScratch(input, 100, 60).areaPx, 4800);
});

test('invalid boundaries and nonfinite editing coordinates fail explicitly', () => {
  assert.throws(() => moveScratchBoundary([], 'left', 10, 2, 5, 100), /至少/);
  assert.throws(() => moveScratchBoundary(jagged, 'left', 10, 2, 0, 100), /范围/);
  assert.throws(() => moveScratchBoundary(jagged, 'left', NaN, 2, 5, 100), /有限/);
  assert.throws(() => moveScratchBoundary(jagged, 'left', 10, 2, 5, 50), /范围/);
  assert.throws(() => traceScratchSegment([...jagged, jagged[0]], 'left', { x: 1, y: 2 }, { x: 2, y: 3 }, 100), /递增/);
  assert.throws(() => traceScratchSegment(jagged, 'left', { x: Infinity, y: 2 }, { x: 2, y: 3 }, 100), /有限/);
  assert.throws(() => traceScratchSegment(jagged, 'right', { x: 1, y: 2 }, { x: 2, y: 3 }, 0), /宽度/);
});
