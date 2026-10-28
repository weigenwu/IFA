import assert from 'node:assert/strict';
import test from 'node:test';
import { scratchDisplayEdges } from '../lib/scratch-display.ts';
import { measureScratch, type ScratchBoundary } from '../lib/migration.ts';

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test('straight display simplifies jagged edges without changing contours or their measurements', () => {
  const contour = [20, 30, 20, 30, 20].map((left, i) => ({ y: i * 10, left, right: 100 - left }));
  const original = structuredClone(contour), measurement = measureScratch(contour, 100, 40);
  assert.equal(scratchDisplayEdges(contour, 'contour', 100), contour);
  const straight = scratchDisplayEdges(contour, 'straight', 100);
  assert.equal(straight.length, 2);
  assert.deepEqual(straight.map(point => point.y), [0, 40]);
  for (const point of straight) { close(point.left, 25); close(point.right, 75); }
  assert.deepEqual(contour, original);
  assert.deepEqual(measureScratch(contour, 100, 40), measurement);
  assert.equal(measurement.areaPx, 2000);
});

test('straight display retains oblique edges and the original first and last Y coordinates', () => {
  const contour = [7, 12, 44, 107].map(y => ({ y, left: 10 + (y - 7) * 0.2, right: 60 + (y - 7) * 0.3 }));
  const straight = scratchDisplayEdges(contour, 'straight', 100);
  assert.deepEqual(straight.map(point => point.y), [7, 107]);
  close(straight[0].left, 10); close(straight[0].right, 60);
  close(straight[1].left, 30); close(straight[1].right, 90);
});

test('continuous fit is unchanged by nonuniform densification of a manually traced section', () => {
  const contour = [
    { y: 10, left: 10, right: 70 },
    { y: 30, left: 30, right: 80 },
    { y: 110, left: 30, right: 60 },
  ];
  const dense = Array.from({ length: 21 }, (_, i) => ({ y: 10 + i, left: 10 + i, right: 70 + i / 2 }));
  dense.push(contour[2]);
  const sparseFit = scratchDisplayEdges(contour, 'straight', 100), denseFit = scratchDisplayEdges(dense, 'straight', 100);
  close(sparseFit[0].left, 22.8); close(sparseFit[1].left, 33.2);
  close(sparseFit[0].right, 79.6); close(sparseFit[1].right, 62.4);
  sparseFit.forEach((point, i) => {
    assert.equal(point.y, denseFit[i].y);
    close(point.left, denseFit[i].left); close(point.right, denseFit[i].right);
  });
});

test('fitted endpoints stay inside the image and crossing fits meet at their midpoint', () => {
  const clipped = scratchDisplayEdges([
    { y: 0, left: 0, right: 0 },
    { y: 10, left: 0, right: 100 },
    { y: 90, left: 0, right: 100 },
    { y: 100, left: 100, right: 100 },
  ], 'straight', 100);
  assert.equal(clipped[0].left, 0); close(clipped[0].right, 81);
  close(clipped[1].left, 19); assert.equal(clipped[1].right, 100);
  const crossing = scratchDisplayEdges([
    { y: 0, left: 40, right: 40 },
    { y: 90, left: 40, right: 40 },
    { y: 100, left: 40, right: 100 },
  ], 'straight', 100);
  close(crossing[0].left, 37.3); assert.equal(crossing[0].left, crossing[0].right);
  close(crossing[1].left, 40); close(crossing[1].right, 51.4);
});

test('empty, single-point, nonfinite and invalid geometry gracefully preserves the original display', () => {
  const valid = [{ y: 0, left: 10, right: 90 }, { y: 10, left: 20, right: 80 }];
  const invalid: ScratchBoundary[][] = [
    [], [valid[0]], [valid[0], valid[0]], [valid[1], valid[0]],
    [{ y: -1, left: 10, right: 90 }, valid[1]],
    [valid[0], { y: NaN, left: 20, right: 80 }],
    [valid[0], { y: 10, left: Infinity, right: 80 }],
    [valid[0], { y: 10, left: 20, right: NaN }],
    [valid[0], { y: 10, left: -1, right: 80 }],
    [valid[0], { y: 10, left: 90, right: 80 }],
    [valid[0], { y: 10, left: 20, right: 101 }],
  ];
  for (const contour of invalid) assert.equal(scratchDisplayEdges(contour, 'straight', 100), contour);
  for (const width of [0, -1, NaN, Infinity]) assert.equal(scratchDisplayEdges(valid, 'straight', width), valid);
});
