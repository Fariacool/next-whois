import type { NextApiRequest, NextApiResponse } from "next";
import { lookupWhoisWithCache } from "@/lib/whois/lookup";
import { WhoisResult } from "@/lib/whois/types";
import {
  isApiAuthorized,
  PRIVATE_API_HEADERS,
  UNAUTHORIZED_HEADERS,
} from "@/lib/server/api-auth";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WhoisResult>,
) {
  if (process.env.API_KEY) {
    for (const [name, value] of Object.entries(PRIVATE_API_HEADERS))
      res.setHeader(name, value);
  }
  if (!(await isApiAuthorized(req.headers.authorization))) {
    for (const [name, value] of Object.entries(UNAUTHORIZED_HEADERS))
      res.setHeader(name, value);
    return res
      .status(401)
      .json({ time: -1, status: false, error: "Error 401" });
  }

  const query = req.query.query || req.query.q;

  if (!query || typeof query !== "string" || query.length === 0) {
    return res
      .status(400)
      .json({ time: -1, status: false, error: "Query is required" });
  }

  const {
    time,
    status,
    result,
    error,
    cached,
    source,
    errorCode,
    retryAfterSeconds,
  } = await lookupWhoisWithCache(query);
  if (!status) {
    if (retryAfterSeconds !== undefined)
      res.setHeader("Retry-After", String(retryAfterSeconds));
    const statusCode =
      errorCode === "INVALID_QUERY"
        ? 400
        : errorCode === "BUSY"
          ? 503
          : errorCode === "UPSTREAM_RATE_LIMITED"
            ? 429
            : errorCode === "LOOKUP_TIMEOUT"
              ? 504
              : 500;
    return res
      .status(statusCode)
      .json({ time, status, error, errorCode, retryAfterSeconds });
  }

  if (!process.env.API_KEY) {
    res.setHeader(
      "Cache-Control",
      "s-maxage=3600, stale-while-revalidate=86400",
    );
  }
  return res.status(200).json({ time, status, result, cached, source });
}
