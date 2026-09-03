import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET, OPTIONS, POST } from "@/app/api/v1/[...path]/route";

describe("same-origin API proxy", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("forwards the full API path and query to the runtime-only internal origin", async () => {
    vi.stubEnv("API_INTERNAL_ORIGIN", "http://127.0.0.1:8123/");
    const upstreamFetch = vi.fn().mockResolvedValue(
      Response.json({ status: "ok" }, { headers: { "x-upstream": "api" } }),
    );
    vi.stubGlobal("fetch", upstreamFetch);

    const response = await GET(
      new NextRequest("https://preview.example/api/v1/health?probe=1"),
    );

    expect(upstreamFetch).toHaveBeenCalledOnce();
    expect(upstreamFetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:8123/api/v1/health?probe=1",
    );
    expect(upstreamFetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("x-upstream")).toBe("api");
  });

  it("rejects public-preview attachment uploads at the same-origin edge", async () => {
    vi.stubEnv("PUBLIC_PREVIEW_MODE", "1");
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    const request = new NextRequest(
      "https://preview.example/api/v1/projects/project-1/attachments",
      {
        method: "POST",
        body: "body-that-must-not-be-forwarded",
        headers: { "content-type": "multipart/form-data; boundary=test" },
      },
    );

    const response = await POST(request);

    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      detail: "attachment uploads are disabled in public preview mode",
    });
  });

  it("rejects an oversized declared write body before forwarding it", async () => {
    vi.stubEnv("PUBLIC_PREVIEW_MODE", "true");
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    const request = new NextRequest(
      "https://preview.example/api/v1/projects",
      {
        method: "POST",
        body: "body-that-must-not-be-read",
        headers: {
          "content-length": String(256 * 1024 + 1),
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.10",
        },
      },
    );

    const response = await POST(request);

    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      detail: "public preview request body exceeds 262144 bytes",
    });
  });

  it("enforces the write body limit while streaming when content-length is absent", async () => {
    vi.stubEnv("PUBLIC_PREVIEW_MODE", "on");
    const upstreamFetch = vi.fn();
    vi.stubGlobal("fetch", upstreamFetch);
    const request = new NextRequest(
      "https://preview.example/api/v1/projects",
      {
        method: "POST",
        body: new Uint8Array(256 * 1024 + 1),
        headers: {
          "content-type": "application/octet-stream",
          "x-forwarded-for": "203.0.113.11",
        },
      },
    );

    const response = await POST(request);

    expect(upstreamFetch).not.toHaveBeenCalled();
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("forwards a public-preview write at the body-size boundary", async () => {
    vi.stubEnv("PUBLIC_PREVIEW_MODE", "yes");
    const upstreamFetch = vi.fn().mockResolvedValue(
      Response.json({ accepted: true }),
    );
    vi.stubGlobal("fetch", upstreamFetch);
    const request = new NextRequest(
      "https://preview.example/api/v1/projects",
      {
        method: "POST",
        body: new Uint8Array(256 * 1024),
        headers: {
          "content-type": "application/octet-stream",
          "x-forwarded-for": "203.0.113.12",
        },
      },
    );

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    const forwardedBody = upstreamFetch.mock.calls[0][1]?.body;
    expect(forwardedBody).toBeInstanceOf(ArrayBuffer);
    expect((forwardedBody as ArrayBuffer).byteLength).toBe(256 * 1024);
  });

  it("rate-limits preview writes per forwarded client for each fixed window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    vi.stubEnv("PUBLIC_PREVIEW_MODE", "1");
    const upstreamFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ accepted: true })));
    vi.stubGlobal("fetch", upstreamFetch);

    const postFor = (forwardedFor: string) =>
      POST(
        new NextRequest("https://preview.example/api/v1/projects", {
          method: "POST",
          body: "{}",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": forwardedFor,
          },
        }),
      );

    for (let requestNumber = 0; requestNumber < 60; requestNumber += 1) {
      const response = await postFor("203.0.113.20");
      expect(response.status).toBe(200);
    }

    const limited = await postFor("203.0.113.20");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("retry-after")).toBe("60");
    await expect(limited.json()).resolves.toEqual({
      detail: "public preview write rate limit exceeded",
    });

    const otherClient = await postFor("203.0.113.21");
    expect(otherClient.status).toBe(200);

    vi.advanceTimersByTime(60_000);
    const nextWindow = await postFor("203.0.113.20");
    expect(nextWindow.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(62);
  });

  it("does not apply the preview write budget to GET or OPTIONS", async () => {
    vi.stubEnv("PUBLIC_PREVIEW_MODE", "1");
    const upstreamFetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({ status: "ok" })));
    vi.stubGlobal("fetch", upstreamFetch);
    const headers = { "x-forwarded-for": "203.0.113.30" };

    for (let requestNumber = 0; requestNumber < 61; requestNumber += 1) {
      await POST(
        new NextRequest("https://preview.example/api/v1/projects", {
          method: "POST",
          body: "{}",
          headers,
        }),
      );
    }

    const getResponse = await GET(
      new NextRequest("https://preview.example/api/v1/projects", { headers }),
    );
    const optionsResponse = await OPTIONS(
      new NextRequest("https://preview.example/api/v1/projects", {
        method: "OPTIONS",
        headers,
      }),
    );

    expect(getResponse.status).toBe(200);
    expect(optionsResponse.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(62);
    expect(upstreamFetch.mock.calls.at(-1)?.[1]?.body).toBeUndefined();
  });
});
