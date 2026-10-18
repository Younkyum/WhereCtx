/**
 * Secret primitives shared by tokens and the account layer: random ids,
 * opaque secrets, human-typeable codes, and their hashing and comparison.
 * Stored secrets are always `hashToken` digests; plaintext leaves the server
 * once (token, cookie, invite URL, setup banner, recovery list) and is never kept.
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** Uppercase letters and digits minus I, L, O, U, 0, 1, so nothing is misread. */
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

/** 256-bit opaque secret for cookies and invite links. */
export function newOpaqueSecret(): string {
  return randomBytes(32).toString("base64url");
}

export const OPAQUE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** `length` characters drawn uniformly from CODE_ALPHABET. */
export function randomCodeChars(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** A code like `K7QM-2XRB-9TWD`: `groups` groups of `size` characters. */
export function generateCode(groups: number, size: number): string {
  return Array.from({ length: groups }, () => randomCodeChars(size)).join("-");
}

/** Split `chars` into dash-separated groups of `size` for display. */
export function groupCode(chars: string, size: number): string {
  return chars.match(new RegExp(`.{1,${size}}`, "g"))!.join("-");
}

/** The canonical form a typed code is hashed or compared in. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, "");
}

/** Constant-time string equality (length-independent: compares digests). */
export function secretsEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}
