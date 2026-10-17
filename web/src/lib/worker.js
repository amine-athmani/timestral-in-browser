// Runs Timestral off the main thread. Messages in: { init: { urls } } once, then { id, gen, model, request };
// out: progress, result, skipped or error.
import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import { forecast } from "./timestral.js";

// Vite serves the runtime as hashed assets. The loader (.mjs) is needed too: with cross-origin isolation
// onnxruntime runs several threads, and each thread worker loads it by URL.
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };

const CACHE = "timestral-models-v1";
const sessions = {};
let urls = {};

async function download(url, onProgress) {
  // Cache API keeps the model across visits; it can be missing (private windows, file://).
  const cache = await self.caches?.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the model (${res.status}).`);
  const total = +res.headers.get("content-length") || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  await cache?.put(url, new Response(bytes)).catch(() => {});
  return bytes;
}

function session(model, onProgress) {
  sessions[model] ??= download(urls[model], onProgress)
    .then((bytes) => ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }))
    .catch((err) => { delete sessions[model]; throw err; });
  return sessions[model];
}

// Runs one at a time; a newer request makes the queued older ones obsolete.
let queue = Promise.resolve();
let latest = 0;

self.onmessage = ({ data }) => {
  if (data.init) return void (urls = data.init.urls);
  latest = Math.max(latest, data.gen ?? 0);
  queue = queue.then(() => handle(data));
};

async function handle({ id, gen = 0, model, request }) {
  if (gen < latest) return self.postMessage({ id, type: "skipped" });
  try {
    const s = await session(model, (loaded, total) => self.postMessage({ id, type: "progress", loaded, total }));
    const start = performance.now();
    const result = await forecast(ort, s, request);
    self.postMessage({ id, type: "result", ...result, seconds: (performance.now() - start) / 1000 });
  } catch (err) {
    self.postMessage({ id, type: "error", message: err.message || String(err) });
  }
}
