// HTML for the result panels: metrics, backtest, plan, scenario and the series ranking. Each function takes plain
// data and returns a string; app.js owns the state and puts the strings in the page.

export const fmt = (v) => (v == null || !Number.isFinite(v) ? "–" : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : +v.toPrecision(3));
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const pct = (v) => `${Math.round(v * 100)}%`;
/** A signed percent change, colored when `good` says which way is better (1 up, -1 down, 0 neither). */
export const signed = (ratio, good = 0) => {
  if (ratio == null || !Number.isFinite(ratio)) return "–";
  const p = Math.round(ratio * 100), cls = !p || !good ? "" : p * good > 0 ? "good" : "bad";
  return `<span class="${cls}">${p > 0 ? "+" : ""}${p}%</span>`;
};
/** "12% lower than", for a percent change in error; empty when there is nothing to compare. */
export const versus = (d) => (d == null ? "" : d === 0 ? "about the same as" : d < 0
  ? `<b class="good">${-d}% lower</b> than` : `<b class="bad">${d}% higher</b> than`);

/** The naive guess to beat: the last seasonal cycle when the data has one, the last value otherwise. */
export const naive = (season) => ({
  name: season.m > 1 ? `repeating the last ${season.name}` : "repeating the last value",
  error: (m) => (season.m > 1 ? m.seasonal : m.naive),
});

export function metricsHTML(m, season) {
  const { name, error } = naive(season);
  return `
    <div><dt>Average error</dt><dd>${fmt(m.mae)}</dd><small>Median forecast against what happened</small></div>
    <div><dt>${name[0].toUpperCase() + name.slice(1)}</dt><dd>${fmt(error(m))}</dd><small>The same error for a naive guess</small></div>
    <div><dt>Scaled error</dt><dd>${m.mase == null ? "–" : m.mase.toFixed(2)}</dd><small>MASE: under 1 beats a naive guess on the history</small></div>
    <div><dt>Inside the 80% range</dt><dd>${pct(m.coverage)}</dd><small>About 80% means the range is honest</small></div>`;
}

/**
 * Backtest table. rows: [{ at, label, s, s0 }] with scores from metrics.js (s0 without covariates, or null).
 * current: the row of the forecast start in view.
 */
export function backtestTableHTML(rows, season, covs, current) {
  const { error } = naive(season);
  const cell = (v, digits) => (v == null ? "–" : digits ? v.toFixed(digits) : fmt(v));
  return `<thead><tr><th>Start</th><th>Error</th><th>Naive</th><th>MASE</th><th>In 80%</th>`
    + `${covs ? "<th>No covariates</th>" : ""}</tr></thead><tbody>`
    + rows.map(({ at, label, s, s0 }) => `<tr data-at="${at}"${at === current ? ' class="current"' : ""}>`
      + `<td><button type="button" class="link">${esc(label)}</button></td><td>${cell(s?.mae)}</td>`
      + `<td>${cell(s && error(s))}</td><td>${cell(s?.mase, 2)}</td><td>${s ? pct(s.coverage) : "–"}</td>`
      + `${covs ? `<td>${cell(s0?.mae)}</td>` : ""}</tr>`).join("") + "</tbody>";
}

/**
 * Plan table: one row per forecast column. rows: [{ label, sum, scenario }] with summaries from plan.js
 * (scenario null when there is none). level: the service level; mean: averages instead of totals.
 */
export function planTableHTML(rows, level, mean) {
  const withScenario = rows.some((r) => r.scenario);
  const what = mean ? "Average" : "Total";
  return `<thead><tr><th>Series</th><th>${what}, most likely</th><th>80% range</th><th>Plan at ${pct(level)}</th>`
    + `${withScenario ? "<th>Scenario</th><th>Change</th>" : ""}</tr></thead><tbody>`
    + rows.map(({ label, sum, scenario }) => `<tr><td>${esc(label)}</td><td><b>${fmt(sum.median)}</b></td>`
      + `<td>${fmt(sum.low)} to ${fmt(sum.high)}</td><td><b>${fmt(sum.plan)}</b></td>`
      + (withScenario ? `<td>${fmt(scenario?.median)}</td><td>${scenario ? signed(scenario.median / sum.median - 1) : "–"}</td>` : "")
      + "</tr>").join("") + "</tbody>";
}

/**
 * Scenario editor: one row per known covariate. edits: [{ col, edit, future }], where edit is { mode, value,
 * from, to } and future counts the values the file has past the end of the data. h: steps ahead.
 */
export function scenarioEditsHTML(edits, h) {
  return edits.map(({ col, edit, future }) => {
    const off = edit.mode !== "set" && edit.mode !== "change";
    const option = (value, text) => `<option value="${value}"${edit.mode === value ? " selected" : ""}>${text}</option>`;
    const note = future ? "" : `<small>No values past the end of the data: “set to” gives the model some.</small>`;
    return `<div class="edit" data-col="${esc(col)}">
      <span class="edit-name">${esc(col)}</span>
      <select data-key="mode" aria-label="How to change ${esc(col)}">${option("file", "as in the file")}${option("set", "set to")}${option("change", "change by %")}</select>
      <input type="number" step="any" data-key="value" aria-label="Value" value="${edit.value ?? ""}"${off ? " disabled" : ""}>
      <span class="edit-steps">steps <input type="number" min="1" max="${h}" data-key="from" aria-label="From step" value="${edit.from ?? 1}"${off ? " disabled" : ""}>
      to <input type="number" min="1" max="${h}" data-key="to" aria-label="To step" value="${Math.min(edit.to ?? h, h)}"${off ? " disabled" : ""}></span>
      ${note}
    </div>`;
  }).join("");
}

export const RANK_COLUMNS = [
  ["name", "Series"], ["last", "Last period"], ["next", "Next period"], ["growth", "Change"], ["spread", "80% range"], ["mase", "MASE"],
];

/**
 * Series ranking. rows: [{ name, last, next, growth, spread, mase, error }]; sort: { by, dir } with dir 1 or -1;
 * current: the series in view.
 */
export function rankTableHTML(rows, sort, current) {
  const value = (r) => r[sort.by] ?? (sort.dir > 0 ? Infinity : -Infinity);
  const sorted = [...rows].sort((a, b) => (sort.by === "name" ? a.name.localeCompare(b.name) * sort.dir
    : (value(a) > value(b) ? 1 : value(a) < value(b) ? -1 : 0) * sort.dir));
  const head = RANK_COLUMNS.map(([key, text]) => {
    const on = key === sort.by, arrow = on ? (sort.dir > 0 ? " ↑" : " ↓") : "";
    return `<th aria-sort="${on ? (sort.dir > 0 ? "ascending" : "descending") : "none"}"><button type="button" class="sort" data-sort="${key}">${text}${arrow}</button></th>`;
  }).join("");
  return `<thead><tr>${head}</tr></thead><tbody>` + sorted.map((r) => `<tr${r.name === current ? ' class="current"' : ""}>`
    + `<td><button type="button" class="link" data-key="${esc(r.name)}">${esc(r.name)}</button></td>`
    + (r.error ? `<td colspan="5" class="muted">${esc(r.error)}</td>`
      : `<td>${fmt(r.last)}</td><td><b>${fmt(r.next)}</b></td><td>${signed(r.growth, 1)}</td>`
        + `<td>${r.spread == null ? "–" : `±${Math.round(r.spread * 50)}%`}</td><td>${r.mase == null ? "–" : r.mase.toFixed(2)}</td>`)
    + "</tr>").join("") + "</tbody>";
}

/**
 * Anomaly list. points: from anomalies.js, most unusual first; when(row) names a row's time; names: the forecast
 * columns (a Series column shows when there are several). Shows the first `limit`.
 */
export function anomalyTableHTML(points, when, names, limit = 200) {
  const multi = names.length > 1;
  return `<thead><tr><th>When</th>${multi ? "<th>Series</th>" : ""}<th>Value</th><th>Expected</th><th>Range</th><th>Off by</th></tr></thead><tbody>`
    + points.slice(0, limit).map((p) => `<tr data-row="${p.row}">`
      + `<td><button type="button" class="link">${esc(when(p.row))}</button></td>${multi ? `<td>${esc(names[p.v])}</td>` : ""}`
      + `<td><b class="${p.value > p.high ? "high" : "low"}">${fmt(p.value)}</b></td><td>${fmt(p.median)}</td>`
      + `<td>${fmt(p.low)} to ${fmt(p.high)}</td><td>${p.value > p.high ? "+" : "−"}${p.off < 10 ? p.off.toFixed(1) : Math.round(p.off)}×</td></tr>`).join("")
    + "</tbody>";
}
