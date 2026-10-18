// Views of how a series changes over time, with the forecast drawn in the same space:
// - cycles: every day, week or year laid over the same axis, older ones faded, the forecast's cycles on top;
// - state space: each value against the value one step (or one cycle) before, a path that the forecast continues.
// Both replay through time. The data helpers at the top have no DOM and are tested in web/test/.

const DAY = 86400;

/* ---------- Data ---------- */

/**
 * The cycles a series can be laid out by, from its time step (seconds, or null without a time column) and its
 * seasonal length m. Returns [{ id, label }]; "rows" repeats every m rows when there is no time column.
 */
export function cycleOptions(step, m, count) {
  const fits = (len) => len >= 2 && count >= 2 * len; // at least two cycles of at least two points
  if (!step) return m > 1 && fits(m) ? [{ id: "rows", label: `every ${m} rows` }] : [];
  const options = [];
  if (step < DAY && fits(DAY / step)) options.push({ id: "day", label: "day" });
  if (step < 7 * DAY && fits((7 * DAY) / step) && (7 * DAY) / step <= 2000) options.push({ id: "week", label: "week" });
  if (step < 360 * DAY && fits((365 * DAY) / step) && (365 * DAY) / step <= 9000) options.push({ id: "year", label: "year" });
  return options;
}

/**
 * Where a point falls in a cycle: { cycle, phase } with phase from 0 (cycle start) to 1. t: unix seconds (null
 * without a time column), i: its row, m: the cycle length in rows for "rows". Days and weeks are in UTC; weeks
 * start on Monday.
 */
export function placeIn(kind, t, i, m) {
  if (kind === "rows") return { cycle: Math.floor(i / m), phase: (i % m) / m };
  if (kind === "day") return { cycle: Math.floor(t / DAY), phase: (t - Math.floor(t / DAY) * DAY) / DAY };
  if (kind === "week") {
    const d = t / DAY + 3; // 1970-01-01 was a Thursday: +3 makes Monday the start
    return { cycle: Math.floor(d / 7), phase: (d - Math.floor(d / 7) * 7) / 7 };
  }
  const year = new Date(t * 1000).getUTCFullYear(), start = Date.UTC(year, 0, 1) / 1000;
  return { cycle: year, phase: (t - start) / (Date.UTC(year + 1, 0, 1) / 1000 - start) };
}

/**
 * Split a series into cycles, in time order: [{ cycle, start, points: [[phase, value, ...extra]] }].
 * times: unix seconds per point (null without a time column, then `first` is the first point's row);
 * columns: one or more value arrays of the same length (a forecast passes median, low and high). A point is kept
 * when its first value is not null.
 */
export function splitCycles(kind, times, columns, m = 1, first = 0) {
  const out = [];
  columns[0].forEach((value, k) => {
    if (value == null) return;
    const { cycle, phase } = placeIn(kind, times?.[k], first + k, m);
    if (out.at(-1)?.cycle !== cycle) out.push({ cycle, start: times ? times[k] : first + k, points: [] });
    out.at(-1).points.push([phase, ...columns.map((c) => c[k])]);
  });
  return out;
}

/** Delay embedding: [x, y, row] with x the value `lag` rows before y, for rows where both are known. */
export function embed(values, lag) {
  const out = [];
  for (let i = lag; i < values.length; i++) {
    if (values[i] != null && values[i - lag] != null) out.push([values[i - lag], values[i], i]);
  }
  return out;
}

/**
 * The forecast in the same space: for each forecast step, x is the value `lag` steps before (what happened, or the
 * forecast's median past the end of the data) and y its median, with low and high for its range.
 * history: the series up to the end of the data; median/low/high: the forecast from the end of the data.
 */
export function embedForecast(history, median, low, high, lag) {
  const path = history.concat(median);
  return median.map((y, k) => {
    const i = history.length + k;
    return path[i - lag] == null ? null : [path[i - lag], y, low[k], high[k]];
  }).filter(Boolean);
}

/* ---------- Drawing ---------- */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : +v.toPrecision(3));
const PAD = { left: 56, right: 12, top: 12, bottom: 28 };

/** "Nice" round tick values covering [lo, hi]. */
function ticks(lo, hi, count = 5) {
  const raw = (hi - lo) / count, mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw) ?? raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

const PHASE_TICKS = {
  day: [0, 6, 12, 18].map((h) => [h / 24, `${String(h).padStart(2, "0")}:00`]),
  week: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d, i) => [i / 7, d]),
  year: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((mo, i) => [i / 12, mo]),
  rows: [0, 0.25, 0.5, 0.75].map((p) => [p, `${Math.round(p * 100)}%`]),
};

/**
 * The evolution view, drawn into `root` (see Workbench.astro: a canvas, play button, scrubber and label).
 * show(data) draws data = { mode: "cycles" | "space", label, ... } (see app.js); hide() stops any replay.
 */
export function evolutionView(root) {
  const canvas = root.querySelector("canvas"), play = root.querySelector("[data-evo=play]");
  const scrub = root.querySelector("[data-evo=time]"), label = root.querySelector("[data-evo=label]");
  const ctx = canvas.getContext("2d");
  let data = null, frames = 0, frame = 0, raf = 0, last = 0;
  // State-space points accumulate on an offscreen layer as the replay moves on, so a frame only draws new points.
  const layer = document.createElement("canvas"), lctx = layer.getContext("2d");
  let layered = 0, layerKey = null, layerData = null;

  const size = () => {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  };

  function axes({ w, h }, xTicks, yTicks, sx, sy, colors) {
    ctx.font = "11px 'Geist Mono', ui-monospace, monospace";
    ctx.fillStyle = colors.muted;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const v of yTicks) {
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(w - PAD.right, y); ctx.stroke();
      ctx.fillText(fmt(v), PAD.left - 8, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const [v, text] of xTicks) {
      const x = Math.round(sx(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, h - PAD.bottom); ctx.stroke();
      ctx.fillText(text, x, h - PAD.bottom + 8);
    }
  }

  /** Cycles laid over one axis; frame k shows the first k cycles, the last frame adds the forecast. */
  function drawCycles(box, colors) {
    const { cycles, forecast, kind, range } = data;
    const sx = (p) => PAD.left + p * (box.w - PAD.left - PAD.right);
    const sy = (v) => box.h - PAD.bottom - ((v - range[0]) / (range[1] - range[0])) * (box.h - PAD.top - PAD.bottom);
    axes(box, PHASE_TICKS[kind], ticks(range[0], range[1]), sx, sy, colors);
    const shown = Math.min(frame, cycles.length);
    const line = (points, k = 1) => {
      ctx.beginPath();
      points.forEach((p, i) => (i && p[0] > points[i - 1][0] ? ctx.lineTo(sx(p[0]), sy(p[k])) : ctx.moveTo(sx(p[0]), sy(p[k]))));
      ctx.stroke();
    };
    ctx.lineJoin = "round";
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1;
    // Older cycles fade out; with many cycles each one is fainter, so the crowd reads as a density.
    const strength = Math.min(0.5, 6 / Math.sqrt(shown || 1));
    for (let c = 0; c < shown - 1; c++) {
      ctx.globalAlpha = 0.02 + strength * ((c + 1) / shown) ** 3;
      line(cycles[c].points);
    }
    ctx.globalAlpha = 1;
    if (shown > 0) {
      ctx.lineWidth = 2;
      line(cycles[shown - 1].points); // the latest cycle in the replay
    }
    if (forecast && frame >= frames - 1) {
      // Bands first, light enough that several forecast cycles can overlap; then every median on top.
      ctx.globalAlpha = Math.max(0.25, 1 / forecast.length);
      for (const f of forecast) {
        ctx.fillStyle = colors.band;
        ctx.beginPath();
        f.points.forEach((p, i) => (i ? ctx.lineTo(sx(p[0]), sy(p[3])) : ctx.moveTo(sx(p[0]), sy(p[3]))));
        [...f.points].reverse().forEach((p) => ctx.lineTo(sx(p[0]), sy(p[2])));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      for (const f of forecast) line(f.points);
    }
  }

  /** The state-space path; frame k shows the first k points, the last frame adds the forecast. */
  function drawSpace(box, colors) {
    const { points, forecast, range, trail } = data;
    const span = range[1] - range[0];
    const sx = (v) => PAD.left + ((v - range[0]) / span) * (box.w - PAD.left - PAD.right);
    const sy = (v) => box.h - PAD.bottom - ((v - range[0]) / span) * (box.h - PAD.top - PAD.bottom);
    const t = ticks(range[0], range[1]);
    axes(box, t.map((v) => [v, fmt(v)]), t, sx, sy, colors);
    // y = x: where the series would sit if nothing changed from one step to the next.
    ctx.strokeStyle = colors.muted;
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(sx(range[0]), sy(range[0])); ctx.lineTo(sx(range[1]), sy(range[1])); ctx.stroke();
    ctx.setLineDash([]);
    const shown = Math.min(frame, points.length);
    // Points fade with their age in the whole series, so one drawn stays as it is: the layer only adds new ones
    // (and starts over when the data, the size or the colors change, or the replay goes back).
    const key = `${canvas.width}x${canvas.height}:${colors.ink}:${range}`;
    if (key !== layerKey || shown < layered || layerData !== points) {
      layer.width = canvas.width;
      layer.height = canvas.height;
      lctx.setTransform(ctx.getTransform());
      layered = 0;
      layerKey = key;
      layerData = points;
    }
    lctx.fillStyle = colors.ink;
    const CHUNK = 256; // one alpha per chunk of points, so the canvas changes state rarely
    for (let a = layered; a < shown; a += CHUNK) {
      lctx.globalAlpha = 0.06 + 0.4 * (a / points.length) ** 2;
      for (let i = a; i < Math.min(shown, a + CHUNK); i++) lctx.fillRect(sx(points[i][0]) - 1, sy(points[i][1]) - 1, 2, 2);
    }
    layered = shown;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
    if (shown > 1) {
      // The recent path, so the motion reads as a path and not a cloud.
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let i = Math.max(0, shown - trail); i < shown; i++) {
        const [x, y] = points[i];
        i > Math.max(0, shown - trail) ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y));
      }
      ctx.stroke();
      const [hx, hy] = points[shown - 1];
      ctx.fillStyle = colors.ink;
      ctx.beginPath(); ctx.arc(sx(hx), sy(hy), 3.5, 0, 2 * Math.PI); ctx.fill();
    }
    if (forecast?.length && frame >= frames - 1) {
      ctx.strokeStyle = colors.band;
      ctx.lineWidth = 3;
      for (const [x, , lo, hi] of forecast) {
        ctx.beginPath(); ctx.moveTo(sx(x), sy(lo)); ctx.lineTo(sx(x), sy(hi)); ctx.stroke();
      }
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const start = points.at(-1);
      if (start) ctx.moveTo(sx(start[0]), sy(start[1]));
      forecast.forEach(([x, y], i) => (i || start ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
      ctx.stroke();
      ctx.fillStyle = colors.accent;
      for (const [x, y] of forecast) { ctx.beginPath(); ctx.arc(sx(x), sy(y), 2.5, 0, 2 * Math.PI); ctx.fill(); }
    }
  }

  function render() {
    if (!data) return;
    const box = size();
    ctx.clearRect(0, 0, box.w, box.h);
    const colors = { ink: css("--ink"), muted: css("--muted"), grid: css("--grid"), accent: css("--accent"), band: css("--band-inner") };
    if (data.mode === "cycles") drawCycles(box, colors); else drawSpace(box, colors);
    scrub.max = frames - 1;
    scrub.value = frame;
    label.textContent = data.frameLabel(frame, frames);
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
    play.textContent = "Replay";
    play.setAttribute("aria-pressed", "false");
  }

  // A replay lasts about six seconds, whatever the number of frames: the position moves with the time elapsed.
  const DURATION = 6000;
  let position = 0;
  function tick(now) {
    // The first frame's timestamp can be a little before the click: never step back.
    position = Math.min(frames - 1, position + (Math.max(0, now - last) / DURATION) * frames);
    last = Math.max(last, now);
    if (Math.floor(position) !== frame) {
      frame = Math.floor(position);
      render();
    }
    if (frame >= frames - 1) return stop();
    raf = requestAnimationFrame(tick);
  }

  play.addEventListener("click", () => {
    if (raf) return stop();
    if (frame >= frames - 1) frame = 0;
    position = frame;
    render();
    play.textContent = "Pause";
    play.setAttribute("aria-pressed", "true");
    last = performance.now();
    raf = requestAnimationFrame(tick);
  });
  scrub.addEventListener("input", () => {
    stop();
    frame = +scrub.value;
    render();
  });
  new ResizeObserver(() => render()).observe(canvas);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());

  return {
    /** Draw new data. Keeps the replay position when the data has the same number of frames. */
    show(next) {
      const nextFrames = Math.max(1, (next.mode === "cycles" ? next.cycles.length : next.points.length) + (next.forecast ? 1 : 0));
      if (nextFrames !== frames || !data) frame = nextFrames - 1;
      frames = nextFrames;
      frame = Math.max(0, Math.min(frame, frames - 1));
      data = next;
      render();
    },
    hide: stop,
  };
}
