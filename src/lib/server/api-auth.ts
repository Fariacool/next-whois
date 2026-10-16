export const PRIVATE_API_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Netlify-CDN-Cache-Control": "no-store",
  Vary: "Authorization",
};

export const UNAUTHORIZED_HEADERS = {
  ...PRIVATE_API_HEADERS,
  "WWW-Authenticate": 'Bearer realm="Next Whois"',
};

export async function isApiAuthorized(
  authorization: string | null | undefined,
): Promise<boolean> {
  const expected = process.env.API_KEY;
  if (!expected) return true;

  const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) return false;

  // Fixed-size digests allow the same comparison in Node.js and Edge Runtime.
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(token)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const actualBytes = new Uint8Array(actualHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let i = 0; i < actualBytes.length; i++) {
    difference |= actualBytes[i] ^ expectedBytes[i];
  }
  return difference === 0;
}
