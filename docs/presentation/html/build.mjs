// Builds each deck variant into one self-contained HTML file: stylesheets, the script, fonts and
// screens are inlined, so the file opens offline by double click.
// node docs/presentation/html/build.mjs [variant…]   (no arguments — every src/*.html and skin)
// A skin is src/skins/<variant>-<skin>.css: the same slides with another look, built as `<variant>+<skin>`
// into <variant>-<skin>.html. Its stylesheet goes last, so it overrides the variant's own <style>.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

const root = dirname(new URL(import.meta.url).pathname);
const src = join(root, "src");
const types = { ".woff2": "font/woff2", ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml" };

async function dataUri(path) {
  const type = types[extname(path)];
  if (!type) throw new Error(`no media type for ${path}`);
  return `data:${type};base64,${(await readFile(path)).toString("base64")}`;
}

/** Replaces every match of `pattern` with the async result of `replace(match, ...groups)`. */
async function replaceAsync(text, pattern, replace) {
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    parts.push(text.slice(last, match.index), await replace(...match));
    last = match.index + match[0].length;
  }
  return parts.join("") + text.slice(last);
}

/** url(...) in CSS → data URI, resolved against the directory of the file that holds the CSS. */
const inlineUrls = (css, dir) =>
  replaceAsync(css, /url\((["']?)([^)"':]+)\1\)/g, async (_, __, path) => `url(${await dataUri(resolve(dir, path))})`);

async function build(target) {
  const [variant, skin] = target.split("+");
  const name = skin ? `${variant}-${skin}` : variant;
  let html = await readFile(join(src, `${variant}.html`), "utf8");
  if (skin) html = html.replace("</head>", `<link rel="stylesheet" href="skins/${name}.css">\n</head>`);
  html = await replaceAsync(html, /<link rel="stylesheet" href="([^"]+)">/g, async (_, path) => {
    const file = resolve(src, path);
    return `<style>\n${await inlineUrls(await readFile(file, "utf8"), dirname(file))}</style>`;
  });
  html = await replaceAsync(html, /<script src="([^"]+)"><\/script>/g,
    async (_, path) => `<script>\n${await readFile(resolve(src, path), "utf8")}</script>`);
  html = await replaceAsync(html, /(<img[^>]* src=")([^"]+)"/g, async (_, head, path) => `${head}${await dataUri(resolve(src, path))}"`);
  html = await inlineUrls(html, src);
  const out = join(root, `${name}.html`);
  await writeFile(out, html);
  console.log(`${name}.html — ${(html.length / 1024 / 1024).toFixed(2)} МБ`);
}

const names = process.argv.slice(2);
const all = [
  ...(await readdir(src)).filter(f => f.endsWith(".html")).map(f => f.slice(0, -5)),
  ...(await readdir(join(src, "skins")).catch(() => [])).filter(f => f.endsWith(".css")).map(f => f.slice(0, -4).replace("-", "+")),
];
for (const name of names.length ? names : all) await build(name);
