import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Fan chart for one variate.
 * x: shared x values (unix seconds, or indices when isTime is false), history ends where the forecast starts.
 * history / actual: arrays aligned to x (null where absent). q: [q10, q25, q50, q75, q90] aligned to x.
 * future: the median past the end of the data, drawn dotted. split: forecast start. dataEnd: last data point.
 * view: { min, max } x range to show. onView(min, max) fires when the user zooms or pans this chart;
 * onReset() on a double-click.
 * stops: x values the forecast start can snap to, stop: the current one. Dragging the start line calls
 * onStop(i, false) as it passes stops and onStop(i, true) on release; stopLabel(i) names a stop.
 * fill: size the plot to the height of `el` instead of a share of its width.
 * lines: extra lines over the forecast, [{ label, y (aligned to x), color (a CSS variable), dash }].
 */
export function fanChart(el, { x, history, actual, q, future, split, dataEnd, view, onView, onReset,
                               stops = [], stop = -1, onStop, stopLabel = String,
                               isTime = true, label = "", fill = false, lines = [] }) {
  const ink = css("--ink"), muted = css("--muted"), accent = css("--accent");
  const band = css("--band"), bandInner = css("--band-inner"), grid = css("--grid"), past = css("--past");
  const h = (w) => (fill && el.clientHeight) || Math.max(220, Math.min(360, w * 0.45));
  const axis = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false },
                 font: "11px 'Geist Mono', ui-monospace, monospace" };
  const fmt = (v) => (v == null ? "–" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : +v.toPrecision(4));
  let set = null; // the last range the app gave this chart; uPlot reports it later, and it is not echoed back
  const opts = {
    width: el.clientWidth || 600,
    height: h(el.clientWidth || 600),
    padding: [12, 8, 0, 0],
    legend: { show: false },
    cursor: {
      y: false, points: { size: 6 },
      drag: { x: true, y: false, setScale: true },
      // A double-click goes back to the default view instead of uPlot's whole-data reset.
      bind: { dblclick: () => () => (onReset?.(), null) },
    },
    scales: { x: { time: isTime } },
    ...(isTime && { tzDate: (ts) => uPlot.tzDate(new Date(ts * 1e3), "Etc/UTC") }),
    axes: [{ ...axis, size: 30 }, { ...axis, size: 56, values: (u, vals) => vals.map(fmt) }],
    series: [
      {},
      { label: "History", stroke: ink, width: 1.25 },
      { label: "Actual", stroke: muted, width: 1.25 },
      { label: "q10", stroke: "transparent" },
      { label: "q25", stroke: "transparent" },
      { label: "Median", stroke: accent, width: 2 },
      { label: "q75", stroke: "transparent" },
      { label: "q90", stroke: "transparent" },
      { label: "Median ahead", stroke: accent, width: 2, dash: [2, 4] },
      ...lines.map((l) => ({ label: l.label, stroke: css(l.color), width: 1.5, dash: l.dash })),
    ],
    bands: [
      { series: [7, 3], fill: band },
      { series: [6, 4], fill: bandInner },
    ],
    hooks: {
      setCursor: [(u) => tooltip(u, el, isTime, fmt, lines)],
      setScale: [(u, key) => {
        if (key !== "x" || !set) return;
        const { min, max } = u.scales.x, eps = (max - min) * 1e-9;
        if (Math.abs(min - set.min) > eps || Math.abs(max - set.max) > eps) onView?.(min, max);
      }],
      // Gray out the past, up to where the forecast starts; the forecast and the future stay clear.
      drawClear: [(u) => {
        if (split == null) return;
        const { left, top, width, height: hh } = u.bbox;
        const end = Math.min(left + width, Math.max(left, Math.round(u.valToPos(split, "x", true))));
        u.ctx.fillStyle = past;
        u.ctx.fillRect(left, top, end - left, hh);
      }],
      // Ticks along the bottom for the stops the forecast start can snap to.
      draw: [(u) => {
        const { left, top, width, height: hh } = u.bbox, dpr = devicePixelRatio || 1;
        stops.forEach((v, i) => {
          const at = Math.round(u.valToPos(v, "x", true));
          if (at < left || at > left + width) return;
          u.ctx.fillStyle = i === stop ? accent : muted;
          u.ctx.fillRect(at - dpr, top + hh - 6 * dpr, 2 * dpr, 6 * dpr);
        });
        placeHandle();
      }, (u) => {
        // Mark the end of the data with a dashed line on top of the series.
        if (dataEnd == null) return;
        const { left, top, width, height: hh } = u.bbox;
        const at = Math.round(u.valToPos(dataEnd, "x", true)) + 0.5;
        if (at < left || at > left + width) return;
        const ctx = u.ctx, dpr = devicePixelRatio || 1;
        ctx.save();
        ctx.strokeStyle = ink;
        ctx.lineWidth = dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.beginPath();
        ctx.moveTo(at, top);
        ctx.lineTo(at, top + hh);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = muted;
        ctx.font = `${10 * dpr}px 'Geist Mono', ui-monospace, monospace`;
        ctx.textBaseline = "bottom"; // at the bottom, clear of the start line's grip
        const text = "end of data", tw = ctx.measureText(text).width;
        const room = left + width - at > tw + 8 * dpr;
        ctx.textAlign = room ? "left" : "right";
        ctx.fillText(text, at + (room ? 5 : -5) * dpr, top + hh - 10 * dpr);
        ctx.restore();
      }],
    },
  };
  el.innerHTML = "";
  el.setAttribute("aria-label", label);

  // The forecast start: a line on the chart that snaps to the stops.
  const handle = document.createElement("div");
  handle.className = "start-handle";
  handle.tabIndex = 0;
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", "Forecast start");
  handle.innerHTML = '<span class="start-grip" aria-hidden="true"></span>';
  let u = null;
  let wantFocus = false; // focus the handle once the chart has its size
  const placeHandle = () => {
    if (!u || split == null || !stops.length) return void (handle.hidden = true);
    const at = u.valToPos(split, "x");
    handle.hidden = at < 0 || at > u.over.clientWidth;
    handle.style.transform = `translateX(${at}px)`;
    handle.setAttribute("aria-valuemin", 0);
    handle.setAttribute("aria-valuemax", stops.length - 1);
    handle.setAttribute("aria-valuenow", stop);
    handle.setAttribute("aria-valuetext", stopLabel(stop));
    if (wantFocus && !handle.hidden) (handle.focus({ preventScroll: true }), (wantFocus = false));
  };
  const setStop = (i) => {
    if (i === stop || i < 0 || i >= stops.length) return;
    stop = i;
    split = stops[i];
    u.redraw(false, false);
  };
  const nearest = (px) => {
    let best = stop, gap = Infinity;
    stops.forEach((v, i) => {
      const d = Math.abs(u.valToPos(v, "x") - px);
      if (d < gap) (gap = d), (best = i);
    });
    return best;
  };
  // uPlot starts a zoom on mousedown over the plot; the handle keeps its own drags.
  handle.addEventListener("mousedown", (e) => e.stopPropagation());
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    const move = (ev) => {
      const i = nearest(ev.clientX - u.over.getBoundingClientRect().left);
      if (i !== stop) (setStop(i), onStop?.(i, false));
    };
    const up = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      onStop?.(stop, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("keydown", (e) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key]
      ?? (e.key === "Home" ? -stop : e.key === "End" ? stops.length - 1 - stop : 0);
    if (!step) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(stops.length - 1, stop + step));
    if (i !== stop) (setStop(i), onStop?.(i, true));
  });

  u = new uPlot(opts, [x, history, actual, ...q, future, ...lines.map((l) => l.y)], el);
  u.over.appendChild(handle);
  placeHandle();
  const setView = (min, max) => {
    set = { min, max };
    u.setScale("x", { min, max });
  };
  if (view) setView(view.min, view.max);
  else set = { min: u.scales.x.min, max: u.scales.x.max };

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms around the pointer; Shift + wheel or a sideways swipe pans.
  const onWheel = (e) => {
    const zoom = e.ctrlKey || e.metaKey;
    const dx = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
    if (!zoom && Math.abs(dx) <= Math.abs(e.deltaY) && !e.shiftKey) return; // let the page scroll
    e.preventDefault();
    const { min, max } = u.scales.x;
    const span = max - min;
    if (zoom) {
      const at = u.posToVal(e.clientX - u.over.getBoundingClientRect().left, "x");
      const k = Math.exp(Math.max(-1, Math.min(1, e.deltaY / 200)));
      onView?.(at - (at - min) * k, at + (max - at) * k);
    } else {
      const shift = (dx / u.over.clientWidth) * span;
      onView?.(min + shift, max + shift);
    }
  };
  u.over.addEventListener("wheel", onWheel, { passive: false });

  const ro = new ResizeObserver(() => {
    const w = el.clientWidth;
    if (w && (w !== u.width || h(w) !== u.height)) u.setSize({ width: w, height: h(w) });
  });
  ro.observe(el);
  return {
    setView,
    setStop,
    /** Replace the extra lines' values (same count and colors) without rebuilding the chart. */
    setLines: (next) => {
      lines = next;
      // Reset the scales so the y axis fits a higher plan, then put back the x range in view.
      u.setData([x, history, actual, ...q, future, ...lines.map((l) => l.y)]);
      if (set) u.setScale("x", set);
    },
    focusStart: () => ((wantFocus = true), placeHandle()),
    getView: () => ({ min: u.scales.x.min, max: u.scales.x.max }),
    destroy: () => (ro.disconnect(), u.over.removeEventListener("wheel", onWheel), u.destroy()),
  };
}

function tooltip(u, el, isTime, fmt, lines) {
  let tip = el.querySelector(".tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "tip";
    el.appendChild(tip);
  }
  const i = u.cursor.idx;
  if (i == null) return (tip.hidden = true);
  const [x, h, a, q10, , m, , q90, mf, ...extra] = u.data.map((s) => s[i]);
  const med = m ?? mf;
  const when = isTime ? new Date(x * 1e3).toISOString().slice(0, 16).replace("T", " ").replace(" 00:00", "") : `t = ${x}`;
  const rows = [];
  if (h != null) rows.push(["History", fmt(h)]);
  if (a != null) rows.push(["Actual", fmt(a)]);
  if (med != null) rows.push(["Median", fmt(med)], ["80% range", `${fmt(q10)} to ${fmt(q90)}`]);
  // Extra lines only once the forecast starts, not on the history point they join.
  if (med != null && h == null) lines.forEach((l, k) => extra[k] != null && rows.push([l.label, fmt(extra[k])]));
  tip.innerHTML = `<b>${when}</b>` + rows.map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join("");
  tip.hidden = false;
  const left = u.valToPos(x, "x") + u.over.offsetLeft;
  tip.style.transform = `translateX(${left > el.clientWidth / 2 ? left - tip.offsetWidth - 12 : left + 12}px)`;
}

/**
 * Align history and a forecast on one x axis. The forecast starts at index `start` of the history and runs past
 * `dataEnd`, the end of the data; history points from `start` on are what really happened.
 * lines: extra forecast lines, [{ label, values (one per forecast step), color, dash, join }], aligned like the
 * median; `join: false` leaves out the history point the line would otherwise start from.
 */
export function align({ histX, histY, start, dataEnd, fcX, quantiles, lines = [] }) {
  const x = histX.concat(fcX.slice(histX.length - start));
  const n = x.length;
  const at = (arr, from) => Array.from({ length: n }, (_, i) => (i >= from && i - from < arr.length ? arr[i - from] : null));
  const last = dataEnd - 1;
  const history = at(histY.map((v, i) => (i < start ? v : null)), 0);
  // The actual line starts one point early so it joins the history line.
  const actual = at(histY.map((v, i) => (i >= start - 1 && i <= last ? v : null)), 0);
  // Forecast lines join the history at its last point.
  const joined = (values) => {
    const out = at(values, start);
    if (start > 0) out[start - 1] = histY[start - 1];
    return out;
  };
  const q = quantiles.map(joined);
  // Split the median at the end of the data: solid where it can be checked, dotted beyond.
  const future = q[2].map((v, i) => (i >= last ? v : null));
  q[2] = q[2].map((v, i) => (i <= last ? v : null));
  return {
    x, history, actual, q, future, split: x[Math.max(0, start - 1)], dataEnd: x[Math.max(0, last)],
    lines: lines.map(({ values, join = true, ...l }) => ({ ...l, y: join ? joined(values) : at(values, start) })),
  };
}
