import type { NextApiRequest, NextApiResponse } from "next";
import {
  isApiAuthorized,
  PRIVATE_API_HEADERS,
  UNAUTHORIZED_HEADERS,
} from "@/lib/server/api-auth";
import { MAX_BODY_BYTES, whoisConfig } from "@/lib/whois/config";
import { lookupWhoisBatch } from "@/lib/whois/lookup";
import { WhoisBatchResult, WhoisResult } from "@/lib/whois/types";

// Authenticate before reading or parsing JSON, including malformed requests.
export const config = { api: { bodyParser: false } };

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function batchInputs(req: NextApiRequest): Promise<string[]> {
  if (
    req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !==
    "application/json"
  ) {
    throw new RequestError(415, "Send an application/json request body.");
  }
  if (Number(req.headers["content-length"]) > MAX_BODY_BYTES)
    throw new RequestError(413, "The request body exceeds 64 KiB.");
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket alive so an oversized chunked body can receive HTTP 413.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES)
      throw new RequestError(413, "The request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError(400, "The request body must be valid JSON.");
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "queries")
  ) {
    throw new RequestError(
      400,
      "Provide an object containing only a queries array.",
    );
  }
  const queries = (body as { queries?: unknown }).queries;
  if (
    !Array.isArray(queries) ||
    !queries.length ||
    !queries.every((query) => typeof query === "string")
  ) {
    throw new RequestError(400, "queries must be a nonempty array of strings.");
  }
  const { batchLimit } = whoisConfig();
  if (queries.length > batchLimit)
    throw new RequestError(
      400,
      `A batch may contain at most ${batchLimit} queries.`,
    );
  return queries;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<WhoisBatchResult | WhoisResult>,
) {
  for (const [name, value] of Object.entries(PRIVATE_API_HEADERS))
    res.setHeader(name, value);
  if (!(await isApiAuthorized(req.headers.authorization))) {
    for (const [name, value] of Object.entries(UNAUTHORIZED_HEADERS))
      res.setHeader(name, value);
    req.resume();
    return res
      .status(401)
      .json({ status: false, time: -1, error: "Error 401" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    req.resume();
    return res
      .status(405)
      .json({ status: false, time: -1, error: "Method not allowed" });
  }
  try {
    const inputs = await batchInputs(req);
    return res.status(200).json(await lookupWhoisBatch(inputs));
  } catch (error) {
    req.resume();
    return res.status(error instanceof RequestError ? error.status : 500).json({
      status: false,
      time: -1,
      error:
        error instanceof RequestError
          ? error.message
          : "The batch lookup could not be completed.",
    });
  }
}
