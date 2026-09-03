import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("public asset paths", () => {
  it("keeps root-relative assets unchanged outside GitHub Pages", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "");
    const { publicAssetPath } = await import("@/lib/paths");

    expect(publicAssetPath("demo.png")).toBe("/demo.png");
  });

  it("prefixes public assets with the configured GitHub Pages base path", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/shixiaoguan-mvp/");
    const { publicAssetPath } = await import("@/lib/paths");

    expect(publicAssetPath("/demo.png")).toBe("/shixiaoguan-mvp/demo.png");
  });
});
