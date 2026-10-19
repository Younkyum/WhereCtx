/**
 * Persistence for the OAuth authorization server: the oidc-provider Adapter
 * contract over the `oauth_store` table, plus the reads WhereCtx needs itself
 * (a person's grants, for the Agents screen, and a grant's client name, for
 * the access log) and the prune sweep.
 *
 * Expiry follows the library's clock (Date.now), not the app clock: the
 * library computes every `expiresIn` against it. A row the library gives no
 * lifetime (a dynamically registered client) lasts 30 days, so every row is
 * eventually pruned.
 *
 * Token values are bearer secrets, so their rows are keyed by the value's
 * SHA-256 and keep no copy of it; the library always looks them up by the raw
 * value, which `find` puts back as the payload's `jti`.
 */

import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, lte, or } from "drizzle-orm";
import type { Adapter, AdapterPayload } from "oidc-provider";
import type { Database } from "../db/index.js";
import { oauthStore } from "../db/schema.js";
import type { UserId } from "../types.js";

type Row = typeof oauthStore.$inferSelect;

const DEFAULT_TTL_SEC = 30 * 24 * 3600;

/** Models whose id is the token value a client presents. All are looked up by id alone. */
const SECRET_ID_MODELS: ReadonlySet<string> = new Set([
  "AccessToken",
  "AuthorizationCode",
  "RefreshToken",
  "ClientCredentials",
  "InitialAccessToken",
  "RegistrationAccessToken",
]);

/** A grant and the models issued under it. */
const GRANT_BOUND_MODELS = ["Grant", "AccessToken", "RefreshToken", "AuthorizationCode"];

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64url");

function toPayload(row: Row | undefined): AdapterPayload | undefined {
  if (!row || (row.expiresAt !== null && row.expiresAt <= Date.now())) return undefined;
  const payload = row.payload as AdapterPayload;
  return row.consumedAt === null ? payload : { ...payload, consumed: Math.floor(row.consumedAt / 1000) };
}

class ModelAdapter implements Adapter {
  private readonly secretIds: boolean;

  constructor(
    private readonly db: Database,
    private readonly model: string,
  ) {
    this.secretIds = SECRET_ID_MODELS.has(model);
  }

  private key(id: string): string {
    return this.secretIds ? sha256(id) : id;
  }

  private where(id: string) {
    return and(eq(oauthStore.model, this.model), eq(oauthStore.id, this.key(id)));
  }

  private async first(condition: ReturnType<typeof and>): Promise<AdapterPayload | undefined> {
    const rows = await this.db.select().from(oauthStore).where(condition).limit(1);
    return toPayload(rows[0]);
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number = DEFAULT_TTL_SEC): Promise<void> {
    const { jti: _secret, ...withoutSecret } = payload;
    const columns = {
      payload: (this.secretIds ? withoutSecret : payload) as Record<string, unknown>,
      grantId: payload.grantId ?? null,
      uid: payload.uid ?? null,
      userCode: payload.userCode ?? null,
      accountId: payload.accountId ?? null,
      expiresAt: Date.now() + expiresIn * 1000,
      consumedAt: null,
    };
    await this.db
      .insert(oauthStore)
      .values({ model: this.model, id: this.key(id), ...columns })
      .onConflictDoUpdate({ target: [oauthStore.model, oauthStore.id], set: columns });
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const payload = await this.first(this.where(id));
    return payload && this.secretIds ? { ...payload, jti: id } : payload;
  }

  findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.first(and(eq(oauthStore.model, this.model), eq(oauthStore.uid, uid)));
  }

  findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.first(and(eq(oauthStore.model, this.model), eq(oauthStore.userCode, userCode)));
  }

  async consume(id: string): Promise<void> {
    await this.db.update(oauthStore).set({ consumedAt: Date.now() }).where(this.where(id));
  }

  async destroy(id: string): Promise<void> {
    await this.db.delete(oauthStore).where(this.where(id));
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.db
      .delete(oauthStore)
      .where(and(eq(oauthStore.model, this.model), eq(oauthStore.grantId, grantId)));
  }
}

export class OAuthStore {
  constructor(private readonly db: Database) {}

  /** The oidc-provider `adapter` option: one adapter per model name. */
  readonly adapter = (model: string): Adapter => new ModelAdapter(this.db, model);

  /** Delete every grant of a person and every code and token issued under them. */
  async revokeAllFor(accountId: UserId): Promise<void> {
    await this.db
      .delete(oauthStore)
      .where(and(inArray(oauthStore.model, GRANT_BOUND_MODELS), eq(oauthStore.accountId, accountId)));
  }

  /** The ids and client names of a person's unexpired grants, oldest first. */
  async grantsOf(accountId: UserId): Promise<Array<{ id: string; clientName: string | null }>> {
    return this.db
      .select({ id: oauthStore.id, clientName: oauthStore.clientName })
      .from(oauthStore)
      .where(
        and(
          eq(oauthStore.model, "Grant"),
          eq(oauthStore.accountId, accountId),
          or(isNull(oauthStore.expiresAt), gt(oauthStore.expiresAt, Date.now())),
        ),
      )
      .orderBy(oauthStore.expiresAt);
  }

  /** The client name stored with a grant at consent, if the client gave one. */
  async grantName(grantId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ clientName: oauthStore.clientName })
      .from(oauthStore)
      .where(and(eq(oauthStore.model, "Grant"), eq(oauthStore.id, grantId)))
      .limit(1);
    return row?.clientName ?? null;
  }

  async nameGrant(grantId: string, clientName: string): Promise<void> {
    await this.db
      .update(oauthStore)
      .set({ clientName })
      .where(and(eq(oauthStore.model, "Grant"), eq(oauthStore.id, grantId)));
  }

  async prune(): Promise<number> {
    const result = await this.db.delete(oauthStore).where(lte(oauthStore.expiresAt, Date.now()));
    return result.rowsAffected;
  }
}
