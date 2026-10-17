// CSV loading for the workbench: delimiter and decimal comma, the time column, the series of a long table,
// and rows in time order.
// No DOM here, so it runs in Node tests (web/test/).
import Papa from "papaparse";

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/** A number, or null for a blank or something else. `decimal` is "." or ",". */
export function parseNumber(v, decimal = ".") {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (decimal === "." && NUMBER.test(v)) return +v; // the common case, without the clean-up below
  let s = String(v).trim().replace(/[\s\u00a0\u202f]/g, "");
  if (decimal === ",") s = s.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  return NUMBER.test(s) ? Number(s) : null;
}

const DMY = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?Z?$/;

/** Unix milliseconds in UTC, or NaN. Dates like 05/03/2026 are read day first unless `dayFirst` is false. */
export function parseTime(s, dayFirst = true) {
  const str = String(s ?? "").trim();
  const iso = ISO.exec(str); // the common case, read directly as UTC
  if (iso) {
    const [y, mo, d, hh = 0, mm = 0, ss = 0] = iso.slice(1).map((x) => (x == null ? undefined : +x));
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? Date.UTC(y, mo - 1, d, hh, mm, 0, ss * 1000) : NaN;
  }
  const m = DMY.exec(str);
  if (m) {
    const [a, b, y, hh = 0, mm = 0, ss = 0] = m.slice(1).map((x) => (x == null ? undefined : +x));
    const [d, mo] = dayFirst ? [a, b] : [b, a];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
    return Date.UTC(y, mo - 1, d, hh, mm, ss);
  }
  let t = str.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += "T00:00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) t += "Z";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? Date.parse(str) : ms;
}

/** Whether a column of d/m/y dates puts the day first: yes unless a middle part goes past 12. */
function dayFirst(values) {
  let first = false, second = false;
  for (const v of values) {
    const m = DMY.exec(String(v).trim());
    if (!m) continue;
    first ||= +m[1] > 12;
    second ||= +m[2] > 12;
  }
  return first || !second;
}

/** A numeric column of years: whole numbers in 1000-2999, one per row, named like a year or one apart. */
function isYears(name, values) {
  if (values.length < 2 || !values.every((v) => Number.isInteger(v) && v >= 1000 && v <= 2999)) return false;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.some((v, i) => i && v === sorted[i - 1])) return false;
  return /^(year|yr|years|année|annee|año|jahr)$/i.test(name.trim()) || sorted.every((v, i) => !i || v - sorted[i - 1] === 1);
}

/** Parse CSV text into its header and raw rows: { fields, data, delimiter }. */
export function readCSV(text) {
  const { data, meta } = Papa.parse(String(text).replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: "greedy" });
  const fields = (meta.fields ?? []).filter((f) => f && f.trim());
  if (!data.length || !fields.length) throw new Error("This file has no rows or no header row.");
  return { fields, data, delimiter: meta.delimiter };
}

const isBlank = (v) => v == null || String(v).trim() === "";
const share = (vals, test) => (vals.length ? vals.filter(test).length / vals.length : 0);

/**
 * Work out what each column of a parsed CSV holds, over the whole file.
 * Returns { numeric, values, timeCol, times, groups }: the numeric columns to forecast and each one's value per
 * raw row (parsed once, null where blank or not a number), the time column and each raw row's time (unix seconds,
 * NaN when invalid), and the text columns that name the series of a long table (one row per time and series,
 * like sales by store).
 */
export function inspect({ fields, data, delimiter }) {
  const filled = (f) => data.map((r) => r[f]).filter((v) => !isBlank(v));

  // A column is numeric when 80% of its filled cells are numbers. A decimal comma is only possible when commas do
  // not separate the fields.
  const values = {};
  const numericWith = (f, decimal) => {
    const vals = data.map((r) => parseNumber(r[f], decimal));
    const filledCount = data.reduce((n, r) => n + !isBlank(r[f]), 0);
    return filledCount && vals.reduce((n, v) => n + (v != null), 0) >= filledCount * 0.8 ? vals : null;
  };
  const numeric = fields.filter((f) => (values[f] = numericWith(f, ".") ?? (delimiter !== "," ? numericWith(f, ",") : null)));

  let timeCol = null, times = null;
  for (const f of fields) {
    if (numeric.includes(f)) continue;
    const vals = filled(f), df = dayFirst(vals);
    const ts = data.map((r) => (isBlank(r[f]) ? NaN : parseTime(r[f], df) / 1000));
    if (vals.length && ts.reduce((n, t) => n + Number.isFinite(t), 0) >= vals.length * 0.9) {
      timeCol = f;
      times = ts;
      break;
    }
  }
  if (!timeCol) {
    timeCol = numeric.find((f) => isYears(f, values[f].filter((v) => v != null))) ?? null;
    if (timeCol) times = values[timeCol].map((y) => (y == null ? NaN : Date.UTC(y, 0, 1) / 1000));
  }
  const groups = fields.filter((f) => !numeric.includes(f) && f !== timeCol && isGroupColumn(data, f, times));
  return { numeric: numeric.filter((f) => f !== timeCol), values, timeCol, times, groups };
}

/**
 * Whether a text column names the series of a long table: 2 to 1,000 names with at least 8 rows each, and either
 * the times repeat across names but not within one, or (without a time column) each name's rows come in one block.
 */
function isGroupColumn(data, f, times) {
  const keys = data.map((r) => String(r[f] ?? "").trim());
  if (share(keys, Boolean) < 0.9) return false;
  const names = new Set(keys.filter(Boolean));
  if (names.size < 2 || names.size > 1000 || data.length / names.size < 8) return false;
  if (times) {
    const valid = keys.map((k, i) => [k, times[i]]).filter(([k, t]) => k && Number.isFinite(t));
    const pairs = new Set(valid.map(([k, t]) => `${k}\u0000${t}`)).size;
    return new Set(valid.map(([, t]) => t)).size <= valid.length * 0.6 && pairs >= valid.length * 0.99;
  }
  const blocks = keys.filter((k, i) => k && k !== keys[i - 1]).length;
  return blocks === names.size;
}

/** The names in a group column, in the order they first appear. */
export const groupKeys = ({ data }, f) => [...new Set(data.map((r) => String(r[f] ?? "").trim()).filter(Boolean))];

/**
 * One series of a parsed CSV: the rows where `group` is `key` (every row when `group` is null), sorted by time.
 * Returns { fields, rows, timeCol, times, notes }: rows hold numbers or null, times are unix seconds or null,
 * notes are short remarks for the user (reordered rows, dropped rows, uneven steps).
 */
export function buildTable({ data }, { numeric, values, timeCol, times }, group = null, key = null) {
  if (!numeric.length) throw new Error("This file has no numeric columns.");
  const notes = [];
  let order = data.map((r, i) => i);
  if (group) order = order.filter((i) => String(data[i][group] ?? "").trim() === key);
  if (!order.length) throw new Error(`No rows for “${key}”.`);
  if (times) {
    const all = order.length;
    order = order.filter((i) => Number.isFinite(times[i]));
    const dropped = all - order.length;
    if (dropped) notes.push(`${dropped.toLocaleString()} row${dropped > 1 ? "s" : ""} without a valid time left out`);
    if (order.some((i, k) => k && times[i] < times[order[k - 1]])) {
      order.sort((a, b) => times[a] - times[b]);
      notes.push("rows sorted by time");
    }
    const diffs = order.slice(1).map((i, k) => times[i] - times[order[k]]);
    const repeats = diffs.filter((d) => d === 0).length;
    if (repeats) notes.push(`${repeats.toLocaleString()} repeated time${repeats > 1 ? "s" : ""}`);
    const step = median(diffs.filter((d) => d > 0));
    // Months and years vary in length, so only flag steps well off the usual one.
    const uneven = diffs.filter((d) => d > 0 && Math.abs(d - step) > step * 0.15).length;
    if (step && uneven > diffs.length * 0.01) notes.push("uneven time steps, read as evenly spaced");
  }
  return {
    fields: numeric,
    rows: order.map((i) => Object.fromEntries(numeric.map((f) => [f, values[f][i]]))),
    timeCol,
    times: times ? order.map((i) => times[i]) : null,
    notes,
  };
}

/** Parse a CSV into one table: readCSV, inspect and buildTable in one call. */
export function parseTable(text, group = null, key = null) {
  const csv = readCSV(text);
  return buildTable(csv, inspect(csv), group, key);
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

const DAY = 86400;

/**
 * The seasonal cycle a naive guess repeats, from the usual time step: a day for sub-daily data, a week for
 * daily data, a year for weekly, monthly and quarterly data. { m: steps per cycle, name } or { m: 1 }.
 */
export function season(times) {
  if (!times || times.length < 3) return { m: 1, name: null };
  const step = median(times.slice(1).map((t, i) => t - times[i]).filter((d) => d > 0));
  if (!step) return { m: 1, name: null };
  const perDay = DAY / step;
  if (step < DAY * 0.9 && perDay <= 1440 && Math.abs(perDay - Math.round(perDay)) < 0.01) return { m: Math.round(perDay), name: "day" };
  if (Math.abs(step - DAY) < DAY * 0.1) return { m: 7, name: "week" };
  if (Math.abs(step - 7 * DAY) < DAY * 0.5) return { m: 52, name: "year" };
  if (step >= 27 * DAY && step <= 32 * DAY) return { m: 12, name: "year" };
  if (step >= 88 * DAY && step <= 93 * DAY) return { m: 4, name: "year" };
  return { m: 1, name: null };
}
