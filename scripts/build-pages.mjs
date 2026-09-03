import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routeHandlerPath = join(
  repositoryRoot,
  "apps/web/app/api/v1/[...path]/route.ts",
);
const disabledRouteHandlerPath = `${routeHandlerPath}.pages-disabled`;
const outputDirectory = join(repositoryRoot, "apps/web/out");
const projectId = "github-pages-demo";
const basePath = "/shixiaoguan-mvp";
const expectedHtmlFiles = [
  "index.html",
  "404.html",
  `projects/${projectId}/index.html`,
  ...[
    "brief",
    "experiment",
    "simulation",
    "evidence",
    "decision",
    "handoff",
    "audit",
  ].map((step) => `projects/${projectId}/${step}/index.html`),
];

if (!existsSync(routeHandlerPath) && existsSync(disabledRouteHandlerPath)) {
  renameSync(disabledRouteHandlerPath, routeHandlerPath);
  console.warn("Recovered the API route handler left by an interrupted Pages build.");
}
if (!existsSync(routeHandlerPath)) {
  throw new Error(`Pages build cannot find the API route handler: ${routeHandlerPath}`);
}
if (existsSync(disabledRouteHandlerPath)) {
  throw new Error(
    `Pages build found both route.ts and a stale disabled copy. Inspect and remove ${disabledRouteHandlerPath} before retrying.`,
  );
}

let routeHandlerDisabled = false;
let child;
let interruptedBy;

function restoreRouteHandler() {
  if (!routeHandlerDisabled) return;
  if (existsSync(routeHandlerPath)) {
    throw new Error(
      `Pages build refused to overwrite a newly created route handler: ${routeHandlerPath}`,
    );
  }
  renameSync(disabledRouteHandlerPath, routeHandlerPath);
  routeHandlerDisabled = false;
}

function verifyExport() {
  for (const relativePath of expectedHtmlFiles) {
    const absolutePath = join(outputDirectory, relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`Pages export is missing ${relativePath}`);
    }
  }

  if (existsSync(join(outputDirectory, "api"))) {
    throw new Error("Pages export unexpectedly contains the server-only /api route");
  }

  const homeHtml = readFileSync(join(outputDirectory, "index.html"), "utf8");
  const briefHtml = readFileSync(
    join(outputDirectory, `projects/${projectId}/brief/index.html`),
    "utf8",
  );
  const projectRootHtml = readFileSync(
    join(outputDirectory, `projects/${projectId}/index.html`),
    "utf8",
  );
  for (const [name, html] of [
    ["home", homeHtml],
    ["brief", briefHtml],
  ]) {
    if (!html.includes(`${basePath}/_next/`)) {
      throw new Error(`${name} export does not use the GitHub Pages asset base path`);
    }
    if (html.includes('src="/_next/') || html.includes('href="/_next/')) {
      throw new Error(`${name} export contains a root-relative Next.js asset URL`);
    }
  }
  if (!homeHtml.includes(`${basePath}/demo-shoe-colorways.png`)) {
    throw new Error("Pages export does not prefix the public demo image with basePath");
  }
  if (projectRootHtml.includes("NEXT_REDIRECT")) {
    throw new Error("Pages project root still contains a server redirect payload");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    interruptedBy = signal;
    child?.kill(signal);
  });
}

try {
  renameSync(routeHandlerPath, disabledRouteHandlerPath);
  routeHandlerDisabled = true;

  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  child = spawn(pnpm, ["--dir", "apps/web", "exec", "next", "build"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      GITHUB_PAGES: "1",
      NEXT_PUBLIC_STATIC_PREVIEW: "1",
    },
    stdio: "inherit",
  });

  const result = await new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
  child = undefined;

  if (interruptedBy) {
    process.exitCode = interruptedBy === "SIGINT" ? 130 : 143;
  } else if (result.code !== 0) {
    process.exitCode = result.code ?? 1;
  } else if (result.signal) {
    process.exitCode = 1;
  } else {
    verifyExport();
  }
} finally {
  restoreRouteHandler();
}

if (!existsSync(routeHandlerPath) || existsSync(disabledRouteHandlerPath)) {
  throw new Error("Pages build did not restore the server-only API route handler");
}
