// Compares the JS forecaster (web/src/lib/timestral.js) with the Python package.
// Run from the repo root: node tests/parity/parity.test.mjs  (needs web/node_modules and onnx/*.onnx)
// SITE=1 checks the fp16-stored files the website serves, with a looser tolerance.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { forecast } from "../../web/src/lib/timestral.js";

const ort = createRequire(new URL("../../web/package.json", import.meta.url))("onnxruntime-node");
const fixtures = JSON.parse(readFileSync(new URL("fixtures.json", import.meta.url)));
const site = !!process.env.SITE;
const dir = site ? "../../web/public/models/" : "../../onnx/";
const tolerance = site ? 1e-3 : 1e-5;
const sessions = {};
let failed = 0;

for (const fx of fixtures) {
  sessions[fx.model] ??= await ort.InferenceSession.create(new URL(`${dir}timestral-${fx.model.toLowerCase()}.onnx`, import.meta.url).pathname);
  const t0 = performance.now();
  const { quantiles } = await forecast(ort, sessions[fx.model], {
    target: fx.target, horizon: fx.horizon, pastCovariates: fx.pastCovariates, knownCovariates: fx.knownCovariates,
    maxContext: 32768, // the Python default; the site caps it lower for speed
  });
  const ms = performance.now() - t0;
  // Error relative to the spread of the expected forecast, so series scale does not matter.
  let maxErr = 0, spread = 0;
  fx.expected.forEach((series, v) => series.forEach((qs, h) => qs.forEach((e, k) => {
    maxErr = Math.max(maxErr, Math.abs(quantiles[v][h][k] - e));
    spread = Math.max(spread, Math.abs(e));
  })));
  const rel = maxErr / spread;
  const ok = rel < tolerance;
  failed += !ok;
  console.log(`${ok ? "ok  " : "FAIL"} ${fx.model.padEnd(4)} ${fx.name.padEnd(18)} max rel err ${rel.toExponential(2)}  ${ms.toFixed(0)} ms`);
}
process.exit(failed ? 1 : 0);
