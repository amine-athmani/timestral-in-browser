import Papa from "papaparse";
import { BASE, DATA_URL, SERVER, modelUrl } from "./config.js";
import { fanChart, align } from "./chart.js";
import { LEVELS, MAX_CONTEXT as BROWSER_CONTEXT } from "./timestral.js";

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

let table = null; // { rows, timeCol, times, example }
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

const num = (v) => {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};
function parseTime(s) {
  let t = String(s ?? "").trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += "T00:00";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) t += "Z";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? Date.parse(s) : ms;
}

/** Parse a CSV and set up the controls. `example` carries the presets of a bundled dataset. */
function loadCSV(text, name, example = null) {
  const { data, meta } = Papa.parse(text, { header: true, skipEmptyLines: "greedy" });
  const fields = meta.fields.filter(Boolean);
  if (!data.length || !fields.length) return status("This file has no rows or no header row.", true);
  const share = (col, test) => {
    const vals = data.map((r) => r[col]).filter((v) => v != null && String(v).trim() !== "");
    return vals.length ? vals.filter(test).length / vals.length : 0;
  };
  const numeric = fields.filter((f) => share(f, (v) => num(v) != null) >= 0.8);
  const timeCol = fields.find((f) => !numeric.includes(f) && share(f, (v) => !Number.isNaN(parseTime(v))) >= 0.9) ?? null;
  if (!numeric.length) return status("This file has no numeric columns.", true);
  const times = timeCol ? data.map((r) => parseTime(r[timeCol]) / 1000) : null;
  table = { rows: data, times };

  const targets = example?.targets ?? [numeric[0]];
  const covariates = example?.covariates ?? [];
  const check = (f, group, on) =>
    `<label><input type="checkbox" name="${group}" value="${esc(f)}" ${on ? "checked" : ""}>${esc(f)}</label>`;
  $("#targets").innerHTML = numeric.map((f) => check(f, "t", targets.includes(f))).join("");
  $("#covariates").innerHTML = numeric.map((f) => check(f, "c", covariates.includes(f))).join("");
  $("#covariates-box").hidden = numeric.length < 2;
  $("#horizon").value = example?.horizon ?? Math.max(1, Math.min(96, Math.floor(data.length / 5)));

  $("#title").textContent = example?.title ?? name;
  $("#blurb").textContent = example?.blurb
    ?? `${data.length.toLocaleString()} rows${timeCol ? `, time column “${timeCol}”` : ", no time column"}.`;
  $("#source").innerHTML = example
    ? `Data: <a href="${example.source_url}" target="_blank" rel="noopener">${esc(example.source)}</a>, ${esc(example.license)}.`
    : "Your file stays in this tab.";
  lastResult = null;
  view = null;
  syncColumns();
  setOrigins();
  update();
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
function extent() {
  const t = picked("t").map((f) => table.rows.map((r) => num(r[f])));
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

function buildRequest(covs = picked("c")) {
  const targets = picked("t");
  if (!targets.length) throw new Error("Pick at least one column to forecast.");
  if (targets.length > 8 || covs.length > 8) throw new Error("Pick at most 8 columns to forecast and 8 covariates.");
  const h = Math.round(+$("#horizon").value);
  if (!(h >= 1 && h <= 1024)) throw new Error("Steps ahead must be between 1 and 1024.");
  const col = (f) => table.rows.map((r) => num(r[f]));
  const T = targets.map(col), C = covs.map((f) => ffill(col(f)));
  const { n, end } = extent();
  const start = Math.max(0, cut - MAX_CONTEXT);
  if (cut - start < 8) throw new Error("Pick a later start: the model needs some history.");

  // The forecast runs from the start to `h` steps past the end of the data, so earlier starts also predict the future.
  const H = end + h - cut;
  const body = { target: T.map((s) => s.slice(start, cut)), horizon: H };
  // Covariates are known ahead where the file has them; rows past the end of the file are left blank.
  if (covs.length) body.knownCovariates = C.map((s) => Array.from({ length: cut + H - start }, (_, i) => (start + i < n ? s[start + i] : null)));

  const xAt = (i) => {
    const t = table.times;
    if (!t) return i;
    if (i < n) return t[i];
    const diffs = t.slice(-50).map((v, j, a) => v - a[j - 1]).slice(1).sort((a, b) => a - b);
    return t[n - 1] + diffs[diffs.length >> 1] * (i - n + 1);
  };
  // The charts hold all the data; they open on a fixed window for every forecast start, from a little before the
  // earliest stop to `h` steps past the data, so moving the start moves the forecast, not the axis.
  const histFrom = 0, histTo = end + h;
  const viewFrom = Math.max(0, Math.min(origins[0] ?? cut, cut) - Math.max(h, 100));
  const notes = [`${(cut - start).toLocaleString()} steps of history`, `${H} steps ahead`];
  if (covs.length) notes.push(`${covs.length} covariate${covs.length > 1 ? "s" : ""}`);
  return {
    body, targets, isTime: !!table.times, notes,
    view: { min: xAt(viewFrom), max: xAt(histTo - 1) },
    // The start line sits on the last point of history, where the forecast lines join it.
    stops: origins.map((c) => xAt(Math.max(0, c - 1))),
    histX: Array.from({ length: histTo - histFrom }, (_, i) => xAt(histFrom + i)),
    hist: T.map((s) => Array.from({ length: histTo - histFrom }, (_, i) => (i + histFrom < end ? s[i + histFrom] : null))),
    start: cut - histFrom,
    dataEnd: end - histFrom,
    fcX: Array.from({ length: H }, (_, i) => xAt(cut + i)),
    actual: T.map((s) => s.slice(cut, end)),
    context: T.map((s) => s.slice(start, cut)),
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

function score(actual, q, context) {
  let err = 0, naive = 0, inside = 0, count = 0;
  actual.forEach((a, v) => {
    const last = context[v].findLast((x) => x != null);
    a.forEach((y, i) => {
      if (y == null) return;
      count++;
      err += Math.abs(q[v][2][i] - y);
      naive += Math.abs(last - y);
      inside += y >= q[v][0][i] && y <= q[v][4][i];
    });
  });
  return count ? { mae: err / count, naive: naive / count, coverage: inside / count, count } : null;
}

function metricsHTML({ mae, naive, coverage }) {
  return `
    <div><dt>Average error</dt><dd>${fmt(mae)}</dd><small>Median forecast against what happened</small></div>
    <div><dt>Repeating the last value</dt><dd>${fmt(naive)}</dd><small>The same error for a naive guess</small></div>
    <div><dt>Inside the 80% range</dt><dd>${Math.round(coverage * 100)}%</dd><small>About 80% means the range is honest</small></div>`;
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
    const plain = covs.length && hasActual ? await runModel(model, buildRequest([]).body, g) : null;
    if (!res || g !== gen || (covs.length && hasActual && !plain)) return;
    const q = res.quantiles.map((v) => v.map((row) => row));
    draw(req, q);
    $("#meta").textContent = [`Timestral-${model}`, ...req.notes].join(" · ");
    const m = hasActual && score(req.actual, q, req.context);
    $("#metrics").innerHTML = m ? metricsHTML(m) : "";
    if (plain) {
      const m0 = score(req.actual, plain.quantiles, req.context);
      const change = Math.round((1 - m.mae / m0.mae) * 100);
      $("#effect").innerHTML = change === 0
        ? `With these covariates the average error is <b>${fmt(m.mae)}</b>, against ${fmt(m0.mae)} without them: about the same.`
        : change > 0
        ? `With these covariates the average error is <b>${fmt(m.mae)}</b>, against ${fmt(m0.mae)} without them: <b class="good">${change}% lower</b>.`
        : `With these covariates the average error is <b>${fmt(m.mae)}</b>, against ${fmt(m0.mae)} without them: <b class="bad">${-change}% higher</b>.`;
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
  URL.revokeObjectURL(a.href);
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
  const readFile = (f) => f && f.text().then((t) => { select(null); loadCSV(t, f.name); });
  $("#file").addEventListener("change", (e) => readFile(e.target.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); });

  $("#targets").addEventListener("change", () => { syncColumns(); setOrigins(cut); update(); });
  $("#covariates").addEventListener("change", update);
  $("#horizon").addEventListener("change", () => { view = null; setOrigins(); update(); });
  $("#model").addEventListener("change", () => armed && update());
  $("#form").addEventListener("submit", (e) => { e.preventDefault(); armed = true; clearTimeout(timer); run(); });
  $("#download").addEventListener("click", downloadCSV);
  $("#zoom-back").addEventListener("click", () => panBy(-0.5));
  $("#zoom-ahead").addEventListener("click", () => panBy(0.5));
  $("#zoom-in").addEventListener("click", () => zoomBy(0.5));
  $("#zoom-out").addEventListener("click", () => zoomBy(2));
  $("#zoom-all").addEventListener("click", () => setView(bounds.min, bounds.max));
  $("#zoom-reset").addEventListener("click", resetView);
  openExample($("#sources button[data-id]"));
}

init();
