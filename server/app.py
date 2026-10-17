"""Serves the site and runs Timestral with the official Python package (used by the Docker image)."""

import math
import os
import threading
import time
from functools import lru_cache
from typing import Literal

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator
from timestral import TimestralForecaster

MAX_CONTEXT = 16384
Rows = list[list[float | None]]
lock = threading.Lock()  # one forecast at a time; torch already uses every core


@lru_cache(maxsize=None)
def load(size: str) -> TimestralForecaster:
    # Downloads the weights from Hugging Face on first use (cached in HF_HOME).
    return TimestralForecaster.from_pretrained(f"mistralai/Timestral-{size}")


class Request(BaseModel):
    model: Literal["5M", "28M", "123M", "209M"] = "28M"
    target: Rows = Field(description="Series x time. null marks a missing value.")
    horizon: int = Field(ge=1, le=8192)  # steps ahead, plus the gap from an earlier start to the end of the data
    pastCovariates: Rows | None = None
    knownCovariates: Rows | None = None

    @model_validator(mode="after")
    def check(self):
        t = len(self.target[0]) if self.target else 0
        if not 1 <= len(self.target) <= 8 or not 2 <= t <= MAX_CONTEXT or any(len(r) != t for r in self.target):
            raise ValueError(f"target needs 1 to 8 rows of the same length, 2 to {MAX_CONTEXT} steps")
        for name, rows, length in [("pastCovariates", self.pastCovariates, t),
                                   ("knownCovariates", self.knownCovariates, t + self.horizon)]:
            if rows and (len(rows) > 8 or any(len(r) != length for r in rows)):
                raise ValueError(f"{name} needs at most 8 rows of length {length}")
        if not any(v is not None and math.isfinite(v) for r in self.target for v in r):
            raise ValueError("target has no values")
        return self


def array(rows: Rows | None):
    return None if not rows else np.array([[np.nan if v is None else v for v in r] for r in rows], dtype=float)[None]


app = FastAPI(title="Timestral")


@app.post("/api/forecast")
def forecast(req: Request):
    try:
        model = load(req.model)
    except Exception as err:  # usually no network on the first run of a model
        raise HTTPException(503, f"Could not load Timestral-{req.model}: {err}") from err
    with lock, torch.inference_mode():
        start = time.perf_counter()
        out = model.forecast(array(req.target), req.horizon,
                                       past_covariates=array(req.pastCovariates),
                                       known_covariates=array(req.knownCovariates))
        seconds = time.perf_counter() - start
    return {"quantiles": out.quantiles[0].numpy().round(5).tolist(), "seconds": seconds}  # series x horizon x 21


app.mount("/", StaticFiles(directory=os.environ.get("SITE_DIR", "dist"), html=True), name="site")
