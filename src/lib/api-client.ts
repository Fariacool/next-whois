export const API_KEY_STORAGE_KEY = "next-whois.api-key";

export function requestApi(
  path: string,
  apiKey: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!path.startsWith("/api/")) {
    throw new Error("API requests must use a local /api/ path");
  }

  const headers = new Headers(init.headers);
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  else headers.delete("Authorization");

  return fetch(path, {
    ...init,
    headers,
    credentials: "omit",
    cache: "no-store",
  });
}
