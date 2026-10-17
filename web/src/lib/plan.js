// Planning numbers from a forecast's 21 quantiles: a service level, totals over a period, scenarios on known
// covariates, and the outlook used to rank many series. No DOM, tested in web/test/.
import { LEVELS } from "./timestral.js";

const MEDIAN = LEVELS.indexOf(0.5);
const LOW = LEVELS.indexOf(0.1), HIGH = LEVELS.indexOf(0.9);

/** The levels a plan can be made for: from the median up to 99%. */
export const SERVICE_LEVELS = LEVELS.filter((l) => l >= 0.5);

/** Index in LEVELS of the level closest to `level`. */
export function levelIndex(level) {
  let best = MEDIAN;
  LEVELS.forEach((l, i) => { if (Math.abs(l - level) < Math.abs(LEVELS[best] - level)) best = i; });
  return best;
}

/**
 * Add up (or average) one series' forecast over steps [from, to). full: steps x 21 quantiles.
 * Returns { median, low, high, plan, steps }: the median, the 80% range (q10 to q90) and the `level` quantile.
 * Each is the sum of that quantile over the steps, so the range assumes all the steps run high or low together:
 * it is on the wide side, never too narrow.
 */
export function summarize(full, from, to, level, mode = "sum") {
  const rows = full.slice(Math.max(0, from), Math.max(0, to));
  if (!rows.length) return null;
  const k = levelIndex(level);
  const add = (i) => rows.reduce((s, qs) => s + qs[i], 0) / (mode === "mean" ? rows.length : 1);
  return { median: add(MEDIAN), low: add(LOW), high: add(HIGH), plan: add(k), steps: rows.length };
}

/**
 * A scenario on known covariates: { [column]: { mode, value, from, to } }, where mode is "set" (to `value`) or
 * "change" (by `value` percent), over steps `from` to `to` past the end of the data (1 is the first step ahead).
 * An edit is active when its mode is one of those and its value is a number.
 */
export const isActive = (edit) => !!edit && (edit.mode === "set" || edit.mode === "change") && Number.isFinite(edit.value);
export const hasScenario = (scenario) => Object.values(scenario ?? {}).some(isActive);

/** Apply one covariate's edit to its values (indexed by row, `end` is the first row past the data). A copy. */
export function applyEdit(values, end, edit) {
  if (!isActive(edit)) return values;
  const out = values.slice();
  const a = end + Math.max(1, Math.round(edit.from) || 1) - 1;
  const b = Math.min(out.length, end + (Math.round(edit.to) || out.length));
  for (let i = Math.max(0, a); i < b; i++) {
    out[i] = edit.mode === "set" ? edit.value : out[i] == null ? null : out[i] * (1 + edit.value / 100);
  }
  return out;
}

/**
 * The outlook of one series for ranking: the last `h` steps of history against the forecast of the next `h`.
 * history: the series up to the end of the data (null where missing). full: h x 21 quantiles from the end.
 * Returns { last, next, low, high, growth, spread }: totals, the change from last to next, and the 80% range
 * width as a share of the next total. A missing value in the last steps counts as their average.
 */
export function outlook(history, full, h) {
  const recent = history.slice(-h).filter((v) => v != null);
  const last = recent.length ? (recent.reduce((s, v) => s + v, 0) / recent.length) * Math.min(h, history.length) : null;
  const sum = summarize(full, 0, h, 0.5);
  if (!sum) return null;
  return {
    last, next: sum.median, low: sum.low, high: sum.high,
    growth: last > 0 ? sum.median / last - 1 : null,
    spread: sum.median > 0 ? (sum.high - sum.low) / sum.median : null,
  };
}
