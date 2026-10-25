import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// #133: the Docker image keeps only `dependencies` (npm prune --omit=dev). A devDependency reached from the
// server's entry point passes every local check and crashes the bot on start in production.

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { devDependencies: Record<string, string> };

/** Bare packages imported at run time by `entry` and every local module it reaches (type-only imports skipped). */
function runtimePackages(entry: string): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)) {
      const spec = m[3] ?? m[4];
      if (m[2] || spec === undefined) continue;
      if (spec.startsWith(".")) visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      else if (!spec.startsWith("node:")) found.set(spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/"), file);
    }
  };
  visit(entry);
  return found;
}

describe("runtime dependencies (#133)", () => {
  it("the bot's entry point reaches no devDependency", () => {
    const dev = [...runtimePackages(resolve(root, "src/main.ts"))]
      .filter(([name]) => name in pkg.devDependencies)
      .map(([name, file]) => `${name} ← ${file.slice(root.length + 1)}`);
    expect(dev).toEqual([]);
  });
});
