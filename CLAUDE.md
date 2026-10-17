# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A forecasting playground for Mistral's Timestral time series models. One Astro site (`web/`) with two backends,
picked at build time by `PUBLIC_BACKEND`:

- **Browser (default, GitHub Pages):** the model runs in a Web Worker with onnxruntime-web. Only 5M and 28M.
- **Server (`PUBLIC_BACKEND=server`, Docker):** `server/app.py` (FastAPI) runs the official `timestral` Python
  package and serves the built site; all four sizes (5M, 28M, 123M, 209M).

## Commands

```bash
# Python tools (export, datasets, fixtures). Python 3.11 + uv.
uv venv -p 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python scripts/export_onnx.py 5M 28M     # writes onnx/ (fp32) and web/public/models/ (fp16 weights)
.venv/bin/python scripts/build_datasets.py         # refreshes web/public/data/*.csv + examples.json

# Site (Node 20+). Dev loads models from web/public/models/, so export first.
cd web && npm install && npm run dev               # http://localhost:4321
npm run build                                      # web/dist

# Parity tests: JS forecaster vs. the Python package (run from repo root)
.venv/bin/python tests/parity/make_fixtures.py     # writes tests/parity/fixtures.json (5M and 28M cases)
node tests/parity/parity.test.mjs                  # fp32 graphs in onnx/, tolerance 1e-5
SITE=1 node tests/parity/parity.test.mjs           # fp16 files in web/public/models/, tolerance 1e-3

# Docker (server backend)
docker build -t timestral-demo .
docker run --rm -p 8000:8000 -v timestral-cache:/cache timestral-demo
```

There is no linter. `cd web && npm test` runs the unit tests in `web/test/` (`node --test`) for the DOM-free
modules (`data.js`, `metrics.js`, `plan.js`, `settings.js`); CI (`.github/workflows/ci.yml`) runs them plus both builds on every pull request. The parity script
checks the model port (exit code 1 on failure). To run a single parity case, filter `fixtures` in
`parity.test.mjs` by `fx.name` / `fx.model`.

`onnx/`, `web/public/models/` and `tests/parity/fixtures.json` are generated and git-ignored.

## Architecture

The core idea: the ONNX graph is only **one decoding step**; the forecast loop lives in JS.

- `scripts/export_onnx.py` exports `Step` = `predict_block` + `_refine_block` for a block of 1–32 patches
  (patch size 32), plus the last-patch scale used to cap quantiles. It monkey-patches parts of the `timestral`
  package that ONNX cannot trace (cummax, a data-dependent `while` in the Welford scan, an early return). After
  export it rewrites bool `Where` nodes (onnxruntime-web has no kernel) and writes an fp16-weight copy
  (int8 quantization was tried and rejected: too inaccurate). The `timestral` package is pinned to a commit in
  `requirements.txt`; the patches depend on its internals.
- `web/src/lib/timestral.js` is a JS port of `TimestralForecaster.forecast` (`timestral/forecaster.py`): row
  assembly, windowing/padding, the block loop, feedback, symmetric averaging and clipping. It takes the `ort`
  module as a parameter so it runs under onnxruntime-web (browser) and onnxruntime-node (tests). Changes to the
  forecast logic must keep parity with the Python package. Browser context is capped at `MAX_CONTEXT = 4096`
  (models accept 32768).
- `web/src/lib/worker.js` downloads the model (Cache API, progress messages), keeps one session per size, and
  serializes requests; a request with an older `gen` is answered `skipped`.
- `web/src/lib/config.js`: model URLs. Dev (or `PUBLIC_MODEL_BASE`) loads `web/public/models/`; production loads
  from the Hugging Face repos in `HF_ONNX` (`amine40/Timestral-{5M,28M}-ONNX`). `hf/` holds their model card and
  license.
- `web/src/lib/data.js` parses CSVs in three steps: `readCSV` (Papa Parse), `inspect` (numeric columns and decimal
  comma, time column from dates or years, text columns that name the series of a long table) and `buildTable` (one
  series, rows sorted by time). It also infers the seasonal cycle from the time step. `web/src/lib/metrics.js`
  scores forecasts: MAE, last-value and seasonal naive baselines, MASE, 80% coverage, and pooling across starts.
  `web/src/lib/plan.js` works on the 21 quantiles: service levels, totals over a period (sum of per-step
  quantiles, a deliberately wide range), scenario edits on known covariates, and the outlook used to rank series.
  `web/src/lib/settings.js` encodes the view in the URL hash. None of these touches the DOM.
- `web/src/lib/views.js` returns HTML strings for the result panels (metrics, backtest, plan, scenario editor,
  series ranking); `web/src/lib/report.js` prints a report, redrawing the charts in the light theme
  (`html[data-print]`) to capture them as images.
- `web/src/lib/app.js` drives the workbench UI (`components/Workbench.astro`): the series picker for long tables,
  target/covariate selection (each covariate known ahead or past only, sent as `knownCovariates` /
  `pastCovariates`), the result tabs (Accuracy, Plan, Scenario, All series), the URL hash kept in sync with
  `history.replaceState`, the draggable forecast-start line drawn by `chart.js` (`origins`: stops one horizon apart,
  ending at the end of the data), building the request, metrics vs. naive baselines, a second run without
  covariates to show their effect, and a backtest that forecasts `horizon` steps from every stop and pools the
  scores. The forecast always runs from the chosen start to `horizon` steps past the end
  of the data, so earlier starts both backtest and predict ahead. Same request shape goes to the worker or to
  `POST /api/forecast`.
- `web/src/lib/chart.js`: uPlot fan chart. `align()` lays history, actuals, quantile bands (q10/q25/q50/q75/q90)
  and the dotted "median ahead" on one x axis; colors come from CSS variables in `styles/global.css`, and charts
  redraw on color-scheme change.
- `web/public/coi-serviceworker.min.js` provides cross-origin isolation on GitHub Pages (needed for threaded WASM).

## Deploy

`.github/workflows/deploy-pages.yml` builds `web/` on pushes to `main` that touch `web/**`, setting `SITE`,
`BASE_PATH` (`/<repo>` for project sites) and `PUBLIC_GITHUB_URL`. Use `BASE` from `config.js` for any URL, never a
hard-coded `/`.
