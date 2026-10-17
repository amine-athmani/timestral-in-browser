---
license: other
license_name: mistral-modified-mit
license_link: LICENSE
base_model:
  - mistralai/Timestral-5M
  - mistralai/Timestral-28M
  - mistralai/Timestral-123M
  - mistralai/Timestral-209M
pipeline_tag: time-series-forecasting
library_name: onnxruntime
tags:
  - onnx
  - onnxruntime-web
  - time-series
  - forecasting
---

# Timestral ONNX

ONNX exports of [Timestral-5M](https://huggingface.co/mistralai/Timestral-5M),
[Timestral-28M](https://huggingface.co/mistralai/Timestral-28M),
[Timestral-123M](https://huggingface.co/mistralai/Timestral-123M) and
[Timestral-209M](https://huggingface.co/mistralai/Timestral-209M), Mistral AI's time series forecasting models, for
running in the browser with onnxruntime-web. They power the
[Timestral in the browser](https://amine-athmani.github.io/timestral-in-browser/) demo.

## Precision: float16 weights

The `.onnx` file stores its weights in **float16** to halve the download (tensors under 1,024 values stay float32).
They are cast back to float32 when the session loads, so the computation itself runs in float32. Forecasts stay within about 3e-4 of the largest
forecast value compared with the full-precision model. These are not the float32 exports. To get those, run
[`scripts/export_onnx.py`](https://github.com/amine-athmani/timestral-in-browser/blob/main/scripts/export_onnx.py),
which writes both versions.

## What the file contains

One decoding pass of the official model, including the rescaling of its output, for any number of series, covariate
rows and history lengths (multiples of 32 steps).

Inputs:

| name | type | shape |
|---|---|---|
| `x` | float32 | rows × T, history, T a multiple of 32 |
| `obs` | bool | rows × T, false where a value is missing |
| `group_ids` | int64 | rows, rows with the same id belong to one series |
| `role_ids` | int64 | rows, 0 target, 1 past-only covariate, 2 known-future covariate |
| `known_future` | float32 | rows × H, future covariate values, H a multiple of 32 up to 1024 |
| `known_future_mask` | bool | rows × H |

Outputs: `quantiles` float32, rows × H × 21 (levels 0.01 to 0.99), and `last_scale` float32, rows.

The rest of the forecast (preparing rows, decoding past 1,024 steps, averaging with the mirrored series, clipping)
is in [`timestral.js`](https://github.com/amine-athmani/timestral-in-browser/blob/main/web/src/lib/timestral.js). Against
the official Python package, forecasts match within 3e-4 of the largest forecast value on the test suite in that
repository.

## License

The weights are released by Mistral AI under the Modified MIT license in `LICENSE`, which applies to these exports.
Attribution notice: 2026 - Mistral AI.
