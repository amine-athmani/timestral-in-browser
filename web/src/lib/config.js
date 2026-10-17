// This site's repository; the deploy workflow sets it from the repo it runs in.
export const GITHUB_URL = import.meta.env.PUBLIC_GITHUB_URL || "https://github.com/amine-athmani/timestral-in-browser";
// BASE_URL is "/" locally and "/<repo>" on GitHub Pages project sites.
export const BASE = import.meta.env.BASE_URL.replace(/\/?$/, "/");
export const DATA_URL = BASE + "data/";
// ONNX exports on Hugging Face (see scripts/export_onnx.py).
export const HF_ONNX = {
  "5M": "https://huggingface.co/amine40/Timestral-5M-ONNX",
  "28M": "https://huggingface.co/amine40/Timestral-28M-ONNX",
};
// Where the browser downloads the model: local files in development or when PUBLIC_MODEL_BASE is set
// (e.g. "/models/"), Hugging Face otherwise.
const modelBase = import.meta.env.PUBLIC_MODEL_BASE || (import.meta.env.DEV ? `${BASE}models/` : null);
export const modelUrl = (size) => modelBase
  ? `${modelBase}timestral-${size.toLowerCase()}.onnx`
  : `${HF_ONNX[size]}/resolve/main/timestral-${size.toLowerCase()}.onnx`;
// "server" in the Docker image: forecasts come from the official Python package at /api/forecast.
export const SERVER = import.meta.env.PUBLIC_BACKEND === "server";
