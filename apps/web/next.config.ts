import type { NextConfig } from "next";

const isGitHubPages =
  process.env.GITHUB_PAGES === "1" &&
  process.env.NEXT_PUBLIC_STATIC_PREVIEW === "1";
const basePath = isGitHubPages ? "/shixiaoguan-mvp" : "";

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : "standalone",
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: isGitHubPages,
  images: {
    unoptimized: isGitHubPages,
  },
  env: {
    NEXT_PUBLIC_APP_BASE_PATH: basePath,
  },
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
