import { defineConfig, devices } from "@playwright/test";

const previewOrigin = "http://127.0.0.1:3200";
const previewBasePath = "/shixiaoguan-mvp";

export default defineConfig({
  testDir: "./e2e-pages",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: previewOrigin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "github-pages-chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node ../../scripts/pages-preview-server.mjs",
    url: `${previewOrigin}${previewBasePath}/`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
