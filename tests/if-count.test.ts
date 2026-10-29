import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeIf, summarizeIf, pointInPolygon, type Parameters, type Region } from '../lib/if-count.ts';

const parameters: Parameters = { nucleusThreshold: 10, aThreshold: 20, bThreshold: 20, minArea: 1, maxArea: 100,
  median: false, excludeEdge: false, radius: 0, minPositiveFraction: .1 };
const box = (id: string, x: number, y: number, w: number, h: number, kind: Region['kind'] = 'region'): Region => ({
  id, name: id, kind, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
});

test('nuclear association uses circular distance, unique nearest ownership, deterministic ties, and original nuclear pixels', () => {
  const nucleus = new Uint8Array(9 * 5), a = new Uint8Array(nucleus.length), b = a.slice();
  nucleus[2 * 9 + 2] = nucleus[2 * 9 + 6] = 100;
  a[2 * 9 + 4] = b[2 * 9 + 4] = 100; // Equidistant: assigned to left nucleus only.
  a[0] = 100; // Distance sqrt(8): inside radius 3, outside circular radius 2.
  b[2 * 9 + 6] = 100; // Right nucleus keeps its own pixel even with overlapping expansion.
  const originals = [nucleus.slice(), a.slice(), b.slice()];
  const result = analyzeIf(nucleus, a, b, 9, 5, { ...parameters, radius: 3, minPositiveFraction: .01 }, []);
  assert.equal(result.cells.length, 2);
  assert.deepEqual(result.cells.map(cell => [cell.aPositive, cell.bPositive]), [[true, true], [false, true]]);
  assert.equal(result.cells[0].overlapFraction, result.cells[0].aFraction / 2); // (0,0) is within radius 3.
  assert.deepEqual([nucleus, a, b], originals);
  const radius2 = analyzeIf(nucleus, a, b, 9, 5, { ...parameters, radius: 2, minPositiveFraction: .01 }, []);
  assert.equal(radius2.cells[0].overlapFraction, radius2.cells[0].aFraction);
});

test('cell double positivity differs from pixel overlap; native thresholds are strict and negatives preserved', () => {
  const nucleus = new Uint8Array([0, 0, 0, 0, 100, 100, 0, 0, 0, 0, 0, 0]);
  const a = new Float64Array(12).fill(-2), b = new Float64Array(12).fill(-4);
  a[4] = 21; b[5] = 21;
  const result = analyzeIf(nucleus, a, b, 4, 3, { ...parameters, minPositiveFraction: .5 }, []);
  assert.equal(result.cells[0].doublePositive, true);
  assert.equal(result.cells[0].overlapFraction, 0);
  assert.equal(result.cells[0].aMean, 9.5);
  assert.equal(result.cells[0].bMean, 8.5);
  a[4] = 20;
  assert.equal(analyzeIf(nucleus, a, b, 4, 3, parameters, []).cells[0].aPositive, false);
});

test('nested and overlapping regions partition tissue once; outside cells remain available without inflating counts', () => {
  const nucleus = new Uint8Array(10 * 8);
  for (const [x, y] of [[2, 2], [5, 2], [7, 5], [0, 7]]) nucleus[y * 10 + x] = 100;
  const regions = [box('outside', 1, 1, 8, 6, 'tissue'), box('inside', 1, 1, 5, 3), box('overlap', 4, 1, 4, 3)];
  const result = analyzeIf(nucleus, nucleus, nucleus, 10, 8, parameters, regions);
  assert.deepEqual(result.regions.map(region => [region.id, region.areaPx, region.total]), [['outside', 27, 1], ['inside', 15, 2], ['overlap', 6, 0]]);
  assert.equal(result.cells[3].regionId, null);
  assert.equal(result.regions.reduce((sum, region) => sum + region.total, 0), 3);
  assert.ok(result.warnings.some(warning => warning.includes('重叠')));
  result.cells[0].excluded = true;
  result.cells[1].bPositive = false;
  const revised = summarizeIf(result.cells, regions, 10, 8);
  assert.equal(revised[1].total, 1);
  assert.equal(revised[1].doublePositive, 0);
  assert.equal(revised[1].doubleOfAPct, 0);
});

test('scanline area and centroid membership agree on concave, diagonal and boundary-centered polygons', () => {
  const polygons: Region[] = [
    { id: 'triangle', name: 'triangle', kind: 'region', points: [{ x: .5, y: .5 }, { x: 6.5, y: .5 }, { x: .5, y: 6.5 }] },
    { id: 'concave', name: 'concave', kind: 'region', points: [{ x: 1, y: 1 }, { x: 8, y: 1 }, { x: 8, y: 7 }, { x: 5, y: 3 }, { x: 1, y: 7 }] },
  ];
  for (const region of polygons) {
    let expected = 0;
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) expected += Number(pointInPolygon({ x: x + .5, y: y + .5 }, region.points));
    assert.equal(summarizeIf([], [region], 9, 9)[0].areaPx, expected);
  }
  const combined = summarizeIf([], polygons, 9, 9);
  let union = 0;
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) union += Number(polygons.some(region => pointInPolygon({ x: x + .5, y: y + .5 }, region.points)));
  assert.equal(combined.reduce((sum, region) => sum + region.areaPx, 0), union);
});

test('empty/edge-filtered images retain null denominators and parameter/region failures are explicit', () => {
  const zero = new Uint8Array(25);
  const blank = analyzeIf(zero, zero, zero, 5, 5, parameters, []);
  assert.deepEqual(blank.regions[0], { id: '__all__', name: '全图', areaPx: 25, total: 0, aPositive: 0, bPositive: 0, doublePositive: 0, aPct: null, doubleOfAPct: null });
  zero[0] = 100;
  assert.equal(analyzeIf(zero, zero, zero, 5, 5, { ...parameters, excludeEdge: true }, []).cells.length, 0);
  for (const invalid of [{ radius: -1 }, { radius: 31 }, { radius: 1.5 }, { minPositiveFraction: 0 }, { bThreshold: NaN }]) {
    assert.throws(() => analyzeIf(zero, zero, zero, 5, 5, { ...parameters, ...invalid }, []));
  }
  assert.throws(() => analyzeIf(zero, zero, new Float64Array(25).fill(NaN), 5, 5, parameters, []));
  assert.throws(() => summarizeIf([], [box('a', -1, 0, 2, 2)], 5, 5));
  assert.throws(() => summarizeIf([], [box('a', 0, 0, 2, 2), box('a', 2, 2, 2, 2)], 5, 5));
  assert.throws(() => summarizeIf([], [box('a', 0, 0, 2, 2, 'tissue'), box('b', 2, 2, 2, 2, 'tissue')], 5, 5));
  assert.throws(() => summarizeIf([], [{ id: 'a', name: 'a', kind: 'region', points: [{ x: 0, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }, { x: 4, y: 0 }] }], 5, 5), /交叉/);
});
