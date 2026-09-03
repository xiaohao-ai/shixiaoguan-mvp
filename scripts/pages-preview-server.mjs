import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = join(repositoryRoot, "apps/web/out");
const basePath = (process.env.PAGES_PREVIEW_BASE_PATH ?? "/shixiaoguan-mvp")
  .replace(/\/$/, "");
const host = process.env.PAGES_PREVIEW_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PAGES_PREVIEW_PORT ?? "3200", 10);

if (!existsSync(join(outputRoot, "index.html"))) {
  throw new Error(
    `GitHub Pages export not found at ${outputRoot}. Run \`pnpm build:pages\` first.`,
  );
}
if (!basePath.startsWith("/") || basePath.includes("..")) {
  throw new Error(`Unsafe PAGES_PREVIEW_BASE_PATH: ${basePath}`);
}
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PAGES_PREVIEW_PORT: ${process.env.PAGES_PREVIEW_PORT}`);
}

const contentTypes = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

function resolveRequestPath(requestUrl) {
  const pathname = new URL(requestUrl, `http://${host}:${port}`).pathname;
  if (pathname === basePath) return { redirect: `${basePath}/` };
  if (!pathname.startsWith(`${basePath}/`)) return undefined;

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname.slice(basePath.length));
  } catch {
    return undefined;
  }
  const relativePath = normalize(decodedPath).replace(/^([/\\])+/, "");
  const candidate = resolve(outputRoot, relativePath || ".");
  if (candidate !== outputRoot && !candidate.startsWith(`${outputRoot}${sep}`)) {
    return undefined;
  }

  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    return { file: join(candidate, "index.html") };
  }
  return { file: candidate };
}

const server = createServer((request, response) => {
  if (!request.url || !["GET", "HEAD"].includes(request.method ?? "")) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const target = resolveRequestPath(request.url);
  if (target?.redirect) {
    response.writeHead(308, { Location: target.redirect }).end();
    return;
  }

  const requestedFile = target?.file;
  const file = requestedFile && existsSync(requestedFile) && statSync(requestedFile).isFile()
    ? requestedFile
    : join(outputRoot, "404.html");
  const status = requestedFile === file ? 200 : 404;
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": contentTypes.get(extname(file).toLowerCase()) ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  };
  response.writeHead(status, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`GitHub Pages preview server: http://${host}:${port}${basePath}/`);
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 1_000).unref();
  });
}
