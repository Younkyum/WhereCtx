/**
 * The one outbound request a provider adapter makes: a GET with a timeout,
 * no redirects and no retries, answering the status and parsed JSON from a
 * body no larger than GEO_MAX_BODY_BYTES. Its errors never carry the URL,
 * which holds coordinates, or the headers, which hold the key. Every string
 * an adapter keeps from a response goes through `providerText`.
 */

import { z } from "zod";
import { GeoError } from "./types.js";

export const GEO_TIMEOUT_MS = 5000;
/** A long car route with every vertex stays well under this. */
export const GEO_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Longest string kept from a provider: a road, an address, a turn. */
export const PROVIDER_TEXT_MAX = 200;

/** Control and bidirectional-override characters, which a provider's text has no use for. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A provider's string as WhereCtx keeps it: printable, trimmed, at most PROVIDER_TEXT_MAX characters. */
export function cleanProviderText(value: string): string {
  return [...value.replace(UNPRINTABLE, "").trim()].slice(0, PROVIDER_TEXT_MAX).join("");
}

/** A string field of a provider response, cleaned. */
export const providerText = z.string().transform(cleanProviderText);

async function readCapped(res: Response, max: number): Promise<string> {
  const tooLarge = () => new GeoError("upstream", "the maps provider answered with too much data");
  if (Number(res.headers.get("content-length") ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface GeoHttpResponse {
  status: number;
  /** The parsed body, or undefined when it was not JSON. */
  body: unknown;
}

export async function getJson(
  fetchFn: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  timeoutMs = GEO_TIMEOUT_MS,
  maxBytes = GEO_MAX_BODY_BYTES,
): Promise<GeoHttpResponse> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new GeoError("timeout", "the maps provider did not answer in time");
    throw new GeoError("upstream", "the maps provider could not be reached");
  }
  let text: string;
  try {
    text = await readCapped(res, maxBytes);
  } catch (e) {
    if (e instanceof GeoError) throw e;
    throw new GeoError("upstream", "the maps provider's answer was cut off");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

/** The error kind a non-2xx status means, before any provider-specific body is read. */
export function errorForStatus(status: number): GeoError {
  if (status === 401 || status === 403) return new GeoError("auth", "the maps provider refused the key");
  if (status === 429) return new GeoError("quota", "the maps provider's quota or rate limit was reached");
  if (status === 400 || status === 404 || status === 413) return new GeoError("bad_request", "the maps provider rejected the request");
  return new GeoError("upstream", `the maps provider failed (status ${status})`);
}

/** A 2xx body that does not match the documented shape. */
export const malformed = (): GeoError => new GeoError("upstream", "the maps provider answered in an unexpected format");
