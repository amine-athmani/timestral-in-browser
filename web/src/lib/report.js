// A printable report of the current forecast. It goes through the browser's print dialog, where "Save as PDF"
// makes a file. Charts are drawn in the light theme for paper, captured as images, then redrawn as they were.
import { esc } from "./views.js";

const frame = () => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
  setTimeout(resolve, 200); // background tabs may not run animation frames
});

/**
 * Print a report into `sheet`. redraw() redraws the charts; canvases() lists them once drawn.
 * report: { title, subtitle, facts: [text], sections: [{ heading, html }], footer }.
 */
export async function printReport(sheet, { redraw, canvases }, report) {
  const root = document.documentElement;
  root.dataset.print = ""; // global.css keeps the light colors while this is set
  redraw();
  await frame();
  const images = canvases().map((c) => c.toDataURL("image/png"));

  sheet.innerHTML = `
    <header>
      <p class="meta">Timestral forecast report · ${esc(new Date().toISOString().slice(0, 10))}</p>
      <h1>${esc(report.title)}</h1>
      ${report.subtitle ? `<p>${esc(report.subtitle)}</p>` : ""}
      <p class="meta">${report.facts.map(esc).join(" · ")}</p>
    </header>
    ${images.map((src) => `<img src="${src}" alt="">`).join("")}
    ${report.sections.filter((s) => s.html).map((s) => `<section><h2>${esc(s.heading)}</h2>${s.html}</section>`).join("")}
    <footer>${report.footer}</footer>`;

  const restore = () => {
    delete root.dataset.print;
    sheet.innerHTML = "";
    redraw();
  };
  addEventListener("afterprint", restore, { once: true });
  print();
}
