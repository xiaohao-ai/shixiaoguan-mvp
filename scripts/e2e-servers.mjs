import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const webServerMode = process.env.E2E_WEB_SERVER_MODE ?? "development";

if (!["development", "production"].includes(webServerMode)) {
  throw new Error(
    `Unsupported E2E_WEB_SERVER_MODE=${webServerMode}; expected development or production.`,
  );
}

const runtimeRoot = mkdtempSync(join(tmpdir(), "shixiaoguan-e2e-"));
const databasePath = join(runtimeRoot, "e2e.sqlite3");
const children = new Set();
let shuttingDown = false;
const uvIsOnPath = spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0;

function launch(command, args, extraEnvironment = {}) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!shuttingDown) {
      process.stderr.write(
        `${command} exited before the E2E run completed (${signal ?? code ?? "unknown"}).\n`,
      );
      shutdown(typeof code === "number" && code !== 0 ? code : 1);
    }
  });
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  rmSync(runtimeRoot, { recursive: true, force: true });
  setTimeout(() => process.exit(exitCode), 100).unref();
}

async function waitUntilReady(url, timeoutMilliseconds = 90_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The service is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => shutdown(0));
}
process.once("uncaughtException", (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  shutdown(1);
});
process.once("unhandledRejection", (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  shutdown(1);
});

launch(
  uvIsOnPath ? "uv" : "python3",
  [
    ...(uvIsOnPath ? [] : ["-m", "uv"]),
    "--directory",
    "apps/api",
    "run",
    "uvicorn",
    "shixiaoguan_api.main:app",
    "--host",
    "127.0.0.1",
    "--port",
    "8100",
  ],
  {
    // Use a dedicated throwaway file so E2E exercises the same SQLite
    // transaction behavior as the local app without touching developer data.
    DATABASE_URL: `sqlite:///${databasePath}`,
    MODEL_MODE: "replay",
    DEEPSEEK_API_KEY: "",
    OPENAI_API_KEY: "",
    UPLOAD_DIR: join(runtimeRoot, "uploads"),
    WEB_ORIGIN: "http://127.0.0.1:3100",
  },
);

await waitUntilReady("http://127.0.0.1:8100/api/v1/health");

launch(
  "pnpm",
  [
    "--dir",
    "apps/web",
    webServerMode === "production" ? "start" : "dev",
    "--port",
    "3100",
  ],
  {
    API_INTERNAL_ORIGIN: "http://127.0.0.1:8100",
    NEXT_PUBLIC_API_BASE_URL: "/api/v1",
  },
);

await new Promise(() => {});
