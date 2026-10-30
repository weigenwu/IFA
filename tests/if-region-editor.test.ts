import assert from 'node:assert/strict';
import test from 'node:test';
import { ellipseControls, smoothContour, moveContour, contourBounds, resizeContour } from '../lib/if-region-editor.ts';
import { pointInPolygon, summarizeIf, type Point, type Region } from '../lib/if-count.ts';

const region = (points: Point[]): Region => ({ id: 'bundle', name: 'bundle', kind: 'region', points });

test('ellipse controls interpolate a closed smooth contour with the expected area in either drag direction', () => {
  const controls = ellipseControls({ x: 10, y: 20 }, { x: 110, y: 80 });
  assert.equal(controls.length, 16);
  assert.deepEqual(controls[0], { x: 110, y: 50 });
  assert.ok(controls[1].y > controls[0].y);
  assert.deepEqual(ellipseControls({ x: 110, y: 80 }, { x: 10, y: 20 }), controls);
  const points = smoothContour(controls, 120, 100);
  assert.equal(points.length, 128);
  assert.notDeepEqual(points[0], points[points.length - 1]);
  for (const control of controls) assert.ok(points.some(p => Math.hypot(p.x - control.x, p.y - control.y) < 1e-8));
  const measured = summarizeIf([], [region(points)], 120, 100)[0].areaPx;
  assert.ok(Math.abs(measured / (Math.PI * 50 * 30) - 1) < .01);
  assert.deepEqual(ellipseControls({ x: 5, y: 5 }, { x: 5, y: 20 }), []);
});

test('edited contour pixels, including a concavity, exactly determine regional measurement', () => {
  const controls = ellipseControls({ x: 10, y: 10 }, { x: 70, y: 70 });
  const original = controls.map(p => ({ ...p }));
  const ellipse = smoothContour(controls, 80, 80);
  const edited = controls.map((p, i) => i === 0 ? { x: 39, y: p.y } : p);
  const points = smoothContour(edited, 80, 80);
  let expected = 0;
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) expected += Number(pointInPolygon({ x: x + .5, y: y + .5 }, points));
  assert.equal(summarizeIf([], [region(points)], 80, 80)[0].areaPx, expected);
  assert.ok(expected < summarizeIf([], [region(ellipse)], 80, 80)[0].areaPx);
  assert.equal(pointInPolygon({ x: 55, y: 40 }, points), false);
  assert.deepEqual(controls, original);
});

test('translation preserves shape at bounds, edge smoothing stays valid, and duplicates are harmless', () => {
  const controls = ellipseControls({ x: 10, y: 10 }, { x: 70, y: 70 });
  const original = controls.map(p => ({ ...p }));
  const moved = moveContour(controls, 100, -100, 80, 80);
  assert.deepEqual(moved, controls.map(p => ({ x: p.x + 10, y: p.y - 10 })));
  const points = smoothContour(moved, 80, 80);
  assert.ok(points.every(p => p.x >= 0 && p.x <= 80 && p.y >= 0 && p.y <= 80));
  assert.doesNotThrow(() => summarizeIf([], [region(points)], 80, 80));
  const repeated = [controls[0], ...controls, controls[0]];
  assert.deepEqual(smoothContour(repeated, 80, 80), smoothContour(controls, 80, 80));
  assert.deepEqual(controls, original);
  assert.throws(() => smoothContour([{ x: NaN, y: 0 }], 80, 80), /无效/);
});

test('crossed edited outlines remain rejected by the shared measurement validation', () => {
  const points = smoothContour([{ x: 10, y: 10 }, { x: 70, y: 70 }, { x: 10, y: 70 }, { x: 70, y: 10 }], 80, 80);
  assert.throws(() => summarizeIf([], [region(points)], 80, 80), /交叉/);
});

test('corner resizing anchors the opposite corner, preserves relative shape, and prevents flips', () => {
  const controls = ellipseControls({ x: 10, y: 20 }, { x: 70, y: 80 });
  controls[0] = { x: 60, y: 50 };
  const original = controls.map(p => ({ ...p })), before = contourBounds(controls);
  const resized = resizeContour(controls, 0, { x: -20, y: 10 }, 100, 100);
  assert.deepEqual(contourBounds(resized), { ...before, left: 0, top: 10 });
  resized.forEach((p, i) => {
    assert.ok(Math.abs(p.x / before.right - (controls[i].x - before.left) / (before.right - before.left)) < 1e-10);
    assert.ok(Math.abs((p.y - 10) / 70 - (controls[i].y - 20) / 60) < 1e-10);
  });
  const collapsed = contourBounds(resizeContour(controls, 2, { x: -100, y: -100 }, 100, 100));
  assert.deepEqual(collapsed, { left: 10, top: 20, right: 11, bottom: 21 });
  assert.deepEqual(controls, original);
  assert.doesNotThrow(() => summarizeIf([], [region(smoothContour(resized, 100, 100))], 100, 100));
});
