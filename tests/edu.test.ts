import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeEdu, cleanupDisplay, cleanupEduDisplay, type EduParameters, type EduDisplayOptions } from '../lib/edu.ts';

const parameters: EduParameters = {
  nucleusThreshold: 10, eduThreshold: 20, minArea: 2, maxArea: 100,
  median: false, excludeEdge: false, minPositiveFraction: 0.5,
};

test('raw full-resolution nuclei: strict intensity thresholds, fraction boundary, 8-connectivity, noise rejection', () => {
  const nucleus = new Uint16Array(7 * 5);
  const edu = new Uint16Array(nucleus.length);
  // Two separated diagonal pairs plus a one-pixel speck and a threshold-equal pixel.
  for (const i of [8, 16, 11, 19, 32]) nucleus[i] = 1000;
  nucleus[3] = 10;
  edu[8] = 21;
  edu[16] = 20;
  edu[11] = 20;
  edu[19] = 20;
  const before = { nucleus: nucleus.slice(), edu: edu.slice() };
  const result = analyzeEdu(nucleus, edu, 7, 5, parameters);
  assert.equal(result.total, 2);
  assert.equal(result.positive, 1);
  assert.equal(result.positivePct, 50);
  assert.deepEqual(result.nuclei.map(n => [n.area, n.eduMean, n.eduPositiveFraction, n.positive]), [[2, 20.5, 0.5, true], [2, 20, 0, false]]);
  assert.equal(result.labels[8], result.labels[16]);
  assert.notEqual(result.labels[8], result.labels[11]);
  assert.equal(result.labels[32], 0);
  assert.equal(result.labels[3], 0);
  assert.deepEqual(nucleus, before.nucleus);
  assert.deepEqual(edu, before.edu);
});

test('area and edge gates remove labels without disturbing accepted sequential IDs', () => {
  const nucleus = new Uint8Array(11 * 5);
  for (const i of [0, 1, 25, 26, 29, 30, 31]) nucleus[i] = 30;
  const result = analyzeEdu(nucleus, nucleus, 11, 5, { ...parameters, maxArea: 2, excludeEdge: true });
  assert.equal(result.total, 1);
  assert.equal(result.nuclei[0].area, 2);
  assert.equal(result.nuclei[0].id, 1);
  assert.equal(result.labels[0], 0);
  assert.equal(result.labels[29], 0);
  const edges = analyzeEdu(nucleus, nucleus, 11, 5, { ...parameters, excludeEdge: true });
  assert.equal(edges.total, 2);
  assert.ok(edges.warnings.some(message => message.includes('边缘')));
});

test('3×3 median affects segmentation only and removes isolated nuclear specks', () => {
  const nucleus = new Uint8Array(9 * 7);
  const edu = new Uint16Array(nucleus.length);
  for (let y = 2; y <= 4; y++) for (let x = 2; x <= 4; x++) nucleus[y * 9 + x] = 80;
  nucleus[16] = 80;
  edu[3 * 9 + 3] = 1000;
  const result = analyzeEdu(nucleus, edu, 9, 7, { ...parameters, median: true, minArea: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.nuclei[0].area, 5);
  assert.equal(result.nuclei[0].eduMean, 200);
  assert.equal(result.nuclei[0].eduPositiveFraction, 0.2);
  assert.equal(result.labels[16], 0);
  assert.equal(nucleus[16], 80);
  assert.equal(edu[30], 1000);
});

test('blank image returns a missing denominator instead of zero percent', () => {
  const blank = new Uint8Array(16);
  const result = analyzeEdu(blank, blank, 4, 4, parameters);
  assert.equal(result.total, 0);
  assert.equal(result.positive, 0);
  assert.equal(result.positivePct, null);
  assert.ok(result.warnings.some(message => message.includes('NA')));
});

test('display cleanup removes only small/low islands and never changes the input', () => {
  const input = new Float64Array([0, 5, 0, 99, 10, 0, 20, 0, 0, 0, 0, 0]);
  const copy = input.slice();
  const cleaned = cleanupDisplay(input, 4, 3, 5, 2);
  assert.deepEqual([...cleaned], [0, 0, 0, 99, 0, 0, 20, 0, 0, 0, 0, 0]);
  assert.deepEqual(input, copy);
  assert.notEqual(cleaned, input);
});

test('red cleanup protects tiny nuclear signal, rejects extracellular fragments, and optionally rejects all nonnuclear components', () => {
  const nucleus = new Uint16Array(12 * 8);
  const edu = new Uint16Array(nucleus.length);
  for (let y = 2; y <= 4; y++) for (let x = 3; x <= 5; x++) nucleus[y * 12 + x] = 100;
  nucleus[22] = 100; // A blue speck must not protect the matching red fragment.
  edu[40] = 300;
  edu[22] = 999;
  for (const i of [79, 80, 81]) edu[i] = 250;
  const options: EduDisplayOptions = { floor: 50, minArea: 3, nucleusThreshold: 50, nucleusMinArea: 3, protectNuclear: true, onlyNuclear: false };
  const originals = { nucleus: nucleus.slice(), edu: edu.slice() };
  const cleaned = cleanupEduDisplay(edu, nucleus, 12, 8, options);
  assert.equal(cleaned[40], 300);
  assert.equal(cleaned[22], 0);
  assert.equal(cleaned[80], 250);
  const nuclearOnly = cleanupEduDisplay(edu, nucleus, 12, 8, { ...options, onlyNuclear: true });
  assert.equal(nuclearOnly[40], 300);
  assert.equal(nuclearOnly[80], 0);
  const noProtection = cleanupEduDisplay(edu, nucleus, 12, 8, { ...options, protectNuclear: false });
  assert.deepEqual(noProtection, cleanupDisplay(edu, 12, 8, options.floor, options.minArea));
  assert.deepEqual(nucleus, originals.nucleus);
  assert.deepEqual(edu, originals.edu);
});

test('nuclear overlap retains a whole red component without clipping its extranuclear pixels', () => {
  const nucleus = new Uint8Array(7 * 5);
  const edu = new Float64Array(nucleus.length);
  nucleus[16] = nucleus[17] = 100;
  edu[17] = 100.125;
  edu[18] = 80.25;
  edu[19] = 50.5;
  const cleaned = cleanupEduDisplay(edu, nucleus, 7, 5, {
    floor: 50, minArea: 5, nucleusThreshold: 50, nucleusMinArea: 2, protectNuclear: true, onlyNuclear: true,
  });
  assert.deepEqual(cleaned, edu);
  assert.throws(() => cleanupEduDisplay(edu, nucleus.slice(1), 7, 5, {
    floor: 50, minArea: 5, nucleusThreshold: 50, nucleusMinArea: 2, protectNuclear: true, onlyNuclear: true,
  }), /像素数/);
});

test('invalid geometry, channel length, nonfinite pixels and parameters are rejected', () => {
  const image = new Uint8Array(4);
  assert.throws(() => analyzeEdu(image, new Uint8Array(3), 2, 2, parameters), /像素数/);
  assert.throws(() => analyzeEdu(image, image, 0, 2, parameters), /宽高/);
  assert.throws(() => analyzeEdu(image, image, 2.5, 2, parameters), /宽高/);
  assert.throws(() => analyzeEdu(image, new Float64Array([0, 0, NaN, 0]), 2, 2, parameters), /非有限/);
  assert.throws(() => analyzeEdu(image, image, 2, 2, { ...parameters, nucleusThreshold: Infinity }), /强度阈值/);
  assert.throws(() => analyzeEdu(image, image, 2, 2, { ...parameters, minArea: 0 }), /面积阈值/);
  assert.throws(() => analyzeEdu(image, image, 2, 2, { ...parameters, maxArea: 1 }), /最大核面积/);
  assert.throws(() => analyzeEdu(image, image, 2, 2, { ...parameters, minPositiveFraction: 1.1 }), /比例阈值/);
  assert.throws(() => cleanupDisplay(image, 2, 2, NaN, 2), /强度阈值/);
});
