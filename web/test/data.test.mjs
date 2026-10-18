import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumber, parseTime, parseTable, readCSV, inspect, buildTable, groupKeys, season } from "../src/lib/data.js";

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

test("a long table is split into its series", () => {
  const lines = ["date,store,sales"];
  for (const store of ["North", "South", "East"]) days(20).forEach((d, i) => lines.push(`${d.toISOString().slice(0, 10)},${store},${i}`));
  const csv = readCSV(lines.join("\n")), info = inspect(csv);
  assert.deepEqual(info.groups, ["store"]);
  assert.deepEqual(info.numeric, ["sales"]);
  assert.deepEqual(groupKeys(csv, "store"), ["North", "South", "East"]);
  const south = buildTable(csv, info, "store", "South");
  assert.equal(south.rows.length, 20);
  assert.deepEqual(south.notes, []); // no repeated times within one store
  assert.throws(() => buildTable(csv, info, "store", "West"), /No rows/);
});

test("a label column with one row per time is not a series column", () => {
  const csv = readCSV("date,weekday,sales\n" + days(28).map((d, i) =>
    `${d.toISOString().slice(0, 10)},${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i % 7]},${i}`).join("\n"));
  assert.deepEqual(inspect(csv).groups, []);
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

test("series names that V8 reads as dates are not taken as the time column", () => {
  for (const s of ["Store 12", "Region 1", "Paris 2", "item-2024"]) assert.ok(Number.isNaN(parseTime(s)), s);
  for (const s of ["2024-01", "Jan 5, 2024", "5 January 2024", "2024-01-01T00:00:00+01:00"]) assert.ok(Number.isFinite(parseTime(s)), s);
  const rows = ["store,date,sales"];
  for (let s = 1; s <= 3; s++) days(10).forEach((d, i) => rows.push(`Store ${s},${d.toISOString().slice(0, 10)},${s * 10 + i}`));
  const info = inspect(readCSV(rows.join("\n")));
  assert.equal(info.timeCol, "date");
  assert.deepEqual(info.groups, ["store"]);
});

test("a year column is the time axis of a long table too", () => {
  const rows = ["year,country,value"];
  for (const c of ["FR", "DE"]) for (let y = 2000; y < 2012; y++) rows.push(`${y},${c},${y % 7}`);
  const info = inspect(readCSV(rows.join("\n")));
  assert.equal(info.timeCol, "year");
  assert.deepEqual(info.groups, ["country"]);
  assert.deepEqual(info.numeric, ["value"]);
});

test("in a file with decimal commas, dots group thousands", () => {
  const { rows } = parseTable("date;units;price\n01/02/2026;1.234;2,5\n02/02/2026;980;3,5\n03/02/2026;2.001;1");
  assert.deepEqual(rows.map((r) => r.units), [1234, 980, 2001]);
  assert.deepEqual(rows.map((r) => r.price), [2.5, 3.5, 1]);
});
