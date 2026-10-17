import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleOptions, placeIn, splitCycles, embed, embedForecast } from "../src/lib/evolution.js";

const H = 3600, D = 86400;
const at = (y, mo, d, h = 0) => Date.UTC(y, mo - 1, d, h) / 1000;

test("cycleOptions follows the time step and the length of the data", () => {
  assert.deepEqual(cycleOptions(H, 24, 24 * 800).map((o) => o.id), ["day", "week", "year"]);
  assert.deepEqual(cycleOptions(H, 24, 24 * 20).map((o) => o.id), ["day", "week"]); // not two years
  assert.deepEqual(cycleOptions(D, 7, 1000).map((o) => o.id), ["week", "year"]);
  assert.deepEqual(cycleOptions(30 * D, 12, 800).map((o) => o.id), ["year"]);
  assert.deepEqual(cycleOptions(null, 12, 100).map((o) => o.id), ["rows"]);
  assert.deepEqual(cycleOptions(null, 1, 100), []);
});

test("placeIn finds the cycle and the phase", () => {
  assert.equal(placeIn("day", at(2026, 3, 5, 18), 0).phase, 0.75);
  assert.equal(placeIn("week", at(2026, 10, 12), 0).phase, 0); // a Monday
  assert.equal(placeIn("week", at(2026, 10, 18, 12), 0).phase, 6.5 / 7); // Sunday noon
  assert.equal(placeIn("week", at(2026, 10, 12), 0).cycle, placeIn("week", at(2026, 10, 18, 23), 0).cycle);
  assert.equal(placeIn("year", at(2026, 7, 2), 0).cycle, 2026);
  assert.ok(Math.abs(placeIn("year", at(2026, 7, 2), 0).phase - 182 / 365) < 1e-9);
  assert.deepEqual(placeIn("rows", null, 17, 12), { cycle: 1, phase: 5 / 12 });
});

test("splitCycles groups points by cycle and skips missing values", () => {
  const times = [0, 1, 2, 3, 4].map((k) => at(2026, 1, 1, 22) + k * H); // 22:00 to 02:00
  const cycles = splitCycles("day", times, [[1, 2, null, 4, 5]]);
  assert.equal(cycles.length, 2);
  assert.deepEqual(cycles[0].points.map((p) => p[1]), [1, 2]);
  assert.deepEqual(cycles[1].points.map((p) => [p[0], p[1]]), [[1 / 24, 4], [2 / 24, 5]]);
  const forecast = splitCycles("rows", null, [[1, 2, 3], [0, 1, 2], [2, 3, 4]], 2, 4);
  assert.deepEqual(forecast.map((c) => c.points.length), [2, 1]);
  assert.deepEqual(forecast[0].points[0], [0, 1, 0, 2]);
});

test("embed and embedForecast pair each value with the one lag steps before", () => {
  assert.deepEqual(embed([1, 2, null, 4, 5], 1), [[1, 2, 1], [4, 5, 4]]);
  assert.deepEqual(embedForecast([1, 2, 3], [10, 11], [9, 10], [12, 13], 1), [[3, 10, 9, 12], [10, 11, 10, 13]]);
  assert.deepEqual(embedForecast([1, 2, 3], [10, 11], [9, 10], [12, 13], 2), [[2, 10, 9, 12], [3, 11, 10, 13]]);
});
