import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS } from "../src/lib/timestral.js";
import { SERVICE_LEVELS, levelIndex, summarize, applyEdit, hasScenario, outlook } from "../src/lib/plan.js";
import { encodeSettings, decodeSettings } from "../src/lib/settings.js";

// One forecast step whose quantile at each level is base + 100 * level, so every level is easy to read back.
const step = (base) => LEVELS.map((l) => base + 100 * l);

test("service levels run from the median to 99%", () => {
  assert.equal(SERVICE_LEVELS[0], 0.5);
  assert.equal(SERVICE_LEVELS.at(-1), 0.99);
  assert.equal(LEVELS[levelIndex(0.95)], 0.95);
  assert.equal(LEVELS[levelIndex(0.93)], 0.95);
});

test("summarize adds up each quantile over the period, or averages it", () => {
  const full = [step(0), step(10), step(20)];
  const s = summarize(full, 1, 3, 0.9);
  assert.equal(s.steps, 2);
  assert.equal(s.median, 10 + 50 + 20 + 50);
  assert.equal(s.low, 10 + 10 + 20 + 10);
  assert.equal(s.high, s.plan);
  assert.equal(summarize(full, 0, 3, 0.5, "mean").median, 60);
  assert.equal(summarize(full, 3, 5, 0.5), null);
});

test("applyEdit sets or scales values past the end of the data, within the steps", () => {
  const values = [1, 2, 3, 10, 10, null, 10];
  assert.deepEqual(applyEdit(values, 3, { mode: "set", value: 0, from: 2, to: 3 }), [1, 2, 3, 10, 0, 0, 10]);
  assert.deepEqual(applyEdit(values, 3, { mode: "change", value: 50, from: 1, to: 99 }), [1, 2, 3, 15, 15, null, 15]);
  assert.equal(applyEdit(values, 3, { mode: "file", value: 5 }), values);
  assert.equal(applyEdit(values, 3, { mode: "set", value: NaN }), values);
  assert.equal(hasScenario({ a: { mode: "file", value: 1 }, b: { mode: "set", value: 2 } }), true);
  assert.equal(hasScenario({}), false);
});

test("outlook compares the last steps with the next ones", () => {
  const o = outlook([5, 10, 10, null], [step(-40), step(-40)], 2);
  assert.equal(o.last, 20); // the missing value counts as the average of the others
  assert.equal(o.next, 20);
  assert.equal(o.growth, 0);
  assert.equal(o.spread, (2 * 80) / 20);
  assert.equal(outlook([0, 0], [step(-40)], 1).growth, null);
});

test("settings survive a round trip through the URL hash", () => {
  const s = { ex: "bikes", t: ["Rentals per hour"], c: ["temp", "holiday"], k: ["holiday"], h: 168, model: "5M",
              back: 1, level: 0.95, tab: "plan", scenario: { holiday: { mode: "set", value: 1, from: 1, to: 24 } } };
  assert.deepEqual(decodeSettings("#" + encodeSettings(s)), s);
  assert.deepEqual(decodeSettings(encodeSettings({ file: "my data.csv", group: "Store", key: "A & B" })),
                   { file: "my data.csv", group: "Store", key: "A & B" });
  assert.equal(decodeSettings(""), null);
  assert.deepEqual(decodeSettings("#h=abc&scenario={"), {});
});
