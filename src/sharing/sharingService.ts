/**
 * Find-My style sharing between people. Every method takes the acting
 * session first; routes reach them only through the AccountScope that binds
 * it, so a handler can name another person only as a share counterpart, and
 * the store's SQL decides whether that counterpart is a current co-member.
 *
 * This module loads and audits; what a viewer may see is decided by
 * `buildPersonView` (../privacy/policy.ts). Sharing with a person is separate
 * from what the owner's agents may see: `defaultAgentAccess` does not narrow
 * it, `sharingPaused` does, and the viewer's agent tokens never reach it
 * (it is session-only).
 */

import { fail, hasFreshAuth, ok, type Actor, type Result } from "../accounts/types.js";
import { buildPersonView, type PersonView } from "../privacy/policy.js";
import type { SettingsStore } from "../privacy/settingsStore.js";
import type { ShareLevel, UserId } from "../types.js";
import type { Clock } from "../util/time.js";
import type {
  IncomingShare,
  OutgoingShare,
  Person,
  ShareAuditEntry,
  ShareGrant,
  SharesStore,
  VisibleShare,
} from "./sharesStore.js";

export interface SharingStores {
  shares: SharesStore;
  settings: SettingsStore;
}

/** One person in full, coordinates included when the share allows them. */
export type PersonDetail = { user: Person; level: ShareLevel } & PersonView;

type WithoutCoordinates<T> = T extends unknown
  ? Omit<T, "precise"> & {
      /** "available" when GET /v1/people/:id would show coordinates now. */
      precise: "available" | null;
    }
  : never;

/** A person who shares with me, as the people list shows them. */
export type PersonSummary = WithoutCoordinates<PersonDetail>;

const notFound = () => fail("not_found", "no such member in your workspaces");

export class SharingService {
  constructor(
    private readonly stores: SharingStores,
    private readonly clock: Clock,
    /** STALE_AFTER_SEC, how recent a report must be to count as live. */
    private readonly liveWithinSec: number,
  ) {}

  async list(me: Actor): Promise<{ outgoing: OutgoingShare[]; incoming: IncomingShare[] }> {
    const [outgoing, incoming] = await Promise.all([
      this.stores.shares.listOutgoing(me.userId),
      this.stores.shares.listIncoming(me.userId),
    ]);
    return { outgoing, incoming };
  }

  /**
   * Share my location with `viewer`, or change how. Creating a share, raising
   * it to precise, or unhiding home needs a fresh passkey proof; keeping or
   * lowering it does not. A new share's hideHomeExact defaults to my
   * hideHomeExactCoordinates setting.
   */
  async put(me: Actor, viewer: UserId, grant: ShareGrant): Promise<Result<OutgoingShare>> {
    if (viewer === me.userId) return fail("invalid", "you cannot share with yourself");
    const settings = await this.stores.settings.getOrSeed(me.userId);
    const outcome = await this.stores.shares.put(me.userId, viewer, grant, {
      mayWiden: hasFreshAuth(me.reauthAt, this.clock()),
      defaultHideHomeExact: settings.hideHomeExactCoordinates,
      defaultShowArea: settings.areaToPeople,
    });
    if (outcome === "reauth_required") {
      return fail(
        "reauth_required",
        "sharing more needs your passkey first (POST /v1/me/reauth)",
      );
    }
    if (outcome === "not_found") return notFound();
    const share = (await this.stores.shares.listOutgoing(me.userId)).find((s) => s.viewer.id === viewer);
    return share ? ok(share) : notFound();
  }

  async revoke(me: Actor, viewer: UserId): Promise<Result<void>> {
    return (await this.stores.shares.revoke(me.userId, viewer, null)) ? ok(undefined) : notFound();
  }

  /** Stop seeing `owner`: the viewer's side of ending a share. */
  async decline(me: Actor, owner: UserId): Promise<Result<void>> {
    return (await this.stores.shares.revoke(owner, me.userId, "viewer_declined"))
      ? ok(undefined)
      : notFound();
  }

  /** Everyone sharing with me, without coordinates; nothing is audited. */
  async people(me: Actor): Promise<PersonSummary[]> {
    const visible = await this.stores.shares.visibleTo(me.userId);
    return visible.map((v) => {
      const { precise, ...view } = this.view(v);
      return { ...view, precise: precise ? ("available" as const) : null };
    });
  }

  /**
   * One person sharing with me. Showing their coordinates is audited in
   * their log (at most hourly per viewer) before the response goes out.
   */
  async person(me: Actor, owner: UserId): Promise<Result<PersonDetail>> {
    const [visible] = await this.stores.shares.visibleTo(me.userId, owner);
    if (!visible) return notFound();
    const detail = this.view(visible);
    if (detail.precise) await this.stores.shares.recordPreciseView(owner, me.userId);
    return ok(detail);
  }

  async audit(me: Actor, limit: number): Promise<ShareAuditEntry[]> {
    return this.stores.shares.listAudit(me.userId, limit);
  }

  private view({ owner, share, ownerContext, presence }: VisibleShare): PersonDetail {
    return {
      user: owner,
      level: share.level,
      ...buildPersonView(presence, share, ownerContext, this.clock, this.liveWithinSec),
    };
  }
}
