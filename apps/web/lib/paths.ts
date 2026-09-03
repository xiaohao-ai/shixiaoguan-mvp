const configuredBasePath = process.env.NEXT_PUBLIC_APP_BASE_PATH ?? "";

export const APP_BASE_PATH = configuredBasePath.replace(/\/$/, "");

export function publicAssetPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${APP_BASE_PATH}${normalizedPath}`;
}
