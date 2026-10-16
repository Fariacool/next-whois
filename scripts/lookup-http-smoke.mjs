import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { request as httpRequest } from "node:http";

async function start(key) {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const child = spawn(
    process.execPath,
    [
      "--require",
      resolve("tests/fixtures/lookup-upstreams.cjs"),
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      env: {
        ...process.env,
        API_KEY: key,
        REDIS_HOST: "",
        MOZ_ACCESS_ID: "",
        MOZ_SECRET_KEY: "",
        WHOIS_BATCH_LIMIT: "4",
        WHOIS_MAX_CONCURRENT: "3",
        WHOIS_PER_SERVER_CONCURRENT: "1",
        NEXT_PUBLIC_MAX_WHOIS_FOLLOW: "2",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const events = [];
  let output = "";
  child.on("message", (event) => events.push(event));
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-4000);
    });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error(output);
    try {
      const response = await fetch(`${origin}/api/lookup`, {
        signal: AbortSignal.timeout(1000),
      });
      if ([400, 401].includes(response.status)) {
        await response.body?.cancel();
        return { child, origin, events };
      }
    } catch {
      /* Wait for startup. */
    }
    await delay(100);
  }
  child.kill("SIGKILL");
  throw Error(`Production server did not start: ${output}`);
}
async function stop(server) {
  if (server.child.exitCode !== null) return;
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  const timer = setTimeout(() => server.child.kill("SIGKILL"), 3000);
  await exited;
  clearTimeout(timer);
}
async function run(key) {
  const server = await start(key);
  const { origin, events } = server;
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const call = (path, init = {}) =>
    fetch(`${origin}${path}`, {
      ...init,
      headers: { ...headers, ...init.headers },
      signal: AbortSignal.timeout(15000),
    });
  const single = (query) =>
    call(`/api/lookup?query=${encodeURIComponent(query)}`).then((response) =>
      response.json(),
    );
  const batch = (queries) =>
    call("/api/lookup/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries }),
    });
  try {
    if (key) {
      const unauthorized = await fetch(`${origin}/api/lookup/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{invalid",
      });
      assert.equal(unauthorized.status, 401);
      assert.match(unauthorized.headers.get("cache-control"), /no-store/);
    }
    assert.equal((await call("/api/lookup/batch")).status, 405);
    assert.equal(
      (
        await call("/api/lookup/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{invalid",
        })
      ).status,
      400,
    );
    assert.equal((await batch(Array(5).fill("a.com"))).status, 400);
    const response = await batch([
      "Example.COM",
      "bad domain",
      "example.com",
      "fallback.net",
    ]);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control"), /no-store/);
    const result = await response.json();
    assert.deepEqual(
      result.results.map((item) => item.input),
      ["Example.COM", "bad domain", "example.com", "fallback.net"],
    );
    assert.deepEqual(result.summary, { total: 4, succeeded: 3, failed: 1 });
    assert.equal(result.results[0].source, "rdap");
    assert.equal(result.results[0].result.rawWhoisContent, "");
    assert.equal(result.results[3].source, "whois");
    assert.equal(
      events.filter(
        (event) =>
          event.type === "query" &&
          event.protocol === "rdap" &&
          event.query === "example.com",
      ).length,
      1,
    );
    assert.equal((await single("www.EXAMPLE.com")).cached, true);

    const [a, b] = await Promise.all([
      single("shared.com"),
      batch(["SHARED.COM", "www.shared.com"]).then((response) =>
        response.json(),
      ),
    ]);
    assert.equal(a.status, true);
    assert.equal(b.summary.succeeded, 2);
    assert.equal(
      events.filter(
        (event) =>
          event.type === "query" &&
          event.protocol === "rdap" &&
          event.query === "shared.com",
      ).length,
      1,
    );
    const workloads = await Promise.all([
      batch(["q1.com", "q2.com", "q3.net", "fallback.com"]).then((response) =>
        response.json(),
      ),
      batch(["q4.com", "q5.net", "q6.net", "redirect.com"]).then((response) =>
        response.json(),
      ),
      single("q7.net"),
      single("AS13335"),
    ]);
    assert.ok(workloads.every((item) => item.status));
    const starts = events.filter((event) => event.type === "start");
    assert.ok(
      starts.every((event) => event.total <= 3 && event.perHost <= 1),
      "Single and batch requests must share real connection limits",
    );
    assert.ok(
      starts.some((event) => event.total >= 2),
      "Different upstream hosts must make concurrent progress",
    );
    const addresses = await (
      await batch(["8.8.8.8", "2001:db8::1", "192.0.2.0/24", "AS13335"])
    ).json();
    assert.equal(addresses.summary.succeeded, 4);
    assert.equal((await single("example.ac.uk")).source, "whois");
    assert.equal((await single("digital.nhs.uk")).status, false);
    const missing = await single("missing.com");
    assert.equal(missing.status, false);
    assert.ok(
      events.some(
        (event) =>
          event.type === "query" &&
          event.protocol === "whois" &&
          event.query === "missing.com",
      ),
      "RDAP 404 must fall back to WHOIS",
    );
    assert.equal((await single("malformed.com")).status, false);
    const limited = await single("rate.org");
    assert.equal(limited.errorCode, "UPSTREAM_RATE_LIMITED");
    const calls = events.filter(
      (event) =>
        event.type === "query" && event.host === "limited.fixture.example",
    ).length;
    assert.equal(
      (await single("another.org")).errorCode,
      "UPSTREAM_RATE_LIMITED",
    );
    assert.equal(
      events.filter(
        (event) =>
          event.type === "query" && event.host === "limited.fixture.example",
      ).length,
      calls,
    );

    const chunkedStatus = await new Promise((done, reject) => {
      const request = httpRequest(
        `${origin}/api/lookup/batch`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
        },
        (response) => {
          response.resume();
          response.on("end", () => done(response.statusCode));
        },
      );
      request.on("error", reject);
      request.write(" ".repeat(70_000));
      request.end();
    });
    assert.equal(chunkedStatus, 413);
    if (key) {
      assert.equal(
        (await single("slowrdap.com")).source,
        "whois",
        "RDAP timeouts should fall back",
      );
      const timed = await call("/api/lookup?query=timeoutwhois.com");
      assert.equal(timed.status, 504);
      assert.equal((await timed.json()).errorCode, "LOOKUP_TIMEOUT");
      const rate = await single("whois-rate.lv");
      assert.equal(rate.errorCode, "UPSTREAM_RATE_LIMITED");
      assert.equal(
        (await single("another.lv")).errorCode,
        "UPSTREAM_RATE_LIMITED",
      );
    }
    console.log(
      `Production HTTP smoke passed (${key ? "protected" : "public"}): RDAP-first, fallback, batch ordering, shared cache/deduplication, global/per-host limits, redirects, IP/ASN/CIDR, authentication, body limits and cooldowns.`,
    );
  } finally {
    await stop(server);
  }
}
await run("http-fixture-key");
await run("");
