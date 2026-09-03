import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parsePublicPort, previewCommands } from "./preview-runtime.mjs";

assert.equal(parsePublicPort(undefined), 3000);
assert.equal(parsePublicPort("4321"), 4321);
for (const invalid of ["0", "65536", "3.14", "not-a-port"]) {
  assert.throws(() => parsePublicPort(invalid), /PORT must be an integer/);
}

const providerKeys = new Set([
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "NEXT_PUBLIC_DEEPSEEK_API_KEY",
  "NEXT_PUBLIC_OPENAI_API_KEY",
]);
const source = new Proxy(
  {
    PATH: "/usr/bin",
    PORT: "4321",
    MODEL_MODE: "live",
    SHIXIAOGUAN_AGENT_MODE: "live",
    DATABASE_URL: "sqlite:////persistent/should-not-be-used.sqlite3",
    UPLOAD_DIR: "/persistent/uploads",
    DEEPSEEK_API_KEY: "must-not-be-read",
    OPENAI_API_KEY: "must-not-be-read",
    NEXT_PUBLIC_DEEPSEEK_API_KEY: "must-not-be-read",
    NEXT_PUBLIC_OPENAI_API_KEY: "must-not-be-read",
    PREVIEW_API_PYTHON: "/opt/venv/bin/python",
    PREVIEW_WEB_SERVER_ENTRY: "apps/web/server.js",
  },
  {
    get(target, property, receiver) {
      if (typeof property === "string" && providerKeys.has(property)) {
        throw new Error(`provider credential was read: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  },
);
const runtimeRoot = resolve(join(tmpdir(), "shixiaoguan-preview-runtime-test"));
const configuration = previewCommands(source, runtimeRoot);
const [api, web] = configuration.commands;

assert.equal(configuration.publicPort, 4321);
assert.equal(configuration.apiPort, 8100);
assert.equal(configuration.apiHealthUrl, "http://127.0.0.1:8100/api/v1/health");
assert.equal(api.command, "/opt/venv/bin/python");
assert.deepEqual(api.args.slice(-2), ["--workers", "1"]);
assert.equal(api.args.includes("--reload"), false);
assert.equal(api.environment.PUBLIC_PREVIEW_MODE, "1");
assert.equal(api.environment.MODEL_MODE, "replay");
assert.equal(api.environment.SHIXIAOGUAN_AGENT_MODE, "replay");
assert.equal(
  api.environment.DATABASE_URL,
  `sqlite:///${join(runtimeRoot, "shixiaoguan-preview.sqlite3")}`,
);
assert.equal(api.environment.UPLOAD_DIR, join(runtimeRoot, "uploads"));
assert.equal(web.command, "node");
assert.deepEqual(web.args, ["apps/web/server.js"]);
assert.equal(web.environment.HOSTNAME, "0.0.0.0");
assert.equal(web.environment.PORT, "4321");
assert.equal(web.environment.API_INTERNAL_ORIGIN, "http://127.0.0.1:8100");
assert.equal(web.environment.NEXT_PUBLIC_API_BASE_URL, "/api/v1");

for (const environment of [api.environment, web.environment]) {
  for (const key of providerKeys) assert.equal(Object.hasOwn(environment, key), false);
}

const collision = previewCommands({ PORT: "8100" }, runtimeRoot);
assert.equal(collision.publicPort, 8100);
assert.equal(collision.apiPort, 8101);
assert.equal(collision.commands[1].environment.API_INTERNAL_ORIGIN, "http://127.0.0.1:8101");

process.stdout.write("Public preview runtime isolation passed.\n");
