import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { previewCommands } from "./preview-runtime.mjs";

const runtimeRoot = mkdtempSync(join(tmpdir(), "shixiaoguan-preview-"));
const configuration = previewCommands(process.env, runtimeRoot);
const children = new Set();
let stopping = false;
let shutdownPromise;

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChild(child) {
  if (childHasExited(child)) return Promise.resolve();
  return new Promise((resolveWait) => child.once("close", resolveWait));
}

function delay(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function launch(specification) {
  const child = spawn(specification.command, specification.args, {
    cwd: process.cwd(),
    env: specification.environment,
    stdio: "inherit",
  });
  children.add(child);
  child.once("error", (error) => {
    process.stderr.write(`[${specification.name}] failed to start: ${error.message}\n`);
    void shutdown(1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      process.stderr.write(
        `[${specification.name}] exited before the preview stopped (${signal ?? code ?? "unknown"}).\n`,
      );
      void shutdown(typeof code === "number" && code !== 0 ? code : 1);
    }
  });
  return child;
}

async function shutdown(exitCode, signal = "SIGTERM") {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownPromise = (async () => {
    const active = [...children].filter((child) => !childHasExited(child));
    active.forEach((child) => child.kill(signal));
    const exitedGracefully = await Promise.race([
      Promise.all(active.map(waitForChild)).then(() => true),
      delay(8_000).then(() => false),
    ]);
    if (!exitedGracefully) {
      const remaining = active.filter((child) => !childHasExited(child));
      remaining.forEach((child) => child.kill("SIGKILL"));
      await Promise.all(remaining.map(waitForChild));
    }
    rmSync(runtimeRoot, { recursive: true, force: true });
    process.exit(exitCode);
  })();
  return shutdownPromise;
}

async function waitUntilReady(url, timeoutMilliseconds = 90_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The API process is still starting or migrating its temporary database.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void shutdown(0, signal);
  });
}
process.once("uncaughtException", (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  void shutdown(1);
});
process.once("unhandledRejection", (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  void shutdown(1);
});

const [apiCommand, webCommand] = configuration.commands;
launch(apiCommand);
await waitUntilReady(configuration.apiHealthUrl);
launch(webCommand);
await new Promise(() => {});
