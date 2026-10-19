/**
 * What a webhook delivery looks like on the wire: the body built from a
 * presence event and the header names. The dispatcher sends exactly this, and
 * the dashboard renders its example from the same functions. Pure, no Node
 * APIs, so the dashboard can import it.
 */

import type { PresenceEvent, PresenceEventType } from "../types.js";

export const WEBHOOK_HEADERS = {
  event: "x-wherectx-event",
  timestamp: "x-wherectx-timestamp",
  signature: "x-wherectx-signature",
} as const;

export const WEBHOOK_USER_AGENT = "wherectx/0.1";

/** The JSON body for one event. No coordinates: events carry none. */
export function eventPayload(ev: PresenceEvent): Record<string, unknown> {
  return {
    id: ev.id,
    event: ev.type,
    place: ev.placeName,
    status: ev.status,
    source: ev.source,
    timestamp: ev.createdAt,
  };
}

const EXAMPLE_EVENTS: Record<PresenceEventType, Omit<PresenceEvent, "id" | "type" | "createdAt">> = {
  "presence.updated": { status: "away", source: "owntracks" },
  "presence.entered_place": { placeName: "home", status: "home", source: "owntracks" },
  "presence.left_place": { placeName: "home", status: "away", source: "owntracks" },
  "presence.became_stale": { status: "home", source: "owntracks" },
  "presence.privacy_changed": { status: "home" },
};

/** An illustrative delivery of `type`, as the dispatcher would send it. */
export function exampleDelivery(
  type: PresenceEventType,
  signed: boolean,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  const body = eventPayload({
    id: "3f9c2a7e5b1d4c6a8e0f2b4d6a8c0e1f",
    type,
    createdAt: "2026-10-18T09:30:00.000Z",
    ...EXAMPLE_EVENTS[type],
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_HEADERS.event]: type,
    "user-agent": WEBHOOK_USER_AGENT,
  };
  if (signed) {
    headers[WEBHOOK_HEADERS.timestamp] = "1792315800";
    headers[WEBHOOK_HEADERS.signature] = "sha256=<hex HMAC of timestamp.body>";
  }
  return { headers, body };
}
