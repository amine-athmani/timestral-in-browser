"""Reference forecasts from the official Python package, for tests/parity/parity.test.mjs.

Run from the repo root:  .venv/bin/python tests/parity/make_fixtures.py
"""

import json
from pathlib import Path

import numpy as np
from timestral import TimestralForecaster

OUT = Path(__file__).resolve().parent / "fixtures.json"


def nan_list(a):
    return [[None if np.isnan(v) else float(v) for v in row] for row in a]


def cases(rng):
    t = np.arange(1500)
    season = 10 + 3 * np.sin(2 * np.pi * t / 24) + rng.normal(0, 0.5, t.size)
    gappy = season.copy()
    gappy[200:260] = np.nan
    gappy[:37] = np.nan
    walk = np.cumsum(rng.normal(0, 1, 900)) - 20  # negative values: no clipping
    temp = 15 + 8 * np.sin(2 * np.pi * np.arange(1500 + 96) / 24)
    load = 50 + 2 * temp[:1500] + rng.normal(0, 1, 1500)
    yield "univariate", dict(context=[season[:1000]], prediction_length=48)
    yield "missing values", dict(context=[gappy[:1200]], prediction_length=100)
    yield "negative walk", dict(context=[walk], prediction_length=64)
    yield "two blocks", dict(context=[season], prediction_length=1100)
    yield "multivariate", dict(context=[season[:800], walk[:800]], prediction_length=40)
    yield "past covariates", dict(context=[load], past_covariates=[temp[:1500]], prediction_length=72)
    yield "known covariates", dict(context=[load], known_covariates=[temp], prediction_length=96)
    yield "short context", dict(context=[season[:20]], prediction_length=10)
    # Past 96 patches: catches a prefix scan frozen at the traced length.
    long = 10 + 3 * np.sin(2 * np.pi * np.arange(5000) / 168) + np.cumsum(rng.normal(0, 0.05, 5000))
    yield "long context", dict(context=[long], prediction_length=200)


def main():
    rng = np.random.default_rng(0)
    fixtures = []
    for size in ["5M", "28M"]:
        f = TimestralForecaster.from_pretrained(f"mistralai/Timestral-{size}")
        for name, kw in cases(rng):
            ctx = np.array(kw["context"], dtype=float)[None]
            extra = {k: np.array(kw[k], dtype=float)[None] for k in ("past_covariates", "known_covariates") if k in kw}
            q = f.forecast(ctx, kw["prediction_length"], **extra).quantiles[0].numpy()  # V x H x 21
            fixtures.append({
                "model": size, "name": name, "horizon": kw["prediction_length"], "target": nan_list(ctx[0]),
                "pastCovariates": nan_list(extra["past_covariates"][0]) if "past_covariates" in extra else None,
                "knownCovariates": nan_list(extra["known_covariates"][0]) if "known_covariates" in extra else None,
                "expected": q.round(5).tolist(),
            })
            print(size, name, q.shape)
    OUT.write_text(json.dumps(fixtures))


if __name__ == "__main__":
    main()
