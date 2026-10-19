/**
 * Why a provider turned a call down, read from its error body, so the
 * dashboard can say what to fix instead of "the key was refused".
 *
 * The bodies matched here (recorded 2026-10-19 with a made-up key, or quoted
 * from the provider's docs and staff answers):
 * - Kakao Local, unknown key, 401:
 *   {"errorType":"AccessDeniedError","message":"appKey(<key>) does not exist"}
 * - Kakao Local, 카카오맵 product off for the app:
 *   {"errorType":"NotAuthorizedError","message":"App(<name>) disabled OPEN_MAP_AND_LOCAL service."}
 *   (https://devtalk.kakao.com/t/local-api-open-map-and-local/151696; fix: 제품 설정 > 카카오맵 > 사용 설정 ON)
 * - Kakao Mobility, unknown key, 401: {"code":-401,"msg":"appKey(<key>) does not exist"}; -3 a feature
 *   is off, -5 the API needs review, -10 quota, -903 an unregistered developer's key
 *   (https://developers.kakaomobility.com/guide/navi-api/solution.html)
 * - Naver Cloud gateway, 401:
 *   {"error":{"errorCode":"200","message":"Authentication Failed","details":"Invalid authentication information."}};
 *   210 Permission Denied; 429 with 400 Quota Exceeded, which is also the answer when the API is not
 *   selected for the Application; 410 and 420 throttled
 *   (https://api.ncloud-docs.com/docs/application-maps-overview)
 *
 * The provider's words come back as `providerMessage`, with every key masked:
 * Kakao echoes the key it was sent.
 */

import { z } from "zod";
import { errorForStatus } from "./http.js";
import { GeoError, type GeoErrorKind, type KeyProblem } from "./types.js";

export const PROVIDER_MESSAGE_MAX = 300;

/** Control and bidirectional-override characters. */
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
/** A run long enough to be a key, whoever's: Kakao keys are 32 hex characters. */
const KEY_LIKE = /[A-Za-z0-9_-]{20,}/g;
const MASK = "••••";

/** A provider's error text as the dashboard may show it: no key, printable, at most PROVIDER_MESSAGE_MAX characters. */
export function providerMessageOf(text: string | undefined, secrets: readonly string[]): string | undefined {
  if (!text) return undefined;
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join(MASK);
  out = out.replace(KEY_LIKE, MASK).replace(UNPRINTABLE, "").trim();
  return out ? [...out].slice(0, PROVIDER_MESSAGE_MAX).join("") : undefined;
}

const MESSAGES: Record<KeyProblem, string> = {
  key_invalid: "the maps provider does not know this key",
  map_service_disabled: "Kakao Map is turned off for this app",
  service_not_enabled: "this API is not enabled for the key's app",
  review_required: "this API needs the provider's review before the key may use it",
  quota: "the maps provider's quota or rate limit was reached",
  rejected: "the maps provider rejected the request",
  timeout: "the maps provider did not answer in time",
  upstream: "the maps provider failed",
};

const KIND_OF: Record<KeyProblem, GeoErrorKind> = {
  key_invalid: "auth",
  map_service_disabled: "auth",
  service_not_enabled: "auth",
  review_required: "auth",
  quota: "quota",
  rejected: "bad_request",
  timeout: "timeout",
  upstream: "upstream",
};

function failure(status: number, problem: KeyProblem | null, providerMessage: string | undefined): GeoError {
  if (!problem) {
    const plain = errorForStatus(status);
    return new GeoError(plain.kind, plain.message, { providerMessage });
  }
  // A 429 stays a quota failure for callers, whatever the person has to fix.
  return new GeoError(status === 429 ? "quota" : KIND_OF[problem], MESSAGES[problem], { problem, providerMessage });
}

/** Kakao's error body: `{ errorType, message }` (Local) or `{ code, msg }` (Mobility). */
const KakaoBody = z.object({ errorType: z.string(), message: z.string(), code: z.number(), msg: z.string() }).partial();

const KAKAO_CODES: Readonly<Record<number, KeyProblem>> = {
  [-3]: "service_not_enabled",
  [-5]: "review_required",
  [-10]: "quota",
  [-401]: "key_invalid",
  [-903]: "key_invalid",
};

function kakaoProblem(status: number, body: z.infer<typeof KakaoBody>): KeyProblem | null {
  if (body.message?.includes("OPEN_MAP_AND_LOCAL")) return "map_service_disabled";
  if (body.code !== undefined && KAKAO_CODES[body.code]) return KAKAO_CODES[body.code]!;
  if (body.errorType === "AccessDeniedError" || status === 401) return "key_invalid";
  if (body.errorType === "NotAuthorizedError") return "service_not_enabled";
  if (status === 429) return "quota";
  return null;
}

/** A non-2xx Kakao answer as the failure it means. */
export function kakaoFailure(status: number, body: unknown, secrets: readonly string[]): GeoError {
  const parsed = KakaoBody.safeParse(body).data ?? {};
  return failure(status, kakaoProblem(status, parsed), providerMessageOf(parsed.message ?? parsed.msg, secrets));
}

/** The Naver Cloud API gateway's error body. */
const NaverBody = z.object({
  error: z.object({ errorCode: z.string(), message: z.string().optional(), details: z.string().optional() }),
});

const NAVER_CODES: Readonly<Record<string, KeyProblem>> = {
  "200": "key_invalid",
  "210": "service_not_enabled",
  // Quota Exceeded: the quota, or, far more often, the API not selected for the Application.
  "400": "service_not_enabled",
  "410": "quota",
  "420": "quota",
};

/** A non-2xx Naver answer as the failure it means. */
export function naverFailure(status: number, body: unknown, secrets: readonly string[]): GeoError {
  const error = NaverBody.safeParse(body).data?.error;
  const problem = error ? (NAVER_CODES[error.errorCode] ?? null) : status === 401 ? "key_invalid" : null;
  const words = error ? [error.message, error.details].filter(Boolean).join(": ") : undefined;
  return failure(status, problem, providerMessageOf(words, secrets));
}
