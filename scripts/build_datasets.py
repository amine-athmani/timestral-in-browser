"""Download the example datasets and write them as CSV files for the website.

Writes web/public/data/<id>.csv and web/public/data/examples.json (titles, sources and the
column and horizon presets the page starts from). Run from the repo root:
    python scripts/build_datasets.py
"""

import io
import json
import zipfile
from pathlib import Path

import pandas as pd
import requests

OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "data"
HEADERS = {"User-Agent": "timestral-demo/1.0 (https://github.com/mistralai/timestral)"}


def get(url: str) -> bytes:
    r = requests.get(url, headers=HEADERS, timeout=60)
    r.raise_for_status()
    return r.content


# Each loader returns a DataFrame indexed by timestamp, one column per series.

def co2():
    df = pd.read_csv(io.BytesIO(get("https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_mm_mlo.csv")), comment="#")
    idx = pd.to_datetime(dict(year=df.year, month=df.month, day=1))
    return pd.DataFrame({"CO2 (ppm)": df.average.where(df.average > 0).values}, index=idx)


def sunspots():
    df = pd.read_csv(io.BytesIO(get("https://www.sidc.be/SILSO/INFO/snmtotcsv.php")), sep=";", header=None)
    idx = pd.to_datetime(dict(year=df[0], month=df[1], day=1))
    return pd.DataFrame({"Sunspot number": df[3].where(df[3] >= 0).values}, index=idx)


def wikipedia():
    url = ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/"
           "Python_(programming_language)/daily/20220101/20260930")
    items = json.loads(get(url))["items"]
    idx = pd.to_datetime([i["timestamp"][:8] for i in items])
    return pd.DataFrame({"Daily views": [i["views"] for i in items]}, index=idx).asfreq("D")


def weather():
    url = ("https://archive-api.open-meteo.com/v1/archive?latitude=48.85&longitude=2.35"
           "&start_date=2026-04-01&end_date=2026-09-30&hourly=temperature_2m,relative_humidity_2m&timezone=UTC")
    h = json.loads(get(url))["hourly"]
    idx = pd.to_datetime(h["time"])
    return pd.DataFrame({"Temperature (°C)": h["temperature_2m"], "Humidity (%)": h["relative_humidity_2m"]},
                        index=idx)


def bikes():
    z = zipfile.ZipFile(io.BytesIO(get("https://archive.ics.uci.edu/static/public/275/bike+sharing+dataset.zip")))
    df = pd.read_csv(z.open("hour.csv"))
    df.index = pd.to_datetime(df.dteday) + pd.to_timedelta(df.hr, unit="h")
    df = df.asfreq("h")  # the source skips hours with no data; keep them as missing
    # Weather columns: covariate gaps are filled forward, the rentals keep their gaps.
    cov = df[["temp", "hum", "windspeed", "weathersit", "holiday"]].ffill()
    cov.insert(4, "workingday", (df.index.dayofweek < 5) & (cov.holiday == 0))
    return df[["cnt"]].rename(columns={"cnt": "Rentals per hour"}).join(cov.astype(float))


EXAMPLES = [
    dict(id="co2", load=co2, horizon=60, title="Atmospheric CO2", freq="Monthly",
         blurb="Monthly CO2 at Mauna Loa since 1958: a steady rise with a yearly cycle.",
         source="NOAA Global Monitoring Laboratory", source_url="https://gml.noaa.gov/ccgg/trends/",
         license="Public domain"),
    dict(id="sunspots", load=sunspots, horizon=132, title="Sunspots", freq="Monthly",
         blurb="Monthly sunspot counts since 1749. The cycle lasts about 11 years and every peak is different.",
         source="SILSO, Royal Observatory of Belgium", source_url="https://www.sidc.be/SILSO/", license="CC BY-NC 4.0"),
    dict(id="wikipedia", load=wikipedia, horizon=56, title="Wikipedia views", freq="Daily",
         blurb="Daily views of the English Wikipedia article on Python, with a weekly rhythm and holiday dips.",
         source="Wikimedia Pageviews API", source_url="https://wikimedia.org/api/rest_v1/", license="CC0"),
    dict(id="weather", load=weather, horizon=72, targets=["Temperature (°C)", "Humidity (%)"], title="Paris weather", freq="Hourly",
         blurb="Hourly temperature and humidity in Paris. Both columns are forecast together.",
         source="Open-Meteo", source_url="https://open-meteo.com/", license="CC BY 4.0"),
    dict(id="bikes", load=bikes, horizon=168, title="Bike rentals", freq="Hourly",
         blurb="Hourly bike rentals in Washington, D.C., in 2011 and 2012, with weather and holiday columns "
               "you can use as covariates.",
         source="UCI Machine Learning Repository", source_url="https://archive.ics.uci.edu/dataset/275/bike+sharing+dataset",
         license="CC BY 4.0", covariates=["temp", "hum", "weathersit", "workingday", "holiday"]),
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for ex in EXAMPLES:
        df = ex["load"]()
        df = df.loc[df.first_valid_index():]
        df.index.name = "time"
        fmt = "%Y-%m-%d %H:%M" if ex["freq"] == "Hourly" else "%Y-%m-%d"
        df.to_csv(OUT / f"{ex['id']}.csv", date_format=fmt, float_format="%.6g")
        covariates = ex.get("covariates", [])
        meta = {k: v for k, v in ex.items() if k != "load"}
        index.append({**meta, "covariates": covariates, "targets": ex.get("targets", [df.columns[0]])})
        print(ex["id"], len(df), "rows")
    (OUT / "examples.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
