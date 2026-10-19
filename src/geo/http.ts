/**
 * The one outbound request a provider adapter makes: a GET with a timeout,
 * no redirects and no retries, answering the status and parsed JSON. Its
 * errors never carry the URL, which holds coordinates, or the headers, which
 * hold the key.
 */

import { GeoError } from "./types.js";

export const GEO_TIMEOUT_MS = 5000;

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
  let body: unknown;
  try {
    body = await res.json();
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
