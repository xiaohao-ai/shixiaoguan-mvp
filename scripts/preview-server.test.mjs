import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptsDirectory, "..");
const fixtureRoot = mkdtempSync(join(tmpdir(), "shixiaoguan-preview-lifecycle-test-"));
const apiFixture = join(fixtureRoot, "fake-api.mjs");
const webFixture = join(fixtureRoot, "fake-web.mjs");

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function waitForExit(child, timeoutMilliseconds) {
  return Promise.race([
    new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("preview launcher did not exit in time")), timeoutMilliseconds);
    }),
  ]);
}

async function waitUntilReady(url, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return response;
    } catch {
      // The fake child processes are still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`timed out waiting for ${url}`);
}

writeFileSync(
  apiFixture,
  `#!/usr/bin/env node
import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = createServer((_, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ status: "ok", public_preview_mode: true }));
});
server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => server.close(() => {
  process.stdout.write("api received SIGTERM\\n");
  process.exit(0);
}));
`,
  { mode: 0o755 },
);
chmodSync(apiFixture, 0o755);
writeFileSync(
  webFixture,
  `import { createServer } from "node:http";
const server = createServer((_, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ status: "web-ok" }));
});
server.listen(Number(process.env.PORT), "127.0.0.1");
process.once("SIGTERM", () => server.close(() => {
  process.stdout.write("web received SIGTERM\\n");
  process.exit(0);
}));
`,
);

let launcher;
try {
  const publicPort = await reservePort();
  launcher = spawn(process.execPath, [join(scriptsDirectory, "preview-server.mjs")], {
    cwd: workspaceRoot,
    env: {
      PATH: process.env.PATH,
      TMPDIR: fixtureRoot,
      PORT: String(publicPort),
      PREVIEW_API_PYTHON: apiFixture,
      PREVIEW_NODE_BINARY: process.execPath,
      PREVIEW_WEB_SERVER_ENTRY: webFixture,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  launcher.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  launcher.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const ready = await waitUntilReady(`http://127.0.0.1:${publicPort}/api/v1/health`);
  assert.deepEqual(await ready.json(), { status: "web-ok" });

  launcher.kill("SIGTERM");
  const result = await waitForExit(launcher, 12_000);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.match(output, /api received SIGTERM/);
  assert.match(output, /web received SIGTERM/);
  assert.deepEqual(
    readdirSync(fixtureRoot).sort(),
    ["fake-api.mjs", "fake-web.mjs"],
    "the per-run temporary storage directory should be removed on SIGTERM",
  );
  process.stdout.write("Public preview lifecycle and SIGTERM handling passed.\n");
} finally {
  if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
    launcher.kill("SIGKILL");
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}
