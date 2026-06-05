/**
 * Token store: hashing, verification, bootstrap seeding, and management.
 *
 * Secrets are never persisted — only their SHA-256 hash. Lookups hash the
 * presented secret and match the stored hash. Bootstrap seeding refuses weak or
 * placeholder tokens (plan review finding #6) and, if the store ends up empty,
 * generates a strong admin token and surfaces it once so a fresh self-host is
 * usable without shipping a known secret.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { tokens } from "../db/schema.js";
import { ROLE_SCOPES, type Token, type TokenRole, type TokenScope } from "../types.js";
import { nowIso, type Clock, systemClock } from "../util/time.js";
import { scopesForRole } from "./scopes.js";

export interface VerifiedToken extends Token {
  /** Present so callers can scope-check without another lookup. */
  scopes: TokenScope[];
}

export interface SeedResult {
  seeded: TokenRole[];
  warnings: string[];
  /** Set only when a strong admin token had to be auto-generated. */
  generatedAdminSecret?: string;
}

const TOKEN_PREFIX = "wctx";

/** Minimum interval between lastUsedAt writes for the same token (ms). */
const LAST_USED_THROTTLE_MS = 60_000;

export function hashToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Generate a strong opaque token secret, e.g. `wctx_<43 base64url chars>`. */
export function generateTokenSecret(): string {
  return `${TOKEN_PREFIX}_${randomBytes(32).toString("base64url")}`;
}

/** A token is too weak to seed if it's a known placeholder or short. */
export function isWeakSecret(secret: string): boolean {
  return /^change-me/i.test(secret.trim()) || secret.trim().length < 24;
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

interface TokenRow {
  id: string;
  name: string;
  role: TokenRole;
  scopes: TokenScope[];
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function rowToToken(row: TokenRow): VerifiedToken {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    scopes: row.scopes,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? undefined,
  };
}

export class TokenStore {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Verify a presented secret. Returns the token (with scopes) or null.
   * Updates `lastUsedAt` on success.
   *
   * Security rests on high-entropy random secrets (`generateTokenSecret` =
   * 256-bit) hashed with SHA-256: the lookup key is the hash, not the raw
   * secret, so the indexed equality cannot be used to enumerate secrets (256-bit
   * space). The constant-time compare below is a belt-and-suspenders re-check of
   * the matched row, not the primary protection (review finding F2).
   */
  async verify(secret: string | undefined | null): Promise<VerifiedToken | null> {
    if (!secret) return null;
    const hash = hashToken(secret);
    const rows = (await this.db
      .select()
      .from(tokens)
      .where(eq(tokens.tokenHash, hash))
      .limit(1)) as TokenRow[];
    const row = rows[0];
    if (!row) return null;
    if (!constantTimeEqualHex(row.tokenHash, hash)) return null;

    // Throttle the lastUsedAt write so auth stays read-mostly on the hot path
    // (avoid a DB write on every authenticated request; review finding P3).
    const now = this.clock();
    const last = row.lastUsedAt ? Date.parse(row.lastUsedAt) : 0;
    if (Number.isNaN(last) || now.getTime() - last > LAST_USED_THROTTLE_MS) {
      await this.db
        .update(tokens)
        .set({ lastUsedAt: now.toISOString() })
        .where(eq(tokens.id, row.id));
    }

    return rowToToken(row);
  }

  async list(): Promise<Token[]> {
    const rows = (await this.db.select().from(tokens)) as TokenRow[];
    return rows.map(rowToToken);
  }

  async count(): Promise<number> {
    const rows = (await this.db
      .select({ c: sql<number>`count(*)` })
      .from(tokens)) as Array<{ c: number }>;
    return rows[0]?.c ?? 0;
  }

  /** Create a token; returns the domain record and the one-time plaintext secret. */
  async create(
    name: string,
    role: TokenRole,
    scopes?: TokenScope[],
  ): Promise<{ token: Token; secret: string }> {
    const secret = generateTokenSecret();
    const record: TokenRow = {
      id: newId(),
      name,
      role,
      scopes: scopes ?? scopesForRole(role),
      tokenHash: hashToken(secret),
      createdAt: nowIso(this.clock),
      lastUsedAt: null,
    };
    await this.db.insert(tokens).values(record);
    return { token: rowToToken(record), secret };
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.db.delete(tokens).where(eq(tokens.id, id));
    return (result.rowsAffected ?? 0) > 0;
  }

  /**
   * Seed bootstrap tokens from config. Idempotent: a secret already present
   * (by hash) is skipped. Weak/placeholder secrets are refused with a warning.
   * If the store is empty afterward, a strong admin token is generated.
   */
  async seedBootstrap(bootstrap: {
    admin?: string;
    device?: string;
    agent?: string;
  }): Promise<SeedResult> {
    const result: SeedResult = { seeded: [], warnings: [] };
    const entries: Array<[TokenRole, string | undefined]> = [
      ["admin", bootstrap.admin],
      ["device", bootstrap.device],
      ["agent", bootstrap.agent],
    ];

    for (const [role, secret] of entries) {
      if (!secret) continue;
      if (isWeakSecret(secret)) {
        result.warnings.push(
          `Refused to seed ${role.toUpperCase()}_TOKEN: it is a placeholder or shorter than 24 chars. Set a strong random value.`,
        );
        continue;
      }
      const hash = hashToken(secret);
      const existing = (await this.db
        .select({ id: tokens.id })
        .from(tokens)
        .where(eq(tokens.tokenHash, hash))
        .limit(1)) as Array<{ id: string }>;
      if (existing.length > 0) continue;

      await this.db.insert(tokens).values({
        id: newId(),
        name: `${role} (bootstrap)`,
        role,
        scopes: [...ROLE_SCOPES[role]],
        tokenHash: hash,
        createdAt: nowIso(this.clock),
        lastUsedAt: null,
      });
      result.seeded.push(role);
    }

    if ((await this.count()) === 0) {
      const secret = generateTokenSecret();
      await this.db.insert(tokens).values({
        id: newId(),
        name: "admin (auto-generated)",
        role: "admin",
        scopes: [...ROLE_SCOPES.admin],
        tokenHash: hashToken(secret),
        createdAt: nowIso(this.clock),
        lastUsedAt: null,
      });
      result.seeded.push("admin");
      result.generatedAdminSecret = secret;
    }

    return result;
  }
}

/**
 * Constant-time compare of two hex digests. Compares the raw UTF-8 bytes of the
 * hex strings (not the decoded bytes) so malformed/odd-length hex cannot be
 * silently truncated by Buffer.from(_, "hex") (review finding F4).
 */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}
