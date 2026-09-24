import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { PostgresStore } from "./postgres-store.js";

export interface DevPostgres { url: string; stop(): Promise<void> }
export interface ScratchSchema { open(): Promise<{ store: PostgresStore; pool: Pool }>; drop(): Promise<void> }

/**
 * A temporary schema of its own in the database at url, for tests and the demo:
 * their synthetic profiles never mix with the bot's tables. open() may be called again to reopen the same data.
 */
export async function scratchSchema(url: string): Promise<ScratchSchema> {
  const name = `scratch_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${name}"`);
  return {
    open: async () => {
      // The store owns the pool (store.close() ends it); the pool is returned for direct SQL checks.
      const pool = new Pool({ connectionString: url, options: `-c search_path=${name}` });
      return { store: await PostgresStore.open(pool), pool };
    },
    drop: async () => {
      try { await admin.query(`DROP SCHEMA "${name}" CASCADE`); } finally { await admin.end(); }
    },
  };
}

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
    // initdb follows the host locale, which on a Russian Windows means WIN1251 and refuses the
    // emoji in the bot's buttons. The Docker image is UTF8, so the throwaway cluster must be too.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    persistent: false, onLog: () => {},
  });
  await server.initialise();
  await server.start();
  return { url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, stop: () => server.stop() };
}

// `npm ci --ignore-scripts` skips the binary package's postinstall that recreates the lib*.so symlinks.
function restoreLibrarySymlinks(): void {
  // embedded-postgres names its binary packages after the npm platform, where win32 is "windows".
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const entry = createRequire(import.meta.url).resolve(`@embedded-postgres/${platform}-${process.arch}`);
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
