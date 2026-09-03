import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const PREVIEW_TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const PREVIEW_MAX_WRITE_BODY_BYTES = 256 * 1024;
const PREVIEW_WRITE_LIMIT = 60;
const PREVIEW_WRITE_WINDOW_MS = 60_000;
const PREVIEW_RATE_BUCKET_CAPACITY = 4_096;
const PREVIEW_OVERFLOW_BUCKET = "__preview_overflow__";
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type PreviewRateBucket = {
  count: number;
  window: number;
};

const previewRateBuckets = new Map<string, PreviewRateBucket>();
let lastSweptWindow = -1;

const HOP_BY_HOP_HEADERS = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function upstreamUrl(request: NextRequest): string {
  const origin = (process.env.API_INTERNAL_ORIGIN ?? "http://127.0.0.1:8000").replace(
    /\/$/,
    "",
  );
  const suffix = request.nextUrl.pathname.slice("/api/v1".length);
  return `${origin}/api/v1${suffix}${request.nextUrl.search}`;
}

function previewClientKey(request: NextRequest): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  const forwardedClient = forwardedFor?.split(",", 1)[0]?.trim();
  const realIp = request.headers.get("x-real-ip")?.trim();
  const candidate = forwardedClient || realIp || "unknown";
  return candidate.toLowerCase().slice(0, 128);
}

function consumePreviewWriteAllowance(
  request: NextRequest,
  now = Date.now(),
): { allowed: boolean; retryAfterSeconds: number } {
  const currentWindow = Math.floor(now / PREVIEW_WRITE_WINDOW_MS);

  if (currentWindow !== lastSweptWindow) {
    for (const [key, bucket] of previewRateBuckets) {
      if (bucket.window !== currentWindow) {
        previewRateBuckets.delete(key);
      }
    }
    lastSweptWindow = currentWindow;
  }

  const clientKey = previewClientKey(request);
  const bucketKey =
    previewRateBuckets.has(clientKey) ||
    previewRateBuckets.size < PREVIEW_RATE_BUCKET_CAPACITY - 1
      ? clientKey
      : PREVIEW_OVERFLOW_BUCKET;
  const existing = previewRateBuckets.get(bucketKey);
  const bucket =
    existing?.window === currentWindow
      ? existing
      : { count: 0, window: currentWindow };

  bucket.count += 1;
  previewRateBuckets.set(bucketKey, bucket);

  return {
    allowed: bucket.count <= PREVIEW_WRITE_LIMIT,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(
        ((currentWindow + 1) * PREVIEW_WRITE_WINDOW_MS - now) / 1_000,
      ),
    ),
  };
}

async function readPreviewBody(
  request: NextRequest,
): Promise<{ body?: ArrayBuffer; tooLarge: boolean }> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > PREVIEW_MAX_WRITE_BODY_BYTES
    ) {
      return { tooLarge: true };
    }
  }

  if (!request.body) {
    return { tooLarge: false };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > PREVIEW_MAX_WRITE_BODY_BYTES) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(new ArrayBuffer(totalBytes));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: body.buffer, tooLarge: false };
}

function previewError(
  status: 413 | 429,
  detail: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { detail },
    {
      status,
      headers: { "Cache-Control": "no-store", ...headers },
    },
  );
}

async function proxy(request: NextRequest): Promise<Response> {
  const previewMode = PREVIEW_TRUTHY_VALUES.has(
    (process.env.PUBLIC_PREVIEW_MODE ?? "").trim().toLowerCase(),
  );
  const attachmentUpload =
    request.method === "POST" &&
    /^\/api\/v1\/projects\/[^/]+\/attachments\/?$/.test(request.nextUrl.pathname);
  if (previewMode && attachmentUpload) {
    return Response.json(
      { detail: "attachment uploads are disabled in public preview mode" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const isWrite = !BODYLESS_METHODS.has(request.method);
  if (previewMode && isWrite) {
    const rateLimit = consumePreviewWriteAllowance(request);
    if (!rateLimit.allowed) {
      return previewError(429, "public preview write rate limit exceeded", {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }
  }

  const requestHeaders = new Headers(request.headers);
  HOP_BY_HOP_HEADERS.forEach((name) => requestHeaders.delete(name));
  requestHeaders.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
  requestHeaders.set("x-forwarded-host", request.headers.get("host") ?? "");

  const hasBody = !BODYLESS_METHODS.has(request.method);
  try {
    let requestBody: ArrayBuffer | undefined;
    if (hasBody) {
      if (previewMode) {
        const previewBody = await readPreviewBody(request);
        if (previewBody.tooLarge) {
          return previewError(
            413,
            `public preview request body exceeds ${PREVIEW_MAX_WRITE_BODY_BYTES} bytes`,
          );
        }
        requestBody = previewBody.body;
      } else {
        requestBody = await request.arrayBuffer();
      }
    }

    const upstream = await fetch(upstreamUrl(request), {
      method: request.method,
      headers: requestHeaders,
      body: requestBody,
      cache: "no-store",
      redirect: "manual",
    });
    const responseHeaders = new Headers(upstream.headers);
    HOP_BY_HOP_HEADERS.forEach((name) => responseHeaders.delete(name));
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json(
      { detail: "preview API is unavailable" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
