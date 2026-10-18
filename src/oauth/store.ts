/**
 * Persistence for the OAuth authorization server: the oidc-provider Adapter
 * contract over the `oauth_store` table, plus the two reads WhereCtx needs
 * itself (a person's grants, for the Agents screen) and the prune sweep.
 *
 * Expiry follows the library's clock (Date.now), not the app clock: the
 * library computes every `expiresIn` against it.
 */

import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import type { Adapter, AdapterPayload } from "oidc-provider";
import type { Database } from "../db/index.js";
import { oauthStore } from "../db/schema.js";
import type { UserId } from "../types.js";

type Row = typeof oauthStore.$inferSelect;

function toPayload(row: Row | undefined): AdapterPayload | undefined {
  if (!row || (row.expiresAt !== null && row.expiresAt <= Date.now())) return undefined;
  const payload = row.payload as AdapterPayload;
  return row.consumedAt === null ? payload : { ...payload, consumed: Math.floor(row.consumedAt / 1000) };
}

class ModelAdapter implements Adapter {
  constructor(
    private readonly db: Database,
    private readonly model: string,
  ) {}

  private where(id: string) {
    return and(eq(oauthStore.model, this.model), eq(oauthStore.id, id));
  }

  private async first(condition: ReturnType<typeof and>): Promise<AdapterPayload | undefined> {
    const rows = await this.db.select().from(oauthStore).where(condition).limit(1);
    return toPayload(rows[0]);
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const columns = {
      payload: payload as Record<string, unknown>,
      grantId: payload.grantId ?? null,
      uid: payload.uid ?? null,
      userCode: payload.userCode ?? null,
      accountId: payload.accountId ?? null,
      expiresAt: expiresIn === undefined ? null : Date.now() + expiresIn * 1000,
      consumedAt: null,
    };
    await this.db
      .insert(oauthStore)
      .values({ model: this.model, id, ...columns })
      .onConflictDoUpdate({ target: [oauthStore.model, oauthStore.id], set: columns });
  }

  find(id: string): Promise<AdapterPayload | undefined> {
    return this.first(this.where(id));
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
