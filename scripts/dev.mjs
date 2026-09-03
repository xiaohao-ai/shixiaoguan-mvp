import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

import { developmentCommands } from "./runtime-env.mjs";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const commands = developmentCommands(process.env);

const children = commands.map(({ name, command, args, environment }) => {
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    env: environment,
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on("error", (error) => {
    process.stderr.write(`[${name}] failed to start: ${error.message}\n`);
  });
  return child;
});

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

const exits = children.map(
  (child, index) =>
    new Promise((resolve) => {
      child.on("exit", (code, signal) =>
        resolve({ index, code: code ?? (signal ? 0 : 1) }),
      );
    }),
);

const firstExit = await Promise.race(exits);
stop();
await Promise.all(exits);
process.exit(firstExit.code);
