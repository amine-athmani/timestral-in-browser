import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumber, parseTime, parseTable, season } from "../src/lib/data.js";

const days = (n) => Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)));

test("parseNumber reads plain numbers and decimal commas", () => {
  assert.equal(parseNumber(" 12.5 "), 12.5);
  assert.equal(parseNumber("1e3"), 1000);
  assert.equal(parseNumber(""), null);
  assert.equal(parseNumber("12,5"), null);
  assert.equal(parseNumber("12,5", ","), 12.5);
  assert.equal(parseNumber("1.234,5", ","), 1234.5);
  assert.equal(parseNumber("1 234,5", ","), 1234.5);
  assert.equal(parseNumber("abc"), null);
});

test("parseTime reads ISO dates and day-first dates in UTC", () => {
  assert.equal(parseTime("2026-03-05"), Date.UTC(2026, 2, 5));
  assert.equal(parseTime("2026-03-05 13:30"), Date.UTC(2026, 2, 5, 13, 30));
  assert.equal(parseTime("05/03/2026"), Date.UTC(2026, 2, 5));
  assert.equal(parseTime("03/05/2026", false), Date.UTC(2026, 2, 5));
  assert.equal(parseTime("31.12.2025 23:00"), Date.UTC(2025, 11, 31, 23));
  assert.ok(Number.isNaN(parseTime("13/13/2026")));
});

test("parseTable reads a semicolon file with decimal commas and day-first dates", () => {
  const csv = "date;value\n" + days(40).map((d, i) =>
    `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/2026;${(10 + i / 4).toFixed(2).replace(".", ",")}`).join("\n");
  const t = parseTable(csv);
  assert.equal(t.timeCol, "date");
  assert.deepEqual(t.fields, ["value"]);
  assert.equal(t.rows[1].value, 10.25);
  assert.equal(t.times[0], Date.UTC(2026, 0, 1) / 1000);
  assert.equal(t.times[39] - t.times[38], 86400);
});

test("parseTable sorts rows by time and says so", () => {
  const csv = "date,value\n" + days(30).map((d, i) => `${d.toISOString().slice(0, 10)},${i}`).reverse().join("\n");
  const t = parseTable(csv);
  assert.deepEqual(t.rows.slice(0, 3).map((r) => r.value), [0, 1, 2]);
  assert.ok(t.times.every((x, i) => !i || x > t.times[i - 1]));
  assert.ok(t.notes.includes("rows sorted by time"));
});

test("parseTable leaves out rows without a valid time", () => {
  const lines = days(30).map((d, i) => `${d.toISOString().slice(0, 10)},${i}`);
  lines[5] = "not a date,5";
  const t = parseTable("date,value\n" + lines.join("\n"));
  assert.equal(t.rows.length, 29);
  assert.ok(t.notes[0].startsWith("1 row without"));
});

test("a year column is the time axis, not a column to forecast", () => {
  const csv = "year,sales\n" + Array.from({ length: 30 }, (_, i) => `${1990 + i},${100 + i}`).join("\n");
  const t = parseTable(csv);
  assert.equal(t.timeCol, "year");
  assert.deepEqual(t.fields, ["sales"]);
  assert.equal(t.times[0], Date.UTC(1990, 0, 1) / 1000);
});

test("a numeric series in the year range is not mistaken for years", () => {
  const csv = "visitors\n" + [1200, 1350, 1100, 1800, 1650, 1500].join("\n");
  const t = parseTable(csv);
  assert.equal(t.timeCol, null);
  assert.deepEqual(t.fields, ["visitors"]);
});

test("parseTable rejects files without numbers", () => {
  assert.throws(() => parseTable("a,b\nx,y\nz,w"), /no numeric columns/);
  assert.throws(() => parseTable(""), /no rows/);
});

test("season follows the time step", () => {
  const every = (step, n = 50) => Array.from({ length: n }, (_, i) => i * step);
  assert.deepEqual(season(every(3600)), { m: 24, name: "day" });
  assert.deepEqual(season(every(900)), { m: 96, name: "day" });
  assert.deepEqual(season(every(86400)), { m: 7, name: "week" });
  assert.deepEqual(season(every(7 * 86400)), { m: 52, name: "year" });
  assert.deepEqual(season(Array.from({ length: 30 }, (_, i) => Date.UTC(2000, i, 1) / 1000)), { m: 12, name: "year" });
  assert.deepEqual(season(null), { m: 1, name: null });
});
