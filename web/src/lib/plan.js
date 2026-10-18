// Planning numbers from a forecast's 21 quantiles: a service level, totals over a period, scenarios on known
// covariates, and the outlook used to rank many series. No DOM, tested in web/test/.
import { LEVELS } from "./timestral.js";

const MEDIAN = LEVELS.indexOf(0.5);

/** The levels a plan can be made for: from the median up to 99%. */
export const SERVICE_LEVELS = LEVELS.filter((l) => l >= 0.5);

/** Index in LEVELS of the level closest to `level`. */
export function levelIndex(level) {
  let best = MEDIAN;
  LEVELS.forEach((l, i) => { if (Math.abs(l - level) < Math.abs(LEVELS[best] - level)) best = i; });
  return best;
}

/* ---------- Totals over a period ---------- */

// The model gives each step's distribution, not how the steps move together, and the total depends on that: if
// every step runs high at once the total's range is the sum of the steps' ranges; if they are independent it is
// far narrower. Totals here come from simulated paths that follow each step's 21 quantiles, with consecutive steps
// linked by a Gaussian AR(1) copula of correlation `rho` (0: independent, 1: all together). stepCorrelation()
// measures rho from how the forecast's errors moved together where it can be checked against what happened.

const PATHS = 1000;
const Z = 4, PER = 10; // the simulation's grid of normal scores: -4 to 4 in steps of 0.1

/** Standard normal CDF (Abramowitz and Stegun 7.1.26, absolute error under 1.5e-7). */
function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Inverse standard normal CDF (Acklam's approximation, relative error under 1.2e-9). */
export function normInv(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const LAST = LEVELS.length - 1;
/** Where probability `u` falls among LEVELS: the index below it (0.01, 0.05, 0.10, ..., 0.95, 0.99). */
const below = (u) => (u < 0.05 ? 0 : u >= 0.95 ? LAST - 1 : Math.min(LAST - 2, Math.floor((u + 1e-9) / 0.05)));

/** A step's value at probability `u`, between its quantiles; flat beyond the 1% and 99% ones. */
function quantileAt(qs, u) {
  if (u <= LEVELS[0]) return qs[0];
  if (u >= LEVELS[LAST]) return qs[LAST];
  const k = below(u);
  return qs[k] + ((u - LEVELS[k]) / (LEVELS[k + 1] - LEVELS[k])) * (qs[k + 1] - qs[k]);
}

/** The probability a step's forecast gives to values below `y`, kept within 0.5% of 0 and 1. */
function probabilityOf(qs, y) {
  if (y <= qs[0]) return 0.005;
  if (y >= qs[LAST]) return 0.995;
  let k = 0;
  while (k < LAST - 1 && qs[k + 1] <= y) k++;
  const span = qs[k + 1] - qs[k];
  return LEVELS[k] + (span > 0 ? (y - qs[k]) / span : 0.5) * (LEVELS[k + 1] - LEVELS[k]);
}

/**
 * How much the forecast's errors carry over from one step to the next, from the steps that can be checked.
 * actual: what happened (null where missing), full: the forecast's quantiles for the same steps.
 * Each checked step becomes a normal score (its actual's probability under the forecast); rho is the lag-1
 * correlation of those scores around zero, the forecast's own median, so a forecast that is off in the same
 * direction for many steps counts as steps moving together. Null with fewer than 10 pairs; clamped to 0..1.
 */
export function stepCorrelation(actual, full) {
  const z = actual.map((y, t) => (y == null || !full[t] ? null : normInv(probabilityOf(full[t], y))));
  let ab = 0, aa = 0, bb = 0, pairs = 0;
  for (let t = 1; t < z.length; t++) {
    if (z[t - 1] == null || z[t] == null) continue;
    ab += z[t - 1] * z[t];
    aa += z[t - 1] ** 2;
    bb += z[t] ** 2;
    pairs++;
  }
  if (pairs < 10 || !aa || !bb) return null;
  return Math.max(0, Math.min(1, ab / Math.sqrt(aa * bb)));
}

/** Seeded uniform random numbers (mulberry32), so totals do not change between redraws. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const simulated = new WeakMap(); // forecast quantiles -> Map("from:to:rho" -> sorted path totals)

/** Path totals over steps [from, to) of `full`, sorted. Cached per forecast, so the plan slider stays instant. */
function pathTotals(full, from, to, rho) {
  const key = `${from}:${to}:${rho}`;
  if (!simulated.has(full)) simulated.set(full, new Map());
  const memo = simulated.get(full);
  if (memo.has(key)) return memo.get(key);
  const rnd = random(20260101);
  // Box-Muller gives two independent normals per pair of uniforms; keep the second for the next call.
  let spare = null;
  const gauss = () => {
    if (spare != null) { const z = spare; spare = null; return z; }
    const r = Math.sqrt(-2 * Math.log(1 - rnd())), a = 2 * Math.PI * rnd();
    spare = r * Math.sin(a);
    return r * Math.cos(a);
  };
  const keep = Math.sqrt(1 - rho * rho);
  // Each step's value against the normal score z, on a grid from -Z to Z, so the loop below reads one table.
  const steps = to - from, width = 2 * Z * PER + 1;
  const table = new Float64Array(steps * width);
  for (let t = 0; t < steps; t++) for (let i = 0; i < width; i++) table[t * width + i] = quantileAt(full[from + t], normCdf(i / PER - Z));
  const totals = new Float64Array(PATHS);
  for (let p = 0; p < PATHS; p++) {
    let z = gauss(), sum = 0;
    for (let t = 0; t < steps; t++) {
      if (t) z = rho * z + keep * gauss();
      const x = Math.min(width - 1.000001, Math.max(0, (z + Z) * PER)), i = x | 0, base = t * width + i;
      sum += table[base] + (x - i) * (table[base + 1] - table[base]);
    }
    totals[p] = sum;
  }
  totals.sort();
  memo.set(key, totals);
  return totals;
}

/**
 * Add up (or average) one series' forecast over steps [from, to). full: steps x 21 quantiles.
 * rho: how the steps move together (see stepCorrelation); 1, the default, adds up each step's quantiles.
 * Returns { median, low, high, plan, steps }: the total's median, its 80% range (10% to 90%) and its `level`
 * quantile, the amount that covers the whole period's total that often.
 */
export function summarize(full, from, to, level, mode = "sum", rho = 1) {
  from = Math.max(0, from);
  to = Math.min(full.length, Math.max(from, to));
  const steps = to - from;
  if (!steps) return null;
  const per = mode === "mean" ? steps : 1;
  let at;
  if (rho >= 1) {
    // Every step at the same probability: the total's quantile is the sum of the steps' quantiles.
    at = (p) => { let s = 0; for (let t = from; t < to; t++) s += quantileAt(full[t], p); return s; };
  } else {
    const totals = pathTotals(full, from, to, Math.max(0, rho));
    at = (p) => totals[Math.round(p * (PATHS - 1))];
  }
  return { median: at(0.5) / per, low: at(0.1) / per, high: at(0.9) / per, plan: at(level) / per, steps };
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
 * rho: how the steps move together, as in summarize().
 * Returns { last, next, low, high, growth, spread }: totals, the change from last to next, and the 80% range
 * width as a share of the next total. A missing value in the last steps counts as their average.
 */
export function outlook(history, full, h, rho = 1) {
  const recent = history.slice(-h).filter((v) => v != null);
  const last = recent.length ? (recent.reduce((s, v) => s + v, 0) / recent.length) * Math.min(h, history.length) : null;
  const sum = summarize(full, 0, h, 0.5, "sum", rho);
  if (!sum) return null;
  return {
    last, next: sum.median, low: sum.low, high: sum.high,
    growth: last > 0 ? sum.median / last - 1 : null,
    spread: sum.median > 0 ? (sum.high - sum.low) / sum.median : null,
  };
}
