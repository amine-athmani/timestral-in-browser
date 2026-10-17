# Timestral in the browser

A forecasting playground for [Timestral](https://mistral.ai/news/timestral/), Mistral AI's time series models.
Pick an example or open a CSV, slide the forecast start back in time, and compare the forecast with what happened
and with what comes next.

It runs two ways:

- **Website (GitHub Pages):** the model runs in your browser with onnxruntime-web. Timestral-5M and 28M, nothing
  is uploaded.
- **Docker:** the same page, backed by the official Python package on your computer. All four sizes (5M, 28M,
  123M, 209M) at full precision.

Not affiliated with Mistral AI.

## Run it with Docker

```bash
docker build -t timestral-demo .
docker run --rm -p 8000:8000 -v timestral-cache:/cache timestral-demo
```

Open http://localhost:8000. Each model size downloads from Hugging Face the first time you use it (209M is
837 MB); the `timestral-cache` volume keeps them between runs. Forecasts run on the CPU.

## Develop the website

Needs Node.js 20 or later. In development the page loads the browser models from `web/public/models/`, so export
them first (next section).

```bash
cd web
npm install
npm run dev        # http://localhost:4321
npm test           # unit tests for CSV parsing and scoring
```

Pull requests run the unit tests and both site builds (`.github/workflows/ci.yml`).

## Export the models

Needs Python 3.11 and [uv](https://docs.astral.sh/uv/).

```bash
uv venv -p 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt

.venv/bin/python scripts/export_onnx.py 5M 28M   # onnx/ (float32) and web/public/models/ (float16 weights)
.venv/bin/python scripts/build_datasets.py       # refreshes the example CSVs in web/public/data/
```

Check the browser forecaster against the official package:

```bash
.venv/bin/python tests/parity/make_fixtures.py
node tests/parity/parity.test.mjs                 # float32 export
SITE=1 node tests/parity/parity.test.mjs          # float16 files used by the site
```

## Publish

The site loads the browser models from Hugging Face:
[amine40/Timestral-5M-ONNX](https://huggingface.co/amine40/Timestral-5M-ONNX) and
[amine40/Timestral-28M-ONNX](https://huggingface.co/amine40/Timestral-28M-ONNX). The repo names are in
`web/src/lib/config.js`.

Push to GitHub and set Settings → Pages → Source to **GitHub Actions**. Every push to `main` rebuilds the site.

## Layout

```
web/                    Astro site
  src/lib/timestral.js  JS port of the official forecast function
  src/lib/worker.js     runs the ONNX model in a Web Worker
  src/lib/data.js       CSV parsing, time column and seasonal cycle
  src/lib/metrics.js    forecast scores and naive baselines
  test/                 unit tests (node --test)
server/                 FastAPI server for the Docker image
scripts/                ONNX export and example datasets
tests/parity/           browser forecaster vs. Python package
hf/                     model card and license for the Hugging Face repos
```

The site's "How it works" page explains the export and its limits.

## License

Code: Apache 2.0. Timestral weights and their ONNX exports: Mistral AI's [Modified MIT license](hf/LICENSE).
Example data: NOAA GML (public domain), SILSO (CC BY-NC 4.0), Wikimedia (CC0), Open-Meteo (CC BY 4.0), UCI
Machine Learning Repository (CC BY 4.0).
