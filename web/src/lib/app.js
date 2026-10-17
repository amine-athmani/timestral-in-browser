import Papa from "papaparse";
import { BASE, DATA_URL, SERVER, modelUrl } from "./config.js";
import { fanChart, align } from "./chart.js";
import { LEVELS, MAX_CONTEXT as BROWSER_CONTEXT } from "./timestral.js";
import { readCSV, inspect, buildTable, groupKeys, season, median } from "./data.js";
import { score, pool, change } from "./metrics.js";
import { SERVICE_LEVELS, levelIndex, summarize, stepCorrelation, applyEdit, isActive, hasScenario, outlook } from "./plan.js";
import { encodeSettings, decodeSettings } from "./settings.js";
import { fmt, esc, pct, versus, naive, metricsHTML, backtestTableHTML, planTableHTML, scenarioEditsHTML, rankTableHTML } from "./views.js";
import { printReport } from "./report.js";

const $ = (s) => document.querySelector(s);

// In the browser build the model runs in a Web Worker; the Docker build asks the Python server instead.
const MAX_CONTEXT = SERVER ? 16384 : BROWSER_CONTEXT;
const worker = SERVER ? null : new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
worker?.postMessage({ init: { urls: { "5M": modelUrl("5M"), "28M": modelUrl("28M") } } });
const SHOWN = [0.1, 0.25, 0.5, 0.75, 0.9].map((l) => LEVELS.indexOf(l));
const MEDIAN = LEVELS.indexOf(0.5);
let nextId = 0;
let gen = 0; // bumped on every run; results from older runs are dropped

let source = null; // the open file, parsed once: { name, example, csv, info }
let group = { col: null, key: null }; // the series in view, for a long table with one row per time and series
let table = null; // that series: { rows, times, name, season }; rows hold numbers or null
let lastResult = null; // { req, q, full, alt, rho, model }: shown and full quantiles, alt = the scenario forecast,
// rho = how each forecast column's steps move together (null where nothing could be checked)
let scenario = {}; // edits per known covariate, see plan.js
let pending = null; // settings from a link to a file the user has not opened yet
let armed = false; // after the first Run click, changes re-run the forecast on their own
let charts = [];
let redraw = () => {};

/* ---------- Zoom and pan, shared by every chart ---------- */

let view = null; // the user's x range { min, max }, or null for the default window; kept across redraws
let home = null; // the default window for the current request
let bounds = null; // the whole x range: all the data plus the steps ahead

function setView(min, max, from = null) {
  const full = bounds.max - bounds.min;
  const span = Math.min(full, Math.max(max - min, full / 2000));
  min = Math.max(bounds.min, Math.min(min, bounds.max - span));
  view = { min, max: min + span };
  charts.forEach((c) => c !== from && c.setView(view.min, view.max));
  if (from && (from.getView().min !== view.min || from.getView().max !== view.max)) from.setView(view.min, view.max);
  syncZoomButtons();
}
const current = () => view ?? home;
function zoomBy(k) {
  const { min, max } = current(), mid = (min + max) / 2, half = ((max - min) * k) / 2;
  setView(mid - half, mid + half);
}
function panBy(share) {
  const { min, max } = current(), shift = (max - min) * share;
  setView(min + shift, max + shift);
}
function resetView() {
  view = null;
  charts.forEach((c) => c.setView(home.min, home.max));
  syncZoomButtons();
}
function syncZoomButtons() {
  const v = current();
  const disabled = !charts.length || !v;
  $("#zoom-back").disabled = disabled || v.min <= bounds.min;
  $("#zoom-ahead").disabled = disabled || v.max >= bounds.max;
  $("#zoom-out").disabled = $("#zoom-all").disabled = disabled || (v.min <= bounds.min && v.max >= bounds.max);
  $("#zoom-in").disabled = disabled;
  $("#zoom-reset").disabled = disabled || !view;
}

function renderCharts(series, isTime) {
  // Keep the keyboard focus on the start line across redraws.
  const refocus = !!document.activeElement?.classList.contains("start-handle");
  charts.forEach((c) => c.destroy());
  const box = $("#charts");
  box.innerHTML = "";
  home = series[0]?.view ?? null;
  bounds = series[0] ? { min: series[0].x[0], max: series[0].x.at(-1) } : null;
  charts = series.map((s) => {
    const wrap = document.createElement("div");
    wrap.className = "chart";
    if (series.length > 1) wrap.insertAdjacentHTML("beforeend", `<p class="chart-label">${esc(s.label)}</p>`);
    const el = document.createElement("div");
    el.className = "chart-plot";
    wrap.appendChild(el);
    box.appendChild(wrap);
    const chart = fanChart(el, {
      ...s, isTime, view: view ?? s.view, fill: FILL.matches,
      stop: origins.indexOf(cut), stopLabel: (i) => originLabel(origins[i]),
      onView: (min, max) => setView(min, max, chart),
      onReset: resetView,
      onStop: (i, done) => moveStart(i, done, chart),
    });
    return chart;
  });
  syncZoomButtons();
  if (refocus) charts[0]?.focusStart();
  redraw = () => renderCharts(series, isTime);
}
// On wide screens the page fits the window and the charts take the height that is left.
const FILL = matchMedia("(min-width: 901px) and (min-height: 640px)");
FILL.addEventListener("change", () => redraw());

/** The forecast start line moved to stop `i`; `done` once the drag ends. */
function moveStart(i, done, from) {
  cut = origins[i];
  $("#origin-label").textContent = originLabel(cut);
  charts.forEach((c) => c !== from && c.setStop(i));
  if (!done) return;
  armed = true;
  update();
}

// Charts read colors from CSS variables, so redraw them when the color scheme flips.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => redraw());

function status(msg, err = false) {
  $("#status").textContent = msg;
  $("#status").classList.toggle("err", err);
}

/* ---------- Loading data ---------- */

/**
 * Open a CSV. `example` carries the presets of a bundled dataset; `settings` (from a link) override them.
 * False when the file cannot be read; the current data then stays.
 */
function openSource(text, name, example = null, settings = null) {
  let csv, info;
  try {
    csv = readCSV(text);
    info = inspect(csv);
    if (!info.numeric.length) throw new Error("This file has no numeric columns.");
  } catch (err) {
    status(`Could not open ${name}: ${err.message}`, true);
    return false;
  }
  source = { name, example, csv, info };
  const col = [settings?.group, example?.group, info.groups[0]].find((g) => g && info.groups.includes(g)) ?? null;
  scenario = settings?.scenario ?? {};
  ranked = null;
  $("#group-col").innerHTML = `<option value="">None: one series</option>`
    + info.groups.map((g) => `<option${g === col ? " selected" : ""}>${esc(g)}</option>`).join("");
  $("#series-box").hidden = !info.groups.length;
  // A link's settings win; what it leaves out comes from the example.
  selectGroup(col, settings?.key, { ...presetsOf(example), ...settings });
  return true;
}

/** The control presets of an example (or of a plain file, when null), in the shape of link settings. */
const presetsOf = (example) => ({ t: example?.targets, c: example?.covariates, k: example?.known, h: example?.horizon });

/** Show the series named `key` of group column `col` (the whole file when `col` is null). */
function selectGroup(col, key, presets) {
  const keys = col ? groupKeys(source.csv, col) : [];
  group = { col, key: col ? (keys.includes(key) ? key : keys[0]) : null };
  $("#group-key").innerHTML = keys.map((k) => `<option${k === group.key ? " selected" : ""}>${esc(k)}</option>`).join("");
  $("#group-key").disabled = !col;
  $("#tab-series").hidden = !col;
  if (!col && activeTab() === "series") setTab("accuracy");
  showTable(presets);
}

/** Build the table for the series in view and set the controls from `presets` (link settings shape). */
function showTable(presets) {
  let parsed;
  try { parsed = buildTable(source.csv, source.info, group.col, group.key); } catch (err) { return status(err.message, true); }
  const { fields, rows, timeCol, times, notes } = parsed;
  const { example, name } = source;
  table = { rows, times, name, season: season(times) };

  const valid = (list) => list?.filter((f) => fields.includes(f));
  const targets = valid(presets.t)?.length ? valid(presets.t) : [fields[0]];
  const covariates = valid(presets.c) ?? [];
  // Covariates are known ahead unless the presets say otherwise; each one can be switched to past only.
  const known = (f) => !presets.k || presets.k.includes(f);
  const check = (f, name, on) =>
    `<label><input type="checkbox" name="${name}" value="${esc(f)}" ${on ? "checked" : ""}>${esc(f)}</label>`;
  $("#targets").innerHTML = fields.map((f) => check(f, "t", targets.includes(f))).join("");
  $("#covariates").innerHTML = fields.map((f) => `<span class="cov-item">${check(f, "c", covariates.includes(f))}`
    + `<label class="ahead" title="On: the model sees its values ahead. Off: only its history.">`
    + `<input type="checkbox" name="k" value="${esc(f)}" ${known(f) ? "checked" : ""}>known ahead</label></span>`).join("");
  $("#covariates-box").hidden = fields.length < 2;
  $("#horizon").value = presets.h ?? Math.max(1, Math.min(96, Math.floor(rows.length / 5)));
  if (presets.model && [...$("#model").options].some((o) => o.value === presets.model)) $("#model").value = presets.model;
  if (presets.level != null) $("#level").value = Math.max(0, SERVICE_LEVELS.indexOf(LEVELS[levelIndex(presets.level)]));
  if (presets.agg === "sum" || presets.agg === "mean") $("#agg").value = presets.agg;
  if (presets.tab) setTab(presets.tab);

  const where = group.col ? `: ${group.key}` : "";
  $("#title").textContent = (example?.title ?? name) + where;
  const facts = [`${rows.length.toLocaleString()} rows`, timeCol ? `time column “${timeCol}”` : "no time column", ...notes];
  $("#blurb").textContent = example?.blurb ?? `${facts.join(", ")}.`;
  $("#source").innerHTML = example
    ? `Data: <a href="${example.source_url}" target="_blank" rel="noopener">${esc(example.source)}</a>, ${esc(example.license)}.`
    : "Your file stays in this tab.";
  lastResult = null;
  view = null;
  syncColumns();
  setOrigins(null, presets.back);
  syncLevel();
  syncScenario();
  update();
}

const picked = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
function syncColumns() {
  // A column cannot be both a forecast target and a covariate.
  const t = picked("t");
  document.querySelectorAll('input[name="c"]').forEach((c) => {
    c.disabled = t.includes(c.value);
    if (c.disabled) c.checked = false;
  });
}

/* ---------- The forecast start ---------- */

// Tables never change once built, so their columns and extents are worked out once.
const columns = new WeakMap(); // table -> Map(column -> values)
function col(f, tbl = table) {
  if (!columns.has(tbl)) columns.set(tbl, new Map());
  const memo = columns.get(tbl);
  if (!memo.has(f)) memo.set(f, tbl.rows.map((r) => r[f]));
  return memo.get(f);
}
/** Rows with data in the forecast columns (`end`), and all rows including trailing future covariates (`n`). */
function extent(tbl = table) {
  const targets = picked("t"), n = tbl.rows.length;
  const key = `extent:${JSON.stringify(targets)}`;
  const memo = columns.get(tbl) ?? columns.set(tbl, new Map()).get(tbl);
  if (!memo.has(key)) {
    const t = targets.map((f) => col(f, tbl));
    let end = n;
    while (end > 0 && t.every((s) => s[end - 1] == null)) end--;
    memo.set(key, end);
  }
  return { n, end: memo.get(key) };
}
const horizon = () => Math.max(1, Math.round(+$("#horizon").value) || 1);

let cut = 0; // row where the forecast starts
let origins = []; // where the forecast can start: rows one horizon apart, ending at the end of the data
const ORIGINS = 8;

const timeLabel = (t) => {
  const d = new Date(t * 1000).toISOString();
  return d.slice(11, 16) === "00:00" ? d.slice(0, 10) : d.slice(0, 16).replace("T", " ");
};
function originLabel(c) {
  if (c >= extent().end) return "end of data";
  return table.times ? timeLabel(table.times[c]) : `row ${c}`; // the first forecast step
}

/** Rebuild the forecast start stops. Keeps `prefer`, or the stop `back` steps from the end; else one horizon back. */
function setOrigins(prefer = null, back = null) {
  const { end } = extent();
  const h = horizon();
  origins = [];
  for (let k = 0; k < ORIGINS && end - k * h >= 16; k++) origins.unshift(end - k * h);
  if (!origins.length) origins.push(end);
  const linked = back != null ? origins[origins.length - 1 - back] : undefined;
  cut = origins.includes(prefer) ? prefer : linked ?? origins.at(-2) ?? origins.at(-1);
  $("#origin-label").textContent = originLabel(cut);
}

/* ---------- Forecasting ---------- */

const ffill = (arr) => {
  let last = arr.find((v) => v != null) ?? 0;
  return arr.map((v) => (v == null ? last : (last = v)));
};
/** The scenario edits that change something, for the covariates that are selected and known ahead. */
function activeScenario() {
  const known = new Set(picked("k"));
  return Object.fromEntries(Object.entries(scenario).filter(([f, e]) => isActive(e) && picked("c").includes(f) && known.has(f)));
}

/**
 * The forecast request from row `at` of `tbl`, with what the charts and scores need. It runs `h` steps past the
 * end of the data, or with `backtest` only `h` steps from `at` (and no further than the end of the data).
 * `edits` changes known covariates past the end of the data (a scenario).
 */
function buildRequest({ tbl = table, covs = picked("c"), at = cut, backtest = false, edits = {} } = {}) {
  const targets = picked("t");
  if (!targets.length) throw new Error("Pick at least one column to forecast.");
  if (targets.length > 8 || covs.length > 8) throw new Error("Pick at most 8 columns to forecast and 8 covariates.");
  const h = Math.round(+$("#horizon").value);
  if (!(h >= 1 && h <= 1024)) throw new Error("Steps ahead must be between 1 and 1024.");
  const ahead = new Set(picked("k"));
  const known = covs.filter((f) => ahead.has(f)), past = covs.filter((f) => !ahead.has(f));
  const T = targets.map((f) => col(f, tbl));
  const { n, end } = extent(tbl);
  const start = Math.max(0, at - MAX_CONTEXT);
  if (at - start < 8) throw new Error("Pick a later start: the model needs some history.");

  // The forecast runs from the start to `h` steps past the end of the data, so earlier starts also predict the future.
  const H = backtest ? Math.min(h, end - at) : end + h - at;
  const body = { target: T.map((s) => s.slice(start, at)), horizon: H };
  // Known covariates are given ahead where the file has them (rows past the end of the file are blank), then
  // changed by the scenario.
  if (known.length) body.knownCovariates = known.map((f) => {
    const s = ffill(col(f, tbl));
    const values = applyEdit(Array.from({ length: at + H }, (_, i) => (i < n ? s[i] : null)), end, edits[f]);
    return values.slice(start, at + H);
  });
  // Past-only covariates stop at the forecast start, like a measurement that only arrives as it happens.
  if (past.length) body.pastCovariates = past.map((f) => ffill(col(f, tbl)).slice(start, at));

  const t = tbl.times;
  const step = t ? median(t.slice(-50).map((v, j, a) => v - a[j - 1]).slice(1)) || 1 : 1;
  const xAt = (i) => (!t ? i : i < n ? t[i] : t[n - 1] + step * (i - n + 1));
  // The charts hold all the data; they open on a fixed window for every forecast start, from a little before the
  // earliest stop to `h` steps past the data, so moving the start moves the forecast, not the axis.
  const histFrom = 0, histTo = end + h;
  const viewFrom = Math.max(0, Math.min(origins[0] ?? at, at) - Math.max(h, 100));
  const notes = [`${(at - start).toLocaleString()} steps of history`, `${H} steps ahead`];
  if (known.length) notes.push(`${known.length} known covariate${known.length > 1 ? "s" : ""}`);
  if (past.length) notes.push(`${past.length} past covariate${past.length > 1 ? "s" : ""}`);
  return {
    body, targets, isTime: !!t, notes,
    view: { min: xAt(viewFrom), max: xAt(histTo - 1) },
    // The start line sits on the last point of history, where the forecast lines join it.
    stops: origins.map((c) => xAt(Math.max(0, c - 1))),
    histX: Array.from({ length: histTo - histFrom }, (_, i) => xAt(histFrom + i)),
    hist: T.map((s) => Array.from({ length: histTo - histFrom }, (_, i) => (i + histFrom < end ? s[i + histFrom] : null))),
    start: at - histFrom,
    dataEnd: end - histFrom,
    ahead: end - at, // the first forecast step past the end of the data
    fcX: Array.from({ length: H }, (_, i) => xAt(at + i)),
    actual: T.map((s) => s.slice(at, Math.min(end, at + H))),
    context: T.map((s) => s.slice(start, at)),
    history: T.map((s) => s.slice(0, end)),
  };
}

const toShown = (quantiles) => quantiles.map((series) => SHOWN.map((k) => series.map((qs) => qs[k])));

async function runOnServer(model, request) {
  const res = await fetch(`${BASE}api/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, ...request }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([json.detail].flat().map((d) => d?.msg ?? d).join("; ") || `Server error ${res.status}`);
  return { quantiles: toShown(json.quantiles), full: json.quantiles, seconds: json.seconds };
}

/**
 * Forecast. Resolves to { quantiles: variates x 5 shown levels x horizon, full: variates x horizon x 21, seconds },
 * or null if overtaken by a newer run.
 */
function runModel(model, request, g) {
  if (SERVER) return runOnServer(model, request);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "progress") {
        const mb = (b) => (b / 1e6).toFixed(0);
        return status(data.total
          ? `Downloading Timestral-${model}: ${mb(data.loaded)} of ${mb(data.total)} MB. Only the first time.`
          : `Downloading Timestral-${model}: ${mb(data.loaded)} MB.`);
      }
      worker.removeEventListener("message", onMessage);
      if (data.type === "skipped") return resolve(null);
      if (data.type === "error") return reject(new Error(data.message));
      resolve({ quantiles: toShown(data.quantiles), full: data.quantiles, seconds: data.seconds });
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, gen: g, model, request });
  });
}

/** Each forecast column's chart data: the forecast in `q`, plus the plan line and the scenario median once run. */
function chartSeries(req, q, result = null) {
  const level = serviceLevel(), k = levelIndex(level);
  return req.targets.map((label, v) => {
    const lines = [];
    if (result) lines.push({ label: `Plan at ${pct(level)}`, values: result.full[v].map((qs) => qs[k]), color: "--plan", dash: [6, 3] });
    if (result?.alt) {
      // The scenario only changes steps past the end of the data; it leaves the forecast's median where it joins.
      const values = result.alt.full[v].map((qs, i) => (i >= req.ahead - 1 ? (i < req.ahead ? result.full[v][i][MEDIAN] : qs[MEDIAN]) : null));
      lines.push({ label: "Scenario median", values, color: "--scenario", join: req.ahead === 0 });
    }
    return {
      label, view: req.view, stops: req.stops,
      ...align({ histX: req.histX, histY: req.hist[v], start: req.start, dataEnd: req.dataEnd, fcX: req.fcX, quantiles: q[v], lines }),
    };
  });
}

function draw(req, q, result = null) {
  renderCharts(chartSeries(req, q, result), req.isTime);
  syncLegend(result);
}

function syncLegend(result) {
  $("#legend-plan").hidden = !result;
  $("#legend-plan span").textContent = `Plan at ${pct(serviceLevel())}`;
  $("#legend-scenario").hidden = !result?.alt;
}

/** Show the data and the forecast window without running the model. */
function preview() {
  lastResult = null; // the plan and the report wait for the next run
  let req;
  try { req = buildRequest(); } catch (err) { return status(err.message, true); }
  draw(req, req.targets.map(() => Array.from({ length: 5 }, () => Array(req.fcX.length).fill(null))));
  $("#meta").textContent = req.notes.join(" · ");
  $("#metrics").innerHTML = "";
  $("#accuracy-empty").hidden = false;
  $("#effect").textContent = "";
  $("#download").hidden = $("#report").hidden = true;
  renderPlan();
  renderScenarioSummary();
  syncBacktest();
  syncRanking();
  status(armed ? "" : "Press Run forecast to compute it.");
}

async function run() {
  let req;
  try { req = buildRequest(); } catch (err) { return status(err.message, true); }
  const g = ++gen;
  const model = $("#model").value;
  const covs = picked("c"), edits = activeScenario();
  const hasActual = req.actual.some((s) => s.some((v) => v != null));
  status(SERVER ? "Forecasting on this computer. The first run of a model downloads it." : "Forecasting…");
  $("#run").disabled = true;
  try {
    const res = await runModel(model, req.body, g);
    // With covariates and something to compare against, also forecast without them to show their effect.
    const plain = covs.length && hasActual ? await runModel(model, buildRequest({ covs: [] }).body, g) : null;
    // With a scenario, forecast again with the edited covariates.
    const alt = hasScenario(edits) ? await runModel(model, buildRequest({ edits }).body, g) : null;
    if (!res || g !== gen || (covs.length && hasActual && !plain) || (hasScenario(edits) && !alt)) return;
    const rho = req.targets.map((_, v) => stepCorrelation(req.actual[v], res.full[v]));
    lastResult = { req, q: res.quantiles, full: res.full, alt, rho, model };
    draw(req, res.quantiles, lastResult);
    $("#meta").textContent = [`Timestral-${model}`, ...req.notes].join(" · ");
    const m = hasActual && score(req.actual, res.quantiles, req.context, table.season.m);
    $("#metrics").innerHTML = m ? metricsHTML(m, table.season) : "";
    $("#accuracy-empty").hidden = !!m;
    const m0 = plain && score(req.actual, plain.quantiles, req.context, table.season.m);
    if (m && m0) {
      const d = versus(change(m.mae, m0.mae)) || "against";
      $("#effect").innerHTML = `With these covariates the average error is <b>${fmt(m.mae)}</b>, ${d} ${fmt(m0.mae)} without them.`;
    } else {
      $("#effect").textContent = covs.length ? "Pick an earlier start to measure what the covariates change." : "";
    }
    $("#download").hidden = $("#report").hidden = false;
    renderPlan();
    renderScenarioSummary();
    const secs = res.seconds + (plain?.seconds ?? 0) + (alt?.seconds ?? 0);
    const extras = [plain && "with and without covariates", alt && "with the scenario"].filter(Boolean);
    status(`Done in ${secs.toFixed(secs < 10 ? 1 : 0)} s on this device${extras.length ? `, ${extras.join(" and ")}` : ""}.`);
  } catch (err) {
    if (g === gen) status(err.message, true);
  } finally {
    if (g === gen) $("#run").disabled = false;
  }
}

/** Something changed: re-run if the user already ran a forecast, otherwise just redraw the data. */
let timer;
function update() {
  clearTimeout(timer);
  preview();
  saveSettings();
  if (armed) timer = setTimeout(run, 250);
}

function downloadCSV() {
  const { req, q, full } = lastResult;
  const level = serviceLevel(), k = levelIndex(level);
  const when = (x) => (req.isTime ? new Date(x * 1000).toISOString().slice(0, 16).replace("T", " ") : x);
  const head = ["time", ...req.targets.flatMap((t) => ["q10", "q25", "median", "q75", "q90", `plan ${pct(level)}`].map((c) => `${t} ${c}`))];
  const lines = req.fcX.map((x, i) => [when(x), ...q.flatMap((v, j) => [...v.map((row) => row[i]), full[j][i][k]])]);
  const csv = Papa.unparse({ fields: head, data: lines });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "timestral-forecast.csv",
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); // revoking at once can cancel the download in some browsers
}

/* ---------- Result tabs ---------- */

const TABS = ["accuracy", "plan", "scenario", "series"];
const activeTab = () => TABS.find((t) => $(`#tab-${t}`).getAttribute("aria-selected") === "true");
function setTab(name) {
  if (!TABS.includes(name) || $(`#tab-${name}`).hidden) return;
  for (const t of TABS) {
    const on = t === name;
    $(`#tab-${t}`).setAttribute("aria-selected", on);
    $(`#tab-${t}`).tabIndex = on ? 0 : -1;
    $(`#panel-${t}`).hidden = !on;
  }
}
function onTabKey(e) {
  const shown = TABS.filter((t) => !$(`#tab-${t}`).hidden);
  const i = shown.indexOf(activeTab());
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: shown.length - 1 }[e.key];
  if (next == null) return;
  e.preventDefault();
  const name = shown[(next + shown.length) % shown.length];
  setTab(name);
  $(`#tab-${name}`).focus();
  saveSettings();
}

/* ---------- Plan: a service level and totals over the steps past the end of the data ---------- */

const serviceLevel = () => SERVICE_LEVELS[+$("#level").value] ?? 0.9;
function syncLevel() {
  $("#level-label").textContent = $("#level-text").textContent = pct(serviceLevel());
}

function renderPlan() {
  const box = $("#plan-table");
  if (!lastResult) {
    box.innerHTML = "";
    $("#plan-period").textContent = "Run a forecast to see what to plan for.";
    return;
  }
  const { req, full, alt, rho } = lastResult;
  const level = serviceLevel(), mode = $("#agg").value;
  const from = req.ahead, to = req.fcX.length;
  const span = req.isTime ? `, ${timeLabel(req.fcX[from])} to ${timeLabel(req.fcX[to - 1])}` : "";
  $("#plan-period").textContent = `The next ${(to - from).toLocaleString()} steps past the end of the data${span}.`;
  const rows = req.targets.map((label, v) => ({
    label,
    sum: summarize(full[v], from, to, level, mode, rho[v] ?? 1),
    scenario: alt && summarize(alt.full[v], from, to, level, mode, rho[v] ?? 1),
  }));
  box.innerHTML = planTableHTML(rows, level, mode === "mean");
  const checked = req.actual[0].filter((y) => y != null).length;
  const measured = rho.filter((r) => r != null).map((r) => r.toFixed(2));
  $("#plan-method").textContent = measured.length
    ? `consecutive steps ran high or low together with a correlation of ${measured.join(" and ")} on the`
      + ` ${checked.toLocaleString()} steps since the forecast start that can be checked.`
    : "with nothing to check yet, they assume the steps all run high or low together, the widest case. Start the"
      + " forecast before the end of the data to measure it.";
}

/* ---------- Scenario: change known covariates past the end of the data ---------- */

const knownCovariates = () => picked("c").filter((f) => picked("k").includes(f));

/** Rebuild the scenario editor for the covariates that are selected and known ahead. */
function syncScenario() {
  const cols = knownCovariates(), h = horizon();
  const { n, end } = extent();
  $("#scenario-intro").textContent = cols.length
    ? `Change what you know ahead over the next ${h} steps and compare the forecast, for example a holiday or a promotion on some days. Steps count from the end of the data.`
    : "Pick a covariate and keep it known ahead to try a scenario: change its values over the next steps and compare the forecast.";
  $("#scenario-edits").innerHTML = scenarioEditsHTML(cols.map((c) => ({
    col: c,
    edit: scenario[c] ?? { mode: "file", value: null, from: 1, to: h },
    future: col(c).slice(end, n).filter((v) => v != null).length,
  })), h);
  $("#scenario-reset").hidden = !hasScenario(activeScenario());
}

function onScenarioInput(e) {
  const row = e.target.closest(".edit");
  if (!row) return;
  const read = (key) => row.querySelector(`[data-key="${key}"]`);
  const num = (key) => (read(key).value.trim() === "" ? null : +read(key).value);
  const edit = { mode: read("mode").value, value: num("value"), from: num("from") ?? 1, to: num("to") ?? horizon() };
  scenario[row.dataset.col] = edit;
  const off = !(edit.mode === "set" || edit.mode === "change");
  ["value", "from", "to"].forEach((key) => (read(key).disabled = off));
  $("#scenario-reset").hidden = !hasScenario(activeScenario());
  if (isActive(edit) || off) update();
}

function renderScenarioSummary() {
  const box = $("#scenario-summary");
  const edits = activeScenario();
  if (!hasScenario(edits)) return void (box.textContent = "");
  if (!lastResult?.alt) return void (box.textContent = armed ? "" : "Press Run forecast to compare the scenario.");
  const { req, full, alt, rho } = lastResult;
  const mode = $("#agg").value, how = mode === "mean" ? "average" : "total";
  box.innerHTML = req.targets.map((label, v) => {
    const a = summarize(full[v], req.ahead, req.fcX.length, 0.5, mode, rho[v] ?? 1);
    const b = summarize(alt.full[v], req.ahead, req.fcX.length, 0.5, mode, rho[v] ?? 1);
    // Neither direction is better in general (fewer rentals on a holiday is not a failure), so no colors.
    const d = change(b.median, a.median);
    const diff = d == null ? "" : d === 0 ? ": about the same" : `: <b>${d > 0 ? "+" : ""}${d}%</b>`;
    return `${esc(label)}, most likely ${how} <b>${fmt(b.median)}</b> with the scenario against ${fmt(a.median)} without it${diff}.`;
  }).join("<br>");
}

/* ---------- Backtest: forecast from every start and pool the scores ---------- */

let backtested = null; // { key, rows: [{ at, s, s0 }], total, model, covs }

// Results hold while the data, columns, horizon and model stay the same; moving the start keeps them. The series
// ranking also holds when another series of the same file is shown.
const resultKey = (series = true) => JSON.stringify([source?.name, series ? group : group.col, picked("t"), picked("c"),
  knownCovariates(), $("#horizon").value, $("#model").value]);
const backtestStarts = () => origins.filter((c) => c < extent().end);

function syncBacktest() {
  $("#backtest-box").hidden = backtestStarts().length < 2;
  if (backtested && backtested.key !== resultKey()) backtested = null;
  renderBacktest();
}

function renderBacktest() {
  const box = $("#backtest-table"), summary = $("#backtest-summary");
  if (!backtested?.rows.length) return void ((box.innerHTML = ""), (summary.innerHTML = ""));
  const { rows, total, model, covs } = backtested;
  const { name, error } = naive(table.season);
  const p = pool(rows.map((r) => r.s));
  const lines = [`Timestral-${model} from ${rows.length}${rows.length < total ? ` of ${total}` : ""} starts,`
    + ` ${p.count.toLocaleString()} points: average error <b>${fmt(p.mae)}</b>,`
    + ` ${versus(change(p.mae, error(p))) || "against"} ${name} (${fmt(error(p))}).`
    + ` The 80% range held <b>${pct(p.coverage)}</b> of what happened.`];
  const p0 = covs && pool(rows.map((r) => r.s0));
  if (p0) {
    const wins = rows.filter((r) => r.s && r.s0 && r.s.mae < r.s0.mae).length;
    lines.push(`With the covariates the error is ${versus(change(p.mae, p0.mae)) || "against"} without them`
      + ` (${fmt(p0.mae)}), and lower at ${wins} of ${rows.length} starts.`);
  }
  summary.innerHTML = lines.join(" ");
  box.innerHTML = backtestTableHTML(rows.map((r) => ({ ...r, label: originLabel(r.at) })), table.season, covs, cut);
}

async function backtest() {
  const starts = backtestStarts();
  if (!starts.length) return;
  clearTimeout(timer);
  const g = ++gen;
  const model = $("#model").value, covs = picked("c").length > 0, m = table.season.m;
  backtested = { key: resultKey(), rows: [], total: starts.length, model, covs };
  renderBacktest();
  $("#backtest").disabled = $("#run").disabled = true;
  const t0 = performance.now();
  try {
    for (const [k, at] of starts.entries()) {
      status(`Backtesting: start ${k + 1} of ${starts.length}…`);
      const req = buildRequest({ at, backtest: true });
      const res = await runModel(model, req.body, g);
      const plain = covs ? await runModel(model, buildRequest({ at, backtest: true, covs: [] }).body, g) : null;
      if (!res || g !== gen || (covs && !plain)) return;
      backtested.rows.push({ at, s: score(req.actual, res.quantiles, req.context, m),
                             s0: plain && score(req.actual, plain.quantiles, req.context, m) });
      renderBacktest();
    }
    const secs = (performance.now() - t0) / 1000;
    status(`Backtested ${starts.length} starts in ${secs.toFixed(secs < 10 ? 1 : 0)} s on this device.`);
  } catch (err) {
    if (g === gen) status(err.message, true);
  } finally {
    if (g === gen) $("#backtest").disabled = $("#run").disabled = false;
  }
}

/* ---------- All series: forecast every series of a long table and rank them ---------- */

const MAX_SERIES = 100;
let ranked = null; // { key, rows: [{ name, last, next, growth, spread, mase, error }], total, sort, target }

function syncRanking() {
  if (ranked && ranked.key !== resultKey(false)) ranked = null;
  renderRanking();
}

function renderRanking() {
  const h = horizon(), target = picked("t")[0];
  $("#rank-intro").textContent = `Forecast every series from the end of its data with these settings and rank them on`
    + ` ${target ? `“${target}”` : "the first column to forecast"}: the next ${h} steps against the last ${h},`
    + ` the width of the 80% range, and the error from one horizon back (MASE).`;
  $("#rank-table").innerHTML = ranked?.rows.length ? rankTableHTML(ranked.rows, ranked.sort, group.key) : "";
}

async function rankSeries() {
  const keys = groupKeys(source.csv, group.col);
  const todo = keys.slice(0, MAX_SERIES), h = horizon(), model = $("#model").value;
  clearTimeout(timer);
  const g = ++gen;
  ranked = { key: resultKey(false), rows: [], total: todo.length, sort: ranked?.sort ?? { by: "growth", dir: -1 } };
  $("#rank").disabled = $("#run").disabled = true;
  const t0 = performance.now();
  try {
    for (const [i, key] of todo.entries()) {
      status(`Forecasting series ${i + 1} of ${todo.length}${keys.length > todo.length ? ` (the first ${MAX_SERIES})` : ""}…`);
      const row = { name: key };
      try {
        const tbl = buildTable(source.csv, source.info, group.col, key);
        tbl.season = season(tbl.times);
        const { end } = extent(tbl);
        const ahead = buildRequest({ tbl, at: end });
        const res = await runModel(model, ahead.body, g);
        // One horizon back, to check the model on this series.
        const back = end - h >= 16 ? buildRequest({ tbl, at: end - h, backtest: true }) : null;
        const resBack = back && await runModel(model, back.body, g);
        if (!res || g !== gen || (back && !resBack)) return;
        const rho = back && stepCorrelation(back.actual[0], resBack.full[0]);
        Object.assign(row, outlook(ahead.history[0], res.full[0], h, rho ?? 1),
          { mase: back ? score(back.actual.slice(0, 1), resBack.quantiles.slice(0, 1), back.context.slice(0, 1), tbl.season.m)?.mase ?? null : null });
      } catch (err) {
        if (g !== gen) return;
        row.error = err.message;
      }
      ranked.rows.push(row);
      renderRanking();
    }
    const secs = (performance.now() - t0) / 1000;
    status(`Forecast ${todo.length} series in ${secs.toFixed(secs < 10 ? 1 : 0)} s on this device.`);
  } catch (err) {
    if (g === gen) status(err.message, true);
  } finally {
    if (g === gen) $("#rank").disabled = $("#run").disabled = false;
  }
}

/* ---------- Sharing: settings in the link, and a printable report ---------- */

/** The view as link settings; see settings.js. */
function currentSettings() {
  return {
    ...(source.example ? { ex: source.example.id } : { file: source.name }),
    group: group.col, key: group.key,
    t: picked("t"), c: picked("c"), k: picked("k"),
    h: horizon(), model: $("#model").value,
    back: origins.length - 1 - origins.indexOf(cut), level: serviceLevel(), agg: $("#agg").value, tab: activeTab(),
    scenario: activeScenario(),
  };
}
function saveSettings() {
  // While a link waits for its file, the address keeps that link.
  if (source && !pending) history.replaceState(null, "", `${location.pathname}${location.search}#${encodeSettings(currentSettings())}`);
}

async function copyLink() {
  saveSettings();
  try {
    await navigator.clipboard.writeText(location.href);
    status(source.example ? "Link copied. It reopens this view." : `Link copied. It has the settings, not ${source.name}: whoever opens it needs that file too.`);
  } catch {
    status("Could not copy the link: copy it from the address bar.", true);
  }
}

function report() {
  const { req, model } = lastResult;
  const panel = (sel) => ($(sel)?.innerHTML.trim() ? `<table class="data">${$(sel).innerHTML}</table>` : "");
  printReport($("#report-sheet"), { redraw: () => redraw(), canvases: () => [...document.querySelectorAll("#charts canvas")] }, {
    title: $("#title").textContent,
    subtitle: $("#blurb").textContent,
    facts: [`Timestral-${model}`, `forecast from ${originLabel(cut)}`, ...req.notes],
    sections: [
      { heading: "Plan", html: lastResult ? `<p>${esc($("#plan-period").textContent)}</p>${panel("#plan-table")}` : "" },
      { heading: "Scenario", html: $("#scenario-summary").innerHTML.trim() && `<p>${$("#scenario-summary").innerHTML}</p>` },
      { heading: "Accuracy", html: ($("#metrics").innerHTML.trim() ? `<dl class="metrics">${$("#metrics").innerHTML}</dl>` : "")
        + ($("#effect").innerHTML.trim() ? `<p>${$("#effect").innerHTML}</p>` : "") },
      { heading: "Backtest", html: backtested?.rows.length ? `<p>${$("#backtest-summary").innerHTML}</p>${panel("#backtest-table")}` : "" },
      { heading: "All series", html: ranked?.rows.length ? panel("#rank-table") : "" },
    ],
    footer: `${$("#source").innerHTML} Made with Timestral in the browser, ${esc(location.href.split("#")[0])}`,
  });
}

/* ---------- Wiring ---------- */

async function init() {
  const examples = await fetch(`${DATA_URL}examples.json`).then((r) => r.json());
  const select = (button) => $("#sources").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === button));
  $("#sources").insertAdjacentHTML("afterbegin", examples.map((ex) =>
    `<button type="button" data-id="${ex.id}" aria-pressed="false">${esc(ex.title)}<span>${esc(ex.freq)}</span></button>`).join(""));
  const openExample = async (button, settings = null) => {
    const ex = examples.find((x) => x.id === button.dataset.id);
    select(button);
    openSource(await fetch(`${DATA_URL}${ex.id}.csv`).then((r) => r.text()), `${ex.id}.csv`, ex, settings);
  };
  $("#sources").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) { pending = null; openExample(b); }
  });

  const drop = $("#drop");
  // A file that fails to open leaves the current data, and its example button, as they were. A link's settings
  // apply to the file it names.
  const readFile = (f) => f && f.text().then((t) => {
    const settings = pending?.file === f.name ? pending : null;
    if (openSource(t, f.name, null, settings)) {
      select(null);
      pending = null;
      saveSettings();
    }
  });
  $("#file").addEventListener("change", (e) => {
    readFile(e.target.files[0]);
    e.target.value = ""; // so opening the same file again fires another change
  });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); });

  // Switching series keeps the columns, horizon and start chosen for the previous one.
  const keepSettings = () => ({ ...currentSettings(), tab: null });
  $("#group-col").addEventListener("change", (e) => selectGroup(e.target.value || null, null, keepSettings()));
  $("#group-key").addEventListener("change", (e) => selectGroup(group.col, e.target.value, keepSettings()));
  $("#targets").addEventListener("change", () => { syncColumns(); setOrigins(cut); syncScenario(); update(); });
  $("#covariates").addEventListener("change", () => { syncScenario(); update(); });
  $("#horizon").addEventListener("change", () => { view = null; setOrigins(); syncScenario(); update(); });
  $("#model").addEventListener("change", update);
  $("#form").addEventListener("submit", (e) => { e.preventDefault(); armed = true; clearTimeout(timer); run(); });
  $("#download").addEventListener("click", downloadCSV);
  $("#report").addEventListener("click", report);
  $("#share").addEventListener("click", copyLink);

  document.querySelector('[role="tablist"]').addEventListener("click", (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) { setTab(tab.id.slice(4)); saveSettings(); }
  });
  document.querySelector('[role="tablist"]').addEventListener("keydown", onTabKey);
  // The plan redraws from the last forecast: no new run, and the charts only swap their plan line.
  const replan = () => {
    syncLevel();
    if (lastResult) {
      chartSeries(lastResult.req, lastResult.q, lastResult).forEach((s, v) => charts[v]?.setLines(s.lines));
      syncLegend(lastResult);
    }
    renderPlan();
    renderScenarioSummary();
    saveSettings();
  };
  $("#level").addEventListener("input", replan);
  $("#agg").addEventListener("change", replan);
  $("#scenario-edits").addEventListener("change", onScenarioInput);
  $("#scenario-reset").addEventListener("click", () => { scenario = {}; syncScenario(); update(); });

  $("#backtest").addEventListener("click", backtest);
  // A start in the backtest table moves the forecast start there.
  $("#backtest-table").addEventListener("click", (e) => {
    const i = origins.indexOf(+e.target.closest("button.link")?.closest("tr").dataset.at);
    if (i >= 0) moveStart(i, true);
  });
  $("#rank").addEventListener("click", rankSeries);
  $("#rank-table").addEventListener("click", (e) => {
    const sort = e.target.closest("button.sort")?.dataset.sort;
    if (sort && ranked) {
      ranked.sort = { by: sort, dir: ranked.sort.by === sort ? -ranked.sort.dir : sort === "name" ? 1 : -1 };
      return renderRanking();
    }
    const key = e.target.closest("button.link")?.dataset.key;
    if (key) {
      $("#group-key").value = key;
      selectGroup(group.col, key, keepSettings());
    }
  });
  $("#zoom-back").addEventListener("click", () => panBy(-0.5));
  $("#zoom-ahead").addEventListener("click", () => panBy(0.5));
  $("#zoom-in").addEventListener("click", () => zoomBy(0.5));
  $("#zoom-out").addEventListener("click", () => zoomBy(2));
  $("#zoom-all").addEventListener("click", () => setView(bounds.min, bounds.max));
  $("#zoom-reset").addEventListener("click", resetView);

  // A link opens its example with its settings; a link to a file waits for that file.
  const settings = decodeSettings(location.hash);
  const linked = settings?.ex && $(`#sources button[data-id="${CSS.escape(settings.ex)}"]`);
  if (settings?.file) pending = settings;
  await openExample(linked || $("#sources button[data-id]"), linked ? settings : null);
  if (pending) status(`This link has settings for ${pending.file}. Open that file to apply them.`);
  // A link pasted into this tab only changes the hash; start over from it. (replaceState above fires no event.)
  addEventListener("hashchange", () => location.reload());
}

init();
