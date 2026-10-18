/**
 * Find-My style sharing between people. Every method takes the acting user
 * first; routes reach them only through the AccountScope that binds it, so a
 * handler can name another person only as a share counterpart, and the
 * store's SQL decides whether that counterpart is a current co-member.
 *
 * Sharing with a person is separate from what the owner's agents may see
 * (`defaultAgentAccess`): the owner's privacy mode does not narrow it, and
 * the viewer's agent tokens never reach it (it is session-only).
 */

import { buildCoarseView, buildPreciseView, shouldHideExact } from "../privacy/policy.js";
import type { PresenceStore } from "../store/presenceStore.js";
import { toPresenceContext } from "../store/presenceStore.js";
import type { CoarsePresenceView, PrecisePresenceView, PresenceEvent, UserId } from "../types.js";
import type { Clock } from "../util/time.js";
import { fail, ok, type Result } from "../accounts/types.js";
import type {
  IncomingShare,
  OutgoingShare,
  Person,
  ShareGrant,
  SharesStore,
} from "./sharesStore.js";

export interface SharingStores {
  shares: SharesStore;
  presence: PresenceStore;
}

/** What a viewer sees of one person sharing with them. */
export interface PersonView {
  user: Person;
  level: IncomingShare["level"];
  /** The coarse summary, without the owner's agent privacy mode. */
  presence: Omit<CoarsePresenceView, "privacy"> | null;
  precise: PrecisePresenceView | null;
}

/** A result plus the audit events it wrote, for the route to hand to the dispatcher. */
export interface Audited<T> {
  value: T;
  events: PresenceEvent[];
}

const notFound = () => fail("not_found", "no such member in your workspaces");

export class SharingService {
  constructor(
    private readonly stores: SharingStores,
    private readonly clock: Clock,
  ) {}

  async list(me: UserId): Promise<{ outgoing: OutgoingShare[]; incoming: Array<Omit<IncomingShare, "hideHomeExact">> }> {
    const [outgoing, incoming] = await Promise.all([
      this.stores.shares.listOutgoing(me),
      this.stores.shares.listIncoming(me),
    ]);
    return { outgoing, incoming: incoming.map(({ owner, level }) => ({ owner, level })) };
  }

  /** Share my location with `viewer`, or change how. */
  async put(me: UserId, viewer: UserId, grant: ShareGrant): Promise<Result<Audited<OutgoingShare>>> {
    if (viewer === me) return fail("invalid", "you cannot share with yourself");
    const events = await this.stores.shares.put(me, viewer, grant);
    if (!events) return notFound();
    const share = (await this.stores.shares.listOutgoing(me)).find((s) => s.viewer.id === viewer);
    return share ? ok({ value: share, events }) : notFound();
  }

  async revoke(me: UserId, viewer: UserId): Promise<Result<Audited<void>>> {
    const event = await this.stores.shares.revoke(me, viewer);
    return event ? ok({ value: undefined, events: [event] }) : notFound();
  }

  /**
   * Everyone sharing with me, with what each lets me see. A precise view is
   * noted in the owner's log (at most hourly per viewer).
   */
  async people(me: UserId): Promise<Audited<PersonView[]>> {
    const incoming = await this.stores.shares.listIncoming(me);
    const views = await Promise.all(incoming.map((share) => this.view(me, share)));
    return {
      value: views.map((v) => v.person),
      events: views.flatMap((v) => (v.event ? [v.event] : [])),
    };
  }

  private async view(
    me: UserId,
    share: IncomingShare,
  ): Promise<{ person: PersonView; event: PresenceEvent | null }> {
    const stored = await this.stores.presence.getCurrent(share.owner.id);
    const person: PersonView = { user: share.owner, level: share.level, presence: null, precise: null };
    if (!stored) return { person, event: null };
    const presence = toPresenceContext(stored);
    const { privacy: _p, ...coarse } = buildCoarseView(presence, this.clock);
    person.presence = coarse;
    const homeHidden =
      share.hideHomeExact && shouldHideExact(presence, { hideHomeExactCoordinates: true });
    if (share.level !== "precise" || homeHidden) return { person, event: null };
    person.precise = buildPreciseView(presence, this.clock);
    if (!person.precise) return { person, event: null };
    return { person, event: await this.stores.shares.recordPreciseView(share.owner.id, me) };
  }
}
