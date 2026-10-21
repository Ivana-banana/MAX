import PDFDocument from "pdfkit";
import { join } from "node:path";
import type { Lang } from "../core/types.js";

// The plan as a PDF the student forwards to a curator or the university (#92). Layout only:
// the texts come ready from the dialogue, so the file says what the chat says.
export interface PlanPdf {
  lang: Lang;
  title: string;
  /** Lines under the title: the demo mark, the date of the calculation, the caveat. */
  notes: string[];
  sections: { heading: string; body: string }[];
  footer: string;
}
export const PLAN_FILE = "first-90-days-plan.pdf";
// Noto fonts, SIL OFL 1.1 (src/data/fonts, D-055). Noto Sans has Latin and Cyrillic with the Uzbek
// and Tatar letters; Chinese takes Noto Sans SC. pdfkit embeds only the glyphs the file uses.
const FONTS_DIR = "./src/data/fonts";
const fontFor = (lang: Lang) => join(FONTS_DIR, lang === "zh" ? "NotoSansSC-Regular.otf" : "NotoSans-Regular.ttf");

export function renderPlanPdf(plan: PlanPdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, lang: plan.lang, font: fontFor(plan.lang), info: { Title: plan.title } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(16).text(plan.title).moveDown(0.5);
    doc.fontSize(10);
    for (const note of plan.notes) doc.text(note);
    for (const section of plan.sections) doc.moveDown().fontSize(12).text(section.heading).fontSize(10).text(section.body);
    doc.moveDown().text(plan.footer);
    doc.end();
  });
}
