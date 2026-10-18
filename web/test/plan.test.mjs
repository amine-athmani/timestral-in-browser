import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS } from "../src/lib/timestral.js";
import { SERVICE_LEVELS, levelIndex, summarize, normInv, stepCorrelation, applyEdit, hasScenario, outlook } from "../src/lib/plan.js";
import { encodeSettings, decodeSettings } from "../src/lib/settings.js";
import { scenarioEditsHTML } from "../src/lib/views.js";

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

// A step forecast that is exactly standard normal, so totals have known answers.
const normal = LEVELS.map((l) => normInv(l));
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test("normInv matches known normal quantiles", () => {
  near(normInv(0.5), 0, 1e-9);
  near(normInv(0.9), 1.2815516, 1e-6);
  near(normInv(0.01), -2.3263479, 1e-6);
});

test("totals of independent steps grow with the square root of the steps", () => {
  const full = Array.from({ length: 100 }, () => normal);
  const s = summarize(full, 0, 100, 0.95, "sum", 0);
  near(s.median, 0, 1.3); // 1,000 paths: the median of the total is good to about ±0.4 here
  near(s.high, 1.2816 * 10, 1.3); // 80% range of a sum of 100 standard normals: ±1.28 * sqrt(100)
  near(s.low, -1.2816 * 10, 1.3);
  near(s.plan, 1.6449 * 10, 1.6);
});

test("totals of steps that move together add up the steps' quantiles", () => {
  const full = Array.from({ length: 100 }, () => normal);
  const s = summarize(full, 0, 100, 0.9, "sum", 1);
  near(s.high, 1.2815516 * 100, 1e-3);
  const mid = summarize(full, 0, 100, 0.9, "sum", 0.8);
  assert.ok(mid.high > 12.8 && mid.high < 128, `rho 0.8 gives ${mid.high}`);
  assert.deepEqual(summarize(full, 0, 100, 0.9, "sum", 0.8), mid); // seeded: the same every time
});

test("stepCorrelation reads how errors carry over", () => {
  const full = Array.from({ length: 30 }, () => normal);
  near(stepCorrelation(Array(30).fill(1.2816), full), 1, 1e-6); // high every step: all together
  assert.equal(stepCorrelation(Array.from({ length: 30 }, (_, i) => (i % 2 ? 1 : -1)), full), 0); // alternating
  assert.equal(stepCorrelation(Array(5).fill(1), full), null); // too few steps to tell
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
  assert.deepEqual(decodeSettings(encodeSettings({ t: ["a"], k: [] })), { t: ["a"], k: [] });
  assert.equal(decodeSettings(""), null);
  assert.deepEqual(decodeSettings("#h=abc&scenario={"), {});
});

test("a scenario from a link keeps only known modes and numbers, so it cannot inject HTML", () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const s = decodeSettings(encodeSettings({ ex: "bike", scenario: {
    holiday: { mode: "set", value: evil, from: evil, to: 5 }, temp: { mode: "<b>", value: 1 }, hum: "x" } }));
  assert.deepEqual(s.scenario, { holiday: { mode: "set", value: null, from: 1, to: 5 } });
  assert.ok(!scenarioEditsHTML([{ col: "holiday", edit: s.scenario.holiday, future: 0 }], 24).includes("<img"));
  // Even an edit that skipped decoding is escaped where it is written.
  assert.ok(!scenarioEditsHTML([{ col: "holiday", edit: { mode: "set", value: evil, from: evil }, future: 0 }], 24).includes("<img"));
});
