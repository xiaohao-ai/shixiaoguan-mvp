import assert from "node:assert/strict";

import {
  apiProcessEnvironment,
  developmentCommands,
  webProcessEnvironment,
} from "./runtime-env.mjs";

const sourceEnvironment = {
  PATH: "/usr/bin",
  NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:8000",
  DEEPSEEK_API_KEY: "test-key",
  OPENAI_API_KEY: "legacy-test-key",
};

const webEnvironment = webProcessEnvironment(sourceEnvironment);

assert.equal(webEnvironment.DEEPSEEK_API_KEY, undefined);
assert.equal(webEnvironment.OPENAI_API_KEY, undefined);
assert.equal(webEnvironment.PATH, sourceEnvironment.PATH);
assert.equal(
  webEnvironment.NEXT_PUBLIC_API_BASE_URL,
  sourceEnvironment.NEXT_PUBLIC_API_BASE_URL,
);
assert.equal(sourceEnvironment.DEEPSEEK_API_KEY, "test-key");
assert.equal(sourceEnvironment.OPENAI_API_KEY, "legacy-test-key");

const apiEnvironment = apiProcessEnvironment(sourceEnvironment);
assert.equal(apiEnvironment.DEEPSEEK_API_KEY, "test-key");
assert.equal(apiEnvironment.OPENAI_API_KEY, undefined);

const commands = developmentCommands(sourceEnvironment);
const webCommand = commands.find(({ name }) => name === "web");
const apiCommand = commands.find(({ name }) => name === "api");

assert.ok(webCommand);
assert.ok(apiCommand);
assert.equal(webCommand.environment.DEEPSEEK_API_KEY, undefined);
assert.equal(webCommand.environment.OPENAI_API_KEY, undefined);
assert.equal(apiCommand.environment.DEEPSEEK_API_KEY, "test-key");
assert.equal(apiCommand.environment.OPENAI_API_KEY, undefined);
assert.throws(
  () =>
    developmentCommands({
      ...sourceEnvironment,
      NEXT_PUBLIC_DEEPSEEK_API_KEY: "public-test-key",
    }),
  /NEXT_PUBLIC_DEEPSEEK_API_KEY is forbidden/,
);
assert.throws(
  () =>
    developmentCommands({
      ...sourceEnvironment,
      NEXT_PUBLIC_OPENAI_API_KEY: "legacy-public-test-key",
    }),
  /NEXT_PUBLIC_OPENAI_API_KEY is forbidden/,
);

process.stdout.write("Runtime environment isolation passed.\n");
