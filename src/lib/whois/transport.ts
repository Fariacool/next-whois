import { connect } from "node:net";
import { MAX_RESPONSE_BYTES, UPSTREAM_TIMEOUT_MS, whoisConfig } from "./config";
import { LookupError, upstreamError } from "./errors";
import { UpstreamScheduler } from "./scheduler";

export function retryAfterSeconds(
  value: string | null,
  now = Date.now(),
): number {
  if (value && /^\d+$/.test(value.trim())) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) &&
      seconds < Number.MAX_SAFE_INTEGER / 1_000
      ? Math.max(1, seconds)
      : 60;
  }
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date)
    ? Math.max(1, Math.ceil((date - now) / 1_000))
    : 60;
}

function safeUrl(value: string | URL) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443")
  ) {
    throw new LookupError(
      "LOOKUP_FAILED",
      "The registry returned an unsupported RDAP URL.",
    );
  }
  return url;
}

export class RegistrationTransport {
  constructor(readonly scheduler: UpstreamScheduler) {}

  async json(
    value: string | URL,
    signal: AbortSignal,
    redirects = 0,
  ): Promise<{ status: number; data: unknown; server: string }> {
    const url = safeUrl(value);
    const response = await this.scheduler.run(
      url.hostname,
      signal,
      async () => {
        const timeout = AbortSignal.any([
          signal,
          AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        ]);
        try {
          const response = await fetch(url, {
            headers: { Accept: "application/rdap+json, application/json" },
            cache: "no-store",
            redirect: "manual",
            signal: timeout,
          });
          if (response.status === 429) {
            await response.body?.cancel();
            const seconds = retryAfterSeconds(
              response.headers.get("retry-after"),
            );
            this.scheduler.cooldown(url.hostname, seconds);
            throw new LookupError(
              "UPSTREAM_RATE_LIMITED",
              "The upstream RDAP server is rate limited. Retry later.",
              seconds,
            );
          }
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get("location");
            if (!location || redirects >= 3)
              throw new LookupError(
                "LOOKUP_FAILED",
                "Too many or invalid RDAP redirects.",
              );
            return {
              status: response.status,
              data: null,
              server: url.href,
              redirect: new URL(location, url).href,
            };
          }
          if (response.status !== 200) {
            await response.body?.cancel();
            return { status: response.status, data: null, server: url.href };
          }
          if (!response.body)
            throw new LookupError("LOOKUP_FAILED", "Empty RDAP response.");
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > MAX_RESPONSE_BYTES)
                throw new LookupError(
                  "LOOKUP_FAILED",
                  "The RDAP response was too large.",
                );
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
          }
          return {
            status: 200,
            data: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            server: url.href,
          };
        } catch (error) {
          throw upstreamError(error, timeout);
        }
      },
    );
    // Release the old host's permit before scheduling the redirect host.
    if (response.redirect)
      return this.json(response.redirect, signal, redirects + 1);
    return response;
  }

  async whois(
    host: string,
    query: string,
    signal: AbortSignal,
  ): Promise<string> {
    host = host.toLowerCase();
    if (
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
        host,
      ) ||
      /[\r\n\u0000]/.test(query)
    ) {
      throw new LookupError(
        "LOOKUP_FAILED",
        "The registry returned an invalid WHOIS referral.",
      );
    }
    return this.scheduler.run(host, signal, async () => {
      const timeout = AbortSignal.any([
        signal,
        AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      ]);
      try {
        const raw = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let failure: Error | undefined;
          const socket = connect(
            { host, port: 43, family: 4, signal: timeout },
            () => socket.write(`${query}\r\n`),
          );
          socket.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_RESPONSE_BYTES)
              socket.destroy(
                new LookupError(
                  "LOOKUP_FAILED",
                  "The WHOIS response was too large.",
                ),
              );
            else chunks.push(chunk);
          });
          socket.on("error", (error) => {
            failure = error;
          });
          socket.on("close", () => {
            if (failure) reject(failure);
            else resolve(Buffer.concat(chunks).toString("utf8"));
          });
        });
        if (
          /WHOIS LIMIT EXCEEDED|rate[ -]limit(?:ing)?(?: is| has been)? (?:exceeded|reached)|quota exceeded|too many (?:requests|queries)|query limit (?:exceeded|reached)|exceeded (?:the )?(?:rate[ -]limit|query quota)/i.test(
            raw,
          )
        ) {
          this.scheduler.cooldown(host, 60);
          throw new LookupError(
            "UPSTREAM_RATE_LIMITED",
            "The upstream WHOIS server is rate limited. Retry later.",
            60,
          );
        }
        return raw;
      } catch (error) {
        throw upstreamError(error, timeout);
      }
    });
  }
}

const processState = globalThis as typeof globalThis & {
  nextWhoisTransport?: RegistrationTransport;
};

export function registrationTransport() {
  if (!processState.nextWhoisTransport) {
    const config = whoisConfig();
    processState.nextWhoisTransport = new RegistrationTransport(
      new UpstreamScheduler(config.maxConcurrent, config.perServerConcurrent),
    );
  }
  return processState.nextWhoisTransport;
}
