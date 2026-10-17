import { defineConfig } from "astro/config";

// SITE and BASE_PATH come from the GitHub Pages workflow; both default to a root deploy.
export default defineConfig({
  site: process.env.SITE,
  base: process.env.BASE_PATH || "/",
});
