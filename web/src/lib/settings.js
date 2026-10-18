// The workbench settings in the URL hash, so a link reopens the same view. A link to your own file carries its
// name and the settings, never the data. No DOM, tested in web/test/.

const LISTS = ["t", "c", "k"]; // targets, covariates, covariates known ahead
const NUMBERS = ["h", "back", "level", "flag"]; // steps ahead, forecast start (stops back from the end), service level, anomaly range

/**
 * Settings: { ex | file, group, key, t, c, k, h, model, back, level, agg, tab, view, flag, scenario }. Missing fields are left
 * out; `scenario` is stored as JSON.
 */
export function encodeSettings(s) {
  const p = new URLSearchParams();
  for (const [name, value] of Object.entries(s)) {
    if (value == null || value === "") continue;
    // An empty list is kept as one empty entry, so "no covariate known ahead" differs from "not said".
    if (LISTS.includes(name)) (value.length ? value : [""]).forEach((v) => p.append(name, v));
    else if (name === "scenario") { if (Object.keys(value).length) p.set(name, JSON.stringify(value)); }
    else p.set(name, String(value));
  }
  return p.toString();
}

const MODES = ["file", "set", "change"];
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A scenario from a link, keeping only known modes and numbers: the page writes it into its HTML. */
function cleanScenario(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.fromEntries(Object.entries(raw)
    .filter(([, e]) => e && typeof e === "object" && MODES.includes(e.mode))
    .map(([col, e]) => [col, { mode: e.mode, value: num(e.value), from: num(e.from) ?? 1, to: num(e.to) }]));
}

/** The settings in a URL hash (with or without the "#"), or null when there are none or they are unreadable. */
export function decodeSettings(hash) {
  const p = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  if (![...p.keys()].length) return null;
  const s = {};
  for (const [name, value] of p) {
    if (LISTS.includes(name)) { s[name] ??= []; if (value) s[name].push(value); }
    else if (NUMBERS.includes(name)) { if (Number.isFinite(+value)) s[name] = +value; }
    else if (name === "scenario") { try { s.scenario = cleanScenario(JSON.parse(value)); } catch { /* ignore a broken scenario */ } }
    else s[name] = value;
  }
  return s;
}
