import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const origin = 'http://127.0.0.1:3000';
const expectedArch = { amd64: 'x64', arm64: 'arm64' }[process.env.EXPECTED_ARCH];
assert.ok(expectedArch, 'EXPECTED_ARCH must be amd64 or arm64');
assert.equal(process.arch, expectedArch, 'The image must match the native runner');
assert.ok(process.env.API_KEY, 'Set a runtime API_KEY for the smoke test');

async function request(path, key) {
  return fetch(`${origin}${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
}

let html;
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const response = await request('/en');
    if (response.ok) {
      html = await response.text();
      break;
    }
    await response.body?.cancel();
  } catch {
    // The Next.js server may still be starting.
  }
  await delay(250);
}
assert.ok(html, 'The container must become ready within 30 seconds');
assert.match(html, /__NEXT_DATA__/);

const script = html.match(/src="(\/_next\/static\/[^\"]+)"/)?.[1];
assert.ok(script, 'The page must reference a Next.js static script');
for (const path of [script, '/icons/icon-192x192.png']) {
  const response = await request(path);
  assert.equal(response.status, 200, `Static asset: ${path}`);
  await response.arrayBuffer();
}

for (const path of ['/api/lookup', '/api/og']) {
  for (const key of [undefined, 'incorrect-smoke-key']) {
    const response = await request(path, key);
    assert.equal(response.status, 401, `Reject unauthorized access: ${path}`);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal((await response.json()).error, 'Error 401');
  }
}

const lookup = await request('/api/lookup', process.env.API_KEY);
assert.equal(lookup.status, 400, 'The runtime key must pass authentication');
assert.equal((await lookup.json()).error, 'Query is required');

const og = await request('/api/og?w=200&h=200', process.env.API_KEY);
assert.equal(og.status, 200, 'The Edge OG route must generate an image');
assert.match(og.headers.get('cache-control') ?? '', /no-store/);
assert.equal(
  Buffer.from(await og.arrayBuffer()).subarray(0, 8).toString('hex'),
  '89504e470d0a1a0a',
  'The OG response must be a PNG',
);

console.log(`Container smoke test passed on ${process.arch}: HTML, assets, runtime API key and Edge OG PNG.`);
