import { join, resolve } from "node:path";

const DEFAULT_PUBLIC_PORT = 3000;
const DEFAULT_INTERNAL_API_PORT = 8100;

function isProviderEnvironmentKey(key) {
  const normalized = key.toUpperCase();
  return normalized.includes("DEEPSEEK") || normalized.includes("OPENAI");
}

function environmentWithoutProviderValues(sourceEnvironment) {
  const environment = {};
  for (const key of Object.keys(sourceEnvironment)) {
    if (isProviderEnvironmentKey(key)) continue;
    environment[key] = sourceEnvironment[key];
  }
  return environment;
}

export function parsePublicPort(rawPort) {
  const value = rawPort === undefined || rawPort === "" ? DEFAULT_PUBLIC_PORT : Number(rawPort);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535; received ${rawPort}`);
  }
  return value;
}

export function previewCommands(sourceEnvironment, runtimeDirectory) {
  const publicPort = parsePublicPort(sourceEnvironment.PORT);
  const apiPort = publicPort === DEFAULT_INTERNAL_API_PORT
    ? DEFAULT_INTERNAL_API_PORT + 1
    : DEFAULT_INTERNAL_API_PORT;
  const runtimeRoot = resolve(runtimeDirectory);
  const apiPython = (sourceEnvironment.PREVIEW_API_PYTHON || "/opt/venv/bin/python").trim();
  const standaloneEntry = (sourceEnvironment.PREVIEW_WEB_SERVER_ENTRY || "").trim();
  const nodeBinary = (sourceEnvironment.PREVIEW_NODE_BINARY || "node").trim();
  const baseEnvironment = environmentWithoutProviderValues(sourceEnvironment);
  const apiEnvironment = {
    ...baseEnvironment,
    PUBLIC_PREVIEW_MODE: "1",
    PUBLIC_PREVIEW_RUNTIME_DIR: runtimeRoot,
    MODEL_MODE: "replay",
    SHIXIAOGUAN_AGENT_MODE: "replay",
    DATABASE_URL: `sqlite:///${join(runtimeRoot, "shixiaoguan-preview.sqlite3")}`,
    UPLOAD_DIR: join(runtimeRoot, "uploads"),
  };
  delete apiEnvironment.SHIXIAOGUAN_DATABASE_URL;
  delete apiEnvironment.SHIXIAOGUAN_UPLOAD_DIR;

  const webEnvironment = {
    ...baseEnvironment,
    HOSTNAME: "0.0.0.0",
    PORT: String(publicPort),
    API_INTERNAL_ORIGIN: `http://127.0.0.1:${apiPort}`,
    NEXT_PUBLIC_API_BASE_URL: "/api/v1",
    NEXT_TELEMETRY_DISABLED: "1",
    PUBLIC_PREVIEW_MODE: "1",
  };
  for (const key of [
    "DATABASE_URL",
    "SHIXIAOGUAN_DATABASE_URL",
    "UPLOAD_DIR",
    "SHIXIAOGUAN_UPLOAD_DIR",
    "MODEL_MODE",
    "SHIXIAOGUAN_AGENT_MODE",
    "PUBLIC_PREVIEW_RUNTIME_DIR",
  ]) {
    delete webEnvironment[key];
  }

  return {
    publicPort,
    apiPort,
    apiHealthUrl: `http://127.0.0.1:${apiPort}/api/v1/health`,
    commands: [
      {
        name: "api",
        command: apiPython,
        args: [
          "-m",
          "uvicorn",
          "shixiaoguan_api.main:app",
          "--host",
          "127.0.0.1",
          "--port",
          String(apiPort),
          "--workers",
          "1",
        ],
        environment: apiEnvironment,
      },
      standaloneEntry
        ? {
            name: "web",
            command: nodeBinary,
            args: [standaloneEntry],
            environment: webEnvironment,
          }
        : {
            name: "web",
            command: "pnpm",
            args: [
              "--dir",
              "apps/web",
              "exec",
              "next",
              "start",
              "--hostname",
              "0.0.0.0",
              "--port",
              String(publicPort),
            ],
            environment: webEnvironment,
          },
    ],
  };
}
