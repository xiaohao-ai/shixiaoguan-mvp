const WEB_DENIED_CREDENTIAL_KEYS = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY"];
const FORBIDDEN_PUBLIC_CREDENTIAL_KEYS = [
  "NEXT_PUBLIC_DEEPSEEK_API_KEY",
  "NEXT_PUBLIC_OPENAI_API_KEY",
];

function assertNoPublicModelCredentials(sourceEnvironment) {
  for (const key of FORBIDDEN_PUBLIC_CREDENTIAL_KEYS) {
    if (sourceEnvironment[key]) {
      throw new Error(
        `${key} is forbidden. Model credentials must remain API-only.`,
      );
    }
  }
}

export function webProcessEnvironment(sourceEnvironment) {
  const environment = { ...sourceEnvironment };
  for (const key of WEB_DENIED_CREDENTIAL_KEYS) {
    delete environment[key];
  }
  return environment;
}

export function apiProcessEnvironment(sourceEnvironment) {
  const environment = { ...sourceEnvironment };
  delete environment.OPENAI_API_KEY;
  return environment;
}

export function developmentCommands(sourceEnvironment) {
  assertNoPublicModelCredentials(sourceEnvironment);
  return [
    {
      name: "web",
      command: "pnpm",
      args: ["--dir", "apps/web", "dev"],
      environment: webProcessEnvironment(sourceEnvironment),
    },
    {
      name: "api",
      command: "python3",
      args: [
        "-m",
        "uv",
        "--directory",
        "apps/api",
        "run",
        "uvicorn",
        "shixiaoguan_api.main:app",
        "--reload",
        "--host",
        "127.0.0.1",
        "--port",
        "8000",
      ],
      environment: apiProcessEnvironment(sourceEnvironment),
    },
  ];
}
