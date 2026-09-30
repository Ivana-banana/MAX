import { readFileSync } from "node:fs";
import { checkPage, pageText, parseSources } from "./sources.js";

// npm run sources:check — are the quotes our data stands on still on the official pages?
// Exit code 1: a quote disappeared, the data must be checked again. A page that did not answer is
// only a warning: sites of Russian universities are not always reachable from abroad (CI runners).
const sources = parseSources(JSON.parse(readFileSync(process.env.SOURCES_PATH ?? "./src/data/sources.json", "utf8")));
let changed = 0, unreachable = 0;
for (const source of sources) {
  try {
    const response = await fetch(source.url, {
      headers: { "user-agent": "first-90-days source check (+https://github.com/M1hairu/MAX_GOATed_messenger)" },
      signal: AbortSignal.timeout(40_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const missing = checkPage(source, pageText(new Uint8Array(await response.arrayBuffer()), response.headers.get("content-type") ?? ""));
    if (missing.length) {
      changed++;
      console.log(`✗ ${source.url}\n  ${source.about}\n${missing.map(q => `  нет цитаты: «${q}»`).join("\n")}`);
    } else console.log(`✓ ${source.url}`);
  } catch (error) {
    unreachable++;
    console.warn(`⚠ ${source.url}: не открылась (${error instanceof Error ? error.message : String(error)})`);
  }
}
console.log(`\nИсточников: ${sources.length}; изменились: ${changed}; не открылись: ${unreachable}.`);
if (changed) console.log("Сверьте данные с изменившимися страницами: src/data/rules, src/data/universities, затем цитаты в src/data/sources.json.");
process.exit(changed ? 1 : 0);
