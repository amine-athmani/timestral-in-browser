import { test } from "node:test";
import assert from "node:assert/strict";
import { seasonalNaive, maseScale, score, pool, change } from "../src/lib/metrics.js";

// Five quantile rows that all equal the median, for a forecast with no spread.
const flat = (median) => [median, median, median, median, median];

test("seasonalNaive repeats the last cycle", () => {
  assert.deepEqual(seasonalNaive([1, 2, 3, 4, 5, 6], 5, 3), [4, 5, 6, 4, 5]);
  assert.deepEqual(seasonalNaive([1, 2], 3, 3), [2, 2, 2]); // shorter than a cycle: the last value
  assert.deepEqual(seasonalNaive([1, 2, null], 2, 1), [2, 2]);
});

test("maseScale is the mean one-cycle-back error over the history", () => {
  assert.equal(maseScale([1, 2, 4, 7], 1), 2);
  assert.equal(maseScale([1, 2, 1, 2], 2), null); // a perfect seasonal history has no scale
  assert.equal(maseScale([5], 1), null);
});

test("score compares the median with what happened and with naive guesses", () => {
  const context = [[0, 10, 0, 10]];
  const actual = [[0, 10]];
  const s = score(actual, [flat([1, 9])], context, 2);
  assert.equal(s.mae, 1);
  assert.equal(s.naive, 5); // repeating 10
  assert.equal(s.seasonal, 0); // repeating 0, 10
  assert.equal(s.mase, null); // the history repeats exactly, so there is no scale
  assert.equal(s.count, 2);
});

test("score counts coverage inside q10..q90 and skips missing points", () => {
  const q = [[[0, 0, 0], [0, 0, 0], [5, 5, 5], [0, 0, 0], [10, 10, 10]]];
  const s = score([[5, 20, null]], q, [[1, 2, 3, 4]], 1);
  assert.equal(s.count, 2);
  assert.equal(s.coverage, 0.5);
  assert.equal(s.mase, (0 + 15) / 2 / 1);
  assert.equal(score([[null]], q, [[1]], 1), null);
});

test("pool weights by points and change handles a zero baseline", () => {
  const p = pool([{ mae: 1, naive: 2, seasonal: 2, coverage: 1, count: 1, mase: 0.5 },
                  { mae: 4, naive: 2, seasonal: 2, coverage: 0, count: 3, mase: null }, null]);
  assert.equal(p.mae, 3.25);
  assert.equal(p.coverage, 0.25);
  assert.equal(p.mase, 0.5);
  // MASE is weighted by points like the rest.
  assert.equal(pool([{ mae: 1, naive: 1, seasonal: 1, coverage: 1, count: 1, mase: 2 },
                     { mae: 1, naive: 1, seasonal: 1, coverage: 1, count: 3, mase: 1 }]).mase, 1.25);
  assert.equal(change(8, 10), -20);
  assert.equal(change(1, 0), null);
});
