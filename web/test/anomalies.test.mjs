import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS } from "../src/lib/timestral.js";
import { findAnomalies } from "../src/lib/anomalies.js";

// A forecast step centered on 100 whose quantile at level l is 100 + 100 * (l - 0.5): q01 = 51, q99 = 149.
const step = LEVELS.map((l) => 100 + 100 * (l - 0.5));

test("points outside the range are found, the most unusual first", () => {
  const { points, checked } = findAnomalies([{ at: 10, actual: [[100, 160, 30, null, 149]], full: [Array(5).fill(step)] }], 0.98);
  assert.equal(checked, 4); // the missing value is not checked
  assert.deepEqual(points.map((p) => p.row), [12, 11]); // 30 is further out than 160
  assert.equal(points[0].value, 30);
  assert.ok(Math.abs(points[0].off - 21 / 49) < 1e-9); // 21 below q01, whose half-range is 49
  assert.ok(Math.abs(points[1].off - 11 / 49) < 1e-9);
});

test("a narrower range flags more points", () => {
  const w = [{ at: 0, actual: [[100, 145, 135, 55]], full: [Array(4).fill(step)] }];
  assert.equal(findAnomalies(w, 0.98).points.length, 0);
  assert.equal(findAnomalies(w, 0.8).points.length, 2); // q10 = 60, q90 = 140: 145 and 55 are out
});

test("a row checked by two windows counts once, judged by the shorter lead", () => {
  const a = { at: 0, actual: [[200, 100]], full: [[step, step]] };
  const b = { at: 1, actual: [[200]], full: [[step]] };
  const { points, checked } = findAnomalies([a, b], 0.98);
  assert.equal(checked, 2);
  // Row 1 is one step ahead in `a` but the first step of `b`, so b's value decides.
  assert.deepEqual(points.map((p) => p.row), [0, 1]);
  // The order of the windows does not change the result; on a tie the first window wins.
  assert.deepEqual(findAnomalies([b, a], 0.98).points.map((p) => p.row).sort(), [0, 1]);
  assert.deepEqual(findAnomalies([{ at: 0, actual: [[100]], full: [[step]] }, { at: 0, actual: [[200]], full: [[step]] }], 0.98).points, []);
});
