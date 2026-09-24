import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface DevPostgres { url: string; stop(): Promise<void> }

/**
 * Throwaway local PostgreSQL for tests and the terminal demo when no database URL is given.
 * embedded-postgres is a dev dependency: the Docker image never calls this.
 */
export async function startDevPostgres(): Promise<DevPostgres> {
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  restoreLibrarySymlinks();
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), "max90-pg-")), port, user: "postgres", password: "postgres",
    persistent: false, onLog: () => {},
  });
  await server.initialise();
  await server.start();
  return { url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, stop: () => server.stop() };
}

// `npm ci --ignore-scripts` skips the binary package's postinstall that recreates the lib*.so symlinks.
function restoreLibrarySymlinks(): void {
  const entry = createRequire(import.meta.url).resolve(`@embedded-postgres/${process.platform}-${process.arch}`);
  execFileSync(process.execPath, ["scripts/hydrate-symlinks.js"], { cwd: dirname(dirname(entry)), stdio: "ignore" });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")));
    });
  });
}
