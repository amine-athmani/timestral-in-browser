import Papa from "papaparse";
import { BASE, DATA_URL, SERVER, modelUrl } from "./config.js";
import { fanChart, align } from "./chart.js";
import { LEVELS, MAX_CONTEXT as BROWSER_CONTEXT } from "./timestral.js";
import { parseTable, season, median } from "./data.js";
import { score, pool, change } from "./metrics.js";

const $ = (s) => document.querySelector(s);
const fmt = (v) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : +v.toPrecision(3));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// In the browser build the model runs in a Web Worker; the Docker build asks the Python server instead.
const MAX_CONTEXT = SERVER ? 16384 : BROWSER_CONTEXT;
const worker = SERVER ? null : new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
worker?.postMessage({ init: { urls: { "5M": modelUrl("5M"), "28M": modelUrl("28M") } } });
const SHOWN = [0.1, 0.25, 0.5, 0.75, 0.9].map((l) => LEVELS.indexOf(l));
let nextId = 0;
let gen = 0; // bumped on every run; results from older runs are dropped

let table = null; // { rows, times, name, season }: rows hold numbers or null
let lastResult = null;
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

/** Parse a CSV and set up the controls. `example` carries the presets of a bundled dataset. False on failure. */
function loadCSV(text, name, example = null) {
  let parsed;
  try { parsed = parseTable(text); } catch (err) { status(`Could not open ${name}: ${err.message}`, true); return false; }
  const { fields, rows, timeCol, times, notes } = parsed;
  table = { rows, times, name, season: season(times) };

  const targets = example?.targets ?? [fields[0]];
  const covariates = example?.covariates ?? [];
  // Covariates are known ahead unless the example says otherwise; each one can be switched to past only.
  const known = (f) => !example?.known || example.known.includes(f);
  const check = (f, group, on) =>
    `<label><input type="checkbox" name="${group}" value="${esc(f)}" ${on ? "checked" : ""}>${esc(f)}</label>`;
  $("#targets").innerHTML = fields.map((f) => check(f, "t", targets.includes(f))).join("");
  $("#covariates").innerHTML = fields.map((f) => `<span class="cov-item">${check(f, "c", covariates.includes(f))}`
    + `<label class="ahead" title="On: the model sees its values ahead. Off: only its history.">`
    + `<input type="checkbox" name="k" value="${esc(f)}" ${known(f) ? "checked" : ""}>known ahead</label></span>`).join("");
  $("#covariates-box").hidden = fields.length < 2;
  $("#horizon").value = example?.horizon ?? Math.max(1, Math.min(96, Math.floor(rows.length / 5)));

  $("#title").textContent = example?.title ?? name;
  const facts = [`${rows.length.toLocaleString()} rows`, timeCol ? `time column “${timeCol}”` : "no time column", ...notes];
  $("#blurb").textContent = example?.blurb ?? `${facts.join(", ")}.`;
  $("#source").innerHTML = example
    ? `Data: <a href="${example.source_url}" target="_blank" rel="noopener">${esc(example.source)}</a>, ${esc(example.license)}.`
    : "Your file stays in this tab.";
  lastResult = null;
  view = null;
  syncColumns();
  setOrigins();
  update();
  return true;
}

const picked = (group) => [...document.querySelectorAll(`input[name="${group}"]:checked`)].map((i) => i.value);
function syncColumns() {
  // A column cannot be both a forecast target and a covariate.
  const t = picked("t");
  document.querySelectorAll('input[name="c"]').forEach((c) => {
    c.disabled = t.includes(c.value);
    if (c.disabled) c.checked = false;
  });
}

/* ---------- The forecast start ---------- */

/** Rows with data in the forecast columns, and the trailing rows that only carry future covariates. */
const col = (f) => table.rows.map((r) => r[f]);
function extent() {
  const t = picked("t").map(col);
  const n = table.rows.length;
  let end = n;
  while (end > 0 && t.every((s) => s[end - 1] == null)) end--;
  return { n, end };
}

let cut = 0; // row where the forecast starts
let origins = []; // where the forecast can start: rows one horizon apart, ending at the end of the data
const ORIGINS = 8;

function originLabel(c) {
  const { end } = extent();
  if (c >= end) return "end of data";
  if (!table.times) return `row ${c}`;
  const d = new Date(table.times[c] * 1000).toISOString(); // the first forecast step
  return d.slice(11, 16) === "00:00" ? d.slice(0, 10) : d.slice(0, 16).replace("T", " ");
}

/** Rebuild the forecast start stops. Keeps `prefer` if it is still a stop; defaults to one horizon back. */
function setOrigins(prefer = null) {
  const { end } = extent();
  const h = Math.max(1, Math.round(+$("#horizon").value) || 1);
  origins = [];
  for (let k = 0; k < ORIGINS && end - k * h >= 16; k++) origins.unshift(end - k * h);
  if (!origins.length) origins.push(end);
  cut = origins.includes(prefer) ? prefer : origins.at(-2) ?? origins.at(-1);
  $("#origin-label").textContent = originLabel(cut);
}

/* ---------- Forecasting ---------- */

const ffill = (arr) => {
  let last = arr.find((v) => v != null) ?? 0;
  return arr.map((v) => (v == null ? last : (last = v)));
};

/**
 * The forecast request from row `at`, with what the charts and scores need. It runs `h` steps past the end of the
 * data, or with `backtest` only `h` steps from `at` (and no further than the end of the data).
 */
function buildRequest({ covs = picked("c"), at = cut, backtest = false } = {}) {
  const targets = picked("t");
  if (!targets.length) throw new Error("Pick at least one column to forecast.");
  if (targets.length > 8 || covs.length > 8) throw new Error("Pick at most 8 columns to forecast and 8 covariates.");
  const h = Math.round(+$("#horizon").value);
  if (!(h >= 1 && h <= 1024)) throw new Error("Steps ahead must be between 1 and 1024.");
  const ahead = new Set(picked("k"));
  const known = covs.filter((f) => ahead.has(f)), past = covs.filter((f) => !ahead.has(f));
  const T = targets.map(col);
  const { n, end } = extent();
  const start = Math.max(0, at - MAX_CONTEXT);
  if (at - start < 8) throw new Error("Pick a later start: the model needs some history.");

  // The forecast runs from the start to `h` steps past the end of the data, so earlier starts also predict the future.
  const H = backtest ? Math.min(h, end - at) : end + h - at;
  const body = { target: T.map((s) => s.slice(start, at)), horizon: H };
  // Known covariates are given ahead where the file has them; rows past the end of the file are left blank.
  if (known.length) body.knownCovariates = known.map((f) => ffill(col(f))).map((s) =>
    Array.from({ length: at + H - start }, (_, i) => (start + i < n ? s[start + i] : null)));
  // Past-only covariates stop at the forecast start, like a measurement that only arrives as it happens.
  if (past.length) body.pastCovariates = past.map((f) => ffill(col(f)).slice(start, at));

  const t = table.times;
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
    fcX: Array.from({ length: H }, (_, i) => xAt(at + i)),
    actual: T.map((s) => s.slice(at, Math.min(end, at + H))),
    context: T.map((s) => s.slice(start, at)),
  };
}

const toShown = (quantiles) => quantiles.map((series) => SHOWN.map((k) => series.map((qs) => qs[k])));

async function runOnServer(model, request) {
  const res = await fetch(`${BASE}api/forecast`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, ...request }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error([json.detail].flat().map((d) => d?.msg ?? d).join("; ") || `Server error ${res.status}`);
  return { quantiles: toShown(json.quantiles), seconds: json.seconds };
}

/** Forecast. Resolves to quantiles as variates x 5 shown levels x horizon, or null if overtaken. */
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
      resolve({ quantiles: toShown(data.quantiles), seconds: data.seconds });
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, gen: g, model, request });
  });
}

// The naive guess to beat: the last seasonal cycle when the data has one, the last value otherwise.
const naiveName = () => (table.season.m > 1 ? `repeating the last ${table.season.name}` : "repeating the last value");
const naiveError = (m) => (table.season.m > 1 ? m.seasonal : m.naive);
const pct = (v) => `${Math.round(v * 100)}%`;
/** "12% lower than", for a percent change in error; empty when there is nothing to compare. */
const versus = (d) => (d == null ? "" : d === 0 ? "about the same as" : d < 0
  ? `<b class="good">${-d}% lower</b> than` : `<b class="bad">${d}% higher</b> than`);

function metricsHTML(m) {
  const name = naiveName();
  return `
    <div><dt>Average error</dt><dd>${fmt(m.mae)}</dd><small>Median forecast against what happened</small></div>
    <div><dt>${name[0].toUpperCase() + name.slice(1)}</dt><dd>${fmt(naiveError(m))}</dd><small>The same error for a naive guess</small></div>
    <div><dt>Scaled error</dt><dd>${m.mase == null ? "–" : m.mase.toFixed(2)}</dd><small>MASE: under 1 beats a naive guess on the history</small></div>
    <div><dt>Inside the 80% range</dt><dd>${pct(m.coverage)}</dd><small>About 80% means the range is honest</small></div>`;
}

function draw(req, q) {
  renderCharts(req.targets.map((label, v) => ({
    label, view: req.view, stops: req.stops,
    ...align({ histX: req.histX, histY: req.hist[v], start: req.start, dataEnd: req.dataEnd, fcX: req.fcX, quantiles: q[v] }),
  })), req.isTime);
}

/** Show the data and the forecast window without running the model. */
function preview() {
  let req;
  try { req = buildRequest(); } catch (err) { return status(err.message, true); }
  draw(req, req.targets.map(() => Array.from({ length: 5 }, () => Array(req.fcX.length).fill(null))));
  $("#meta").textContent = req.notes.join(" · ");
  $("#metrics").innerHTML = "";
  $("#effect").textContent = "";
  $("#download").hidden = true;
  syncBacktest();
  status(armed ? "" : "Press Run forecast to compute it.");
}

async function run() {
  let req;
  try { req = buildRequest(); } catch (err) { return status(err.message, true); }
  const g = ++gen;
  const model = $("#model").value;
  const covs = picked("c");
  const hasActual = req.actual.some((s) => s.some((v) => v != null));
  status(SERVER ? "Forecasting on this computer. The first run of a model downloads it." : "Forecasting…");
  $("#run").disabled = true;
  try {
    const res = await runModel(model, req.body, g);
    // With covariates and something to compare against, also forecast without them to show their effect.
    const plain = covs.length && hasActual ? await runModel(model, buildRequest({ covs: [] }).body, g) : null;
    if (!res || g !== gen || (covs.length && hasActual && !plain)) return;
    const q = res.quantiles.map((v) => v.map((row) => row));
    draw(req, q);
    $("#meta").textContent = [`Timestral-${model}`, ...req.notes].join(" · ");
    const m = hasActual && score(req.actual, q, req.context, table.season.m);
    $("#metrics").innerHTML = m ? metricsHTML(m) : "";
    const m0 = plain && score(req.actual, plain.quantiles, req.context, table.season.m);
    if (m && m0) {
      const d = versus(change(m.mae, m0.mae)) || "against";
      $("#effect").innerHTML = `With these covariates the average error is <b>${fmt(m.mae)}</b>, ${d} ${fmt(m0.mae)} without them.`;
    } else {
      $("#effect").textContent = covs.length ? "Pick an earlier start to measure what the covariates change." : "";
    }
    $("#download").hidden = false;
    lastResult = { req, q };
    const secs = res.seconds + (plain?.seconds ?? 0);
    status(`Done in ${secs.toFixed(secs < 10 ? 1 : 0)} s on this device${plain ? ", with and without covariates" : ""}.`);
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
  if (armed) timer = setTimeout(run, 250);
}

function downloadCSV() {
  const { req, q } = lastResult;
  const when = (x) => (req.isTime ? new Date(x * 1000).toISOString().slice(0, 16).replace("T", " ") : x);
  const head = ["time", ...req.targets.flatMap((t) => ["q10", "q25", "median", "q75", "q90"].map((k) => `${t} ${k}`))];
  const lines = req.fcX.map((x, i) => [when(x), ...q.flatMap((v) => v.map((row) => row[i]))]);
  const csv = Papa.unparse({ fields: head, data: lines });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "timestral-forecast.csv",
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000); // revoking at once can cancel the download in some browsers
}

/* ---------- Backtest: forecast from every start and pool the scores ---------- */

let backtested = null; // { key, rows: [{ at, s, s0 }], total, model, covs }

// Results hold while the data, columns, horizon and model stay the same; moving the start keeps them.
const backtestKey = () => JSON.stringify([table?.name, picked("t"), picked("c"), picked("k"), $("#horizon").value, $("#model").value]);
const backtestStarts = () => origins.filter((c) => c < extent().end);

function syncBacktest() {
  $("#backtest-box").hidden = backtestStarts().length < 2;
  if (backtested && backtested.key !== backtestKey()) backtested = null;
  renderBacktest();
}

function renderBacktest() {
  const box = $("#backtest-table"), summary = $("#backtest-summary");
  if (!backtested?.rows.length) return void ((box.innerHTML = ""), (summary.innerHTML = ""));
  const { rows, total, model, covs } = backtested;
  const p = pool(rows.map((r) => r.s));
  const lines = [`Timestral-${model} from ${rows.length}${rows.length < total ? ` of ${total}` : ""} starts,`
    + ` ${p.count.toLocaleString()} points: average error <b>${fmt(p.mae)}</b>,`
    + ` ${versus(change(p.mae, naiveError(p))) || "against"} ${naiveName()} (${fmt(naiveError(p))}).`
    + ` The 80% range held <b>${pct(p.coverage)}</b> of what happened.`];
  const p0 = covs && pool(rows.map((r) => r.s0));
  if (p0) {
    const wins = rows.filter((r) => r.s && r.s0 && r.s.mae < r.s0.mae).length;
    lines.push(`With the covariates the error is ${versus(change(p.mae, p0.mae)) || "against"} without them`
      + ` (${fmt(p0.mae)}), and lower at ${wins} of ${rows.length} starts.`);
  }
  summary.innerHTML = lines.join(" ");
  const cell = (v, digits) => (v == null ? "–" : digits ? v.toFixed(digits) : fmt(v));
  box.innerHTML = `<thead><tr><th>Start</th><th>Error</th><th>Naive</th><th>MASE</th><th>In 80%</th>`
    + `${covs ? "<th>No covariates</th>" : ""}</tr></thead><tbody>`
    + rows.map(({ at, s, s0 }) => `<tr data-at="${at}"${at === cut ? ' class="current"' : ""}>`
      + `<td><button type="button" class="link">${esc(originLabel(at))}</button></td><td>${cell(s?.mae)}</td>`
      + `<td>${cell(s && naiveError(s))}</td><td>${cell(s?.mase, 2)}</td><td>${s ? pct(s.coverage) : "–"}</td>`
      + `${covs ? `<td>${cell(s0?.mae)}</td>` : ""}</tr>`).join("") + "</tbody>";
}

async function backtest() {
  const starts = backtestStarts();
  if (!starts.length) return;
  clearTimeout(timer);
  const g = ++gen;
  const model = $("#model").value, covs = picked("c").length > 0, m = table.season.m;
  backtested = { key: backtestKey(), rows: [], total: starts.length, model, covs };
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

/* ---------- Wiring ---------- */

async function init() {
  const examples = await fetch(`${DATA_URL}examples.json`).then((r) => r.json());
  const select = (button) => $("#sources").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === button));
  $("#sources").insertAdjacentHTML("afterbegin", examples.map((ex) =>
    `<button type="button" data-id="${ex.id}" aria-pressed="false">${esc(ex.title)}<span>${esc(ex.freq)}</span></button>`).join(""));
  const openExample = async (button) => {
    const ex = examples.find((x) => x.id === button.dataset.id);
    select(button);
    loadCSV(await fetch(`${DATA_URL}${ex.id}.csv`).then((r) => r.text()), `${ex.id}.csv`, ex);
  };
  $("#sources").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) openExample(b);
  });

  const drop = $("#drop");
  // A file that fails to open leaves the current data, and its example button, as they were.
  const readFile = (f) => f && f.text().then((t) => loadCSV(t, f.name) && select(null));
  $("#file").addEventListener("change", (e) => {
    readFile(e.target.files[0]);
    e.target.value = ""; // so opening the same file again fires another change
  });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); });

  $("#targets").addEventListener("change", () => { syncColumns(); setOrigins(cut); update(); });
  $("#covariates").addEventListener("change", update);
  $("#horizon").addEventListener("change", () => { view = null; setOrigins(); update(); });
  $("#model").addEventListener("change", () => armed && update());
  $("#form").addEventListener("submit", (e) => { e.preventDefault(); armed = true; clearTimeout(timer); run(); });
  $("#download").addEventListener("click", downloadCSV);
  $("#backtest").addEventListener("click", backtest);
  // A start in the backtest table moves the forecast start there.
  $("#backtest-table").addEventListener("click", (e) => {
    const i = origins.indexOf(+e.target.closest("button.link")?.closest("tr").dataset.at);
    if (i >= 0) moveStart(i, true);
  });
  $("#zoom-back").addEventListener("click", () => panBy(-0.5));
  $("#zoom-ahead").addEventListener("click", () => panBy(0.5));
  $("#zoom-in").addEventListener("click", () => zoomBy(0.5));
  $("#zoom-out").addEventListener("click", () => zoomBy(2));
  $("#zoom-all").addEventListener("click", () => setView(bounds.min, bounds.max));
  $("#zoom-reset").addEventListener("click", resetView);
  openExample($("#sources button[data-id]"));
}

init();
