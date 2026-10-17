// Forecast scores against what happened, and the naive guesses they are compared with. No DOM, tested in web/test/.

const lastObserved = (context) => context.findLast((x) => x != null) ?? null;

/** Repeat the last full cycle of `m` steps over `h` steps; the last value when the history is shorter. */
export function seasonalNaive(context, h, m) {
  const last = lastObserved(context);
  const n = context.length;
  return Array.from({ length: h }, (_, i) => (m > 1 && n >= m ? context[n - m + (i % m)] ?? last : last));
}

/** MASE denominator: the mean error of the one-cycle-back guess over the history, or null if there is none. */
export function maseScale(context, m) {
  const lag = Math.max(1, m);
  let sum = 0, count = 0;
  for (let t = lag; t < context.length; t++) {
    if (context[t] == null || context[t - lag] == null) continue;
    sum += Math.abs(context[t] - context[t - lag]);
    count++;
  }
  return count && sum > 0 ? sum / count : null;
}

/**
 * Score a forecast. actual, context: variates x steps (null where missing). q: variates x 5 levels
 * (q10, q25, q50, q75, q90) x steps. m: season length for the seasonal naive guess and MASE.
 * Returns { mae, naive, seasonal, mase, coverage, count } or null when nothing can be checked.
 */
export function score(actual, q, context, m = 1) {
  let err = 0, naive = 0, seasonal = 0, inside = 0, count = 0;
  const mases = [];
  actual.forEach((a, v) => {
    const last = lastObserved(context[v]);
    const guess = seasonalNaive(context[v], a.length, m);
    let e = 0, n = 0;
    a.forEach((y, i) => {
      if (y == null || last == null) return;
      n++;
      e += Math.abs(q[v][2][i] - y);
      naive += Math.abs(last - y);
      seasonal += Math.abs(guess[i] - y);
      inside += y >= q[v][0][i] && y <= q[v][4][i];
    });
    const scale = maseScale(context[v], m);
    if (n && scale) mases.push(e / n / scale);
    err += e;
    count += n;
  });
  if (!count) return null;
  return {
    mae: err / count, naive: naive / count, seasonal: seasonal / count, count,
    mase: mases.length ? mases.reduce((a, b) => a + b, 0) / mases.length : null,
    coverage: inside / count,
  };
}

/** Pool several scores (one per forecast start), weighting each by the points it checked. */
export function pool(scores) {
  const ok = scores.filter(Boolean);
  const count = ok.reduce((s, x) => s + x.count, 0);
  if (!count) return null;
  const mean = (k) => ok.reduce((s, x) => s + x[k] * x.count, 0) / count;
  const mases = ok.filter((x) => x.mase != null);
  return {
    mae: mean("mae"), naive: mean("naive"), seasonal: mean("seasonal"), coverage: mean("coverage"), count,
    mase: mases.length ? mases.reduce((s, x) => s + x.mase, 0) / mases.length : null,
  };
}

/** Percent change in error from `before` to `after`, rounded; null when `before` is zero. */
export const change = (after, before) => (before > 0 ? Math.round((after / before - 1) * 100) : null);
