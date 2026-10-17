// Timestral forecasting with onnxruntime, a JS port of TimestralForecaster.forecast
// (timestral/forecaster.py) on top of the step graph from scripts/export_onnx.py.
// Works with onnxruntime-web in the browser and onnxruntime-node in tests: pass the module in.

const PS = 32; // patch size
const BLOCK = 32; // max patches per graph call (1024 steps)
const Q = 21; // quantile levels 0.01 ... 0.99
const MEDIAN = 10;
const ROLE = { target: 0, past: 1, known: 2 };
const CAP_K = 1e4;
const EXTREME = 1e30;
export const LEVELS = [0.01, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99];
export const MAX_CONTEXT = 4096; // the models accept 32768; attention cost grows with the square of this

const finite = (v) => v != null && Number.isFinite(v);

/** Forward-fill unobserved positions; leading unobserved positions become 0. */
function ffill(values, mask) {
  let last = 0;
  return values.map((v, i) => (mask[i] ? (last = v) : last));
}

/** Stack target and covariate rows like TimestralForecaster._assemble_rows, for one series. */
function assemble(target, past, known, horizon, sign) {
  const t = target[0].length;
  const rows = [], masks = [], roles = [], future = [], futureMask = [];
  const add = (vals, role, fut) => {
    const m = vals.map(finite);
    const x = vals.map((v, i) => (m[i] ? sign * v : 0));
    rows.push(role === ROLE.target ? ffill(x, m) : x);
    masks.push(m);
    roles.push(role);
    future.push(fut ? fut.map((v) => (finite(v) ? sign * v : 0)) : null);
    futureMask.push(fut ? fut.map(finite) : null);
  };
  target.forEach((r) => add(r, ROLE.target));
  (past ?? []).forEach((r) => add(r, ROLE.past));
  (known ?? []).forEach((r) => add(r.slice(0, t), ROLE.known, r.slice(t, t + horizon)));
  return { rows, masks, roles, future, futureMask };
}

/** Keep the last `max` steps, then left-pad to a multiple of the patch size (padding unobserved). */
function window(rows, masks, max) {
  const t = Math.min(rows[0].length, max);
  const len = Math.ceil(t / PS) * PS;
  const pad = len - t;
  return {
    rows: rows.map((r) => [...Array(pad).fill(0), ...r.slice(-t)]),
    masks: masks.map((m) => [...Array(pad).fill(false), ...m.slice(-t)]),
  };
}

export async function loadModel(ort, url, options = {}) {
  return ort.InferenceSession.create(url, { executionProviders: ["wasm"], ...options });
}

/**
 * Forecast one series.
 * target: V x T (null/NaN = missing). pastCovariates: C x T. knownCovariates: C x (T + horizon).
 * Returns { quantiles: V x horizon x 21, levels }.
 */
export async function forecast(ort, session, { target, horizon, pastCovariates = null, knownCovariates = null,
  symmetric = true, clipNonnegative = true, maxContext = MAX_CONTEXT }) {
  const nTgt = target.length;
  // The mirrored pass (forecast of -context, covariates negated) runs in the same batch as group 1.
  const passes = symmetric ? [1, -1] : [1];
  const parts = passes.map((s) => assemble(target, pastCovariates, knownCovariates, horizon, s));
  const nRows = parts[0].rows.length;
  const roles = parts.flatMap((p) => p.roles);
  const groups = parts.flatMap((p, g) => p.rows.map(() => g));
  const futureLen = Math.ceil(horizon / PS) * PS;
  const futureRow = (p, k) => Array.from({ length: futureLen }, (_, i) => (p.future[k] && i < horizon ? p.future[k][i] : 0));
  const futureMaskRow = (p, k) => Array.from({ length: futureLen }, (_, i) => !!(p.futureMask[k] && i < horizon && p.futureMask[k][i]));
  const kf = parts.flatMap((p) => p.rows.map((_, k) => futureRow(p, k)));
  const kfm = parts.flatMap((p) => p.rows.map((_, k) => futureMaskRow(p, k)));

  let { rows: context, masks: mask } = window(parts.flatMap((p) => p.rows), parts.flatMap((p) => p.masks), maxContext);
  const firstContext = context, firstMask = mask;
  const r = context.length;
  const out = Array.from({ length: r }, () => []); // per row: list of [21] quantile vectors
  let lastScale = null;
  let remaining = Math.ceil(horizon / PS), offset = 0;

  while (remaining > 0) {
    const block = Math.min(BLOCK, remaining), blen = block * PS;
    const t = context[0].length;
    const feeds = {
      x: new ort.Tensor("float32", Float32Array.from(context.flat()), [r, t]),
      obs: new ort.Tensor("bool", Uint8Array.from(mask.flat(), Number), [r, t]),
      group_ids: new ort.Tensor("int64", BigInt64Array.from(groups, BigInt), [r]),
      role_ids: new ort.Tensor("int64", BigInt64Array.from(roles, BigInt), [r]),
      // Their length sets the block length the graph decodes.
      known_future: new ort.Tensor("float32", Float32Array.from(kf.flatMap((row) => row.slice(offset, offset + blen))), [r, blen]),
      known_future_mask: new ort.Tensor("bool", Uint8Array.from(kfm.flatMap((row) => row.slice(offset, offset + blen)), Number), [r, blen]),
    };
    const res = await session.run(feeds);
    const q = res.quantiles.data; // (r, blen, 21)
    if (!lastScale) lastScale = Array.from(res.last_scale.data, Number);
    for (let i = 0; i < r; i++) for (let s = 0; s < blen; s++) {
      const base = (i * blen + s) * Q;
      out[i].push(Array.from(q.subarray(base, base + Q)));
    }
    remaining -= block;
    if (remaining <= 0) break;
    // Feed the block back: targets their median, known covariates their real future, past covariates a blank.
    context = context.map((row, i) => {
      const fb = Array.from({ length: blen }, (_, s) => {
        if (roles[i] === ROLE.known) return kf[i][offset + s];
        if (roles[i] === ROLE.past) return 0;
        const v = out[i][offset + s][MEDIAN];
        return Number.isFinite(v) && Math.abs(v) < EXTREME ? v : 0;
      });
      return row.concat(fb);
    });
    mask = mask.map((row, i) => row.concat(Array.from({ length: blen }, (_, s) =>
      roles[i] === ROLE.known ? kfm[i][offset + s] : roles[i] !== ROLE.past)));
    offset += blen;
    if (context[0].length > maxContext) {
      const keep = Math.max(PS, Math.floor(maxContext / PS) * PS);
      context = context.map((row) => row.slice(-keep));
      mask = mask.map((row) => row.slice(-keep));
    }
  }

  // Per pass: cap quantiles to the context range +/- CAP_K last-patch scales (TimestralForecaster._cap_quantiles).
  const passQuantiles = passes.map((_, g) => Array.from({ length: nTgt }, (_, v) => {
    const i = g * nRows + v;
    let lo = Infinity, hi = -Infinity;
    firstContext[i].forEach((x, k) => { if (firstMask[i][k]) { lo = Math.min(lo, x); hi = Math.max(hi, x); } });
    if (lo === Infinity) lo = hi = 0;
    const span = lastScale[i] * CAP_K;
    return out[i].slice(0, horizon).map((qs) => qs.map((x) => Math.min(Math.max(x, lo - span), hi + span)));
  }));

  let quantiles = passQuantiles[0];
  if (symmetric) {
    const mirrored = passQuantiles[1];
    quantiles = quantiles.map((series, v) => series.map((qs, h) =>
      qs.map((x, k) => 0.5 * (x - mirrored[v][h][Q - 1 - k]))));
  }
  if (clipNonnegative) {
    quantiles = quantiles.map((series, v) => {
      const observed = target[v].filter(finite);
      return observed.length && observed.every((x) => x >= 0) ? series.map((qs) => qs.map((x) => Math.max(0, x))) : series;
    });
  }
  if (quantiles.some((s) => s.some((qs) => qs.some(Number.isNaN)))) {
    throw new Error("The forecast produced NaN values. The input may be degenerate (for example, constant or empty).");
  }
  return { quantiles, levels: LEVELS };
}
