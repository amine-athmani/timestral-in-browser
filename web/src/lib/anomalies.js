// Anomalies: points that fell outside the range a forecast gave them, wherever a forecast can be checked against
// what happened (the current run and the backtest). No DOM, tested in web/test/.
import { LEVELS } from "./timestral.js";

/** The ranges a point can be checked against, and their quantiles in LEVELS. */
export const RANGES = { 0.8: [0.1, 0.9], 0.9: [0.05, 0.95], 0.98: [0.01, 0.99] };

/**
 * Find the points outside the `level` range (0.8, 0.9 or 0.98).
 * windows: [{ at, actual, full }], one per checked forecast: `at` is the row of its first step, actual is
 * variates x steps (null where missing), full is variates x steps x 21 quantiles. A row checked by several windows
 * counts once, judged by the window that forecast it the fewest steps ahead (the first such window on a tie), so
 * the result does not depend on which windows are long.
 * Returns { points, checked }: points as { row, v, value, median, low, high, off }, most unusual first, where `off`
 * is how far outside the range the value fell, in widths of the range's half on that side (0.5 = half that far
 * again); checked is the number of distinct points that could be checked.
 */
export function findAnomalies(windows, level = 0.98) {
  const [lo, hi] = (RANGES[level] ?? RANGES[0.98]).map((l) => LEVELS.indexOf(l));
  const mid = LEVELS.indexOf(0.5);
  const best = new Map(); // "v:row" -> { lead, point (null when inside the range) }
  for (const { at, actual, full } of windows) {
    actual.forEach((series, v) => series.forEach((value, i) => {
      const qs = full[v]?.[i];
      if (value == null || !qs) return;
      const key = `${v}:${at + i}`;
      if (best.has(key) && best.get(key).lead <= i) return;
      const low = qs[lo], high = qs[hi], median = qs[mid];
      let point = null;
      if (value < low || value > high) {
        const side = value > high ? high - median : median - low;
        const off = (value > high ? value - high : low - value) / Math.max(side, Math.abs(median) * 1e-9, 1e-12);
        point = { row: at + i, v, value, median, low, high, off };
      }
      best.set(key, { lead: i, point });
    }));
  }
  const points = [...best.values()].map((b) => b.point).filter(Boolean);
  points.sort((a, b) => b.off - a.off);
  return { points, checked: best.size };
}
