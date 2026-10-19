/**
 * What a maps outcome tells the caller, and the access decision it means:
 * one table that the REST routes (api/geo.ts) and the MCP tools
 * (mcp/server.ts) both answer from, so the two surfaces cannot drift.
 * `status` is the REST status; a tool answers `body`, as an error when
 * `isError`.
 */

import type { AccessDecision } from "../activity/types.js";
import type { CandidateView, EtaOutcome, SearchOutcome } from "./service.js";

export interface GeoReply {
  status: 200 | 403 | 404 | 409 | 429 | 502;
  body: unknown;
  decision: AccessDecision;
  isError: boolean;
}

const RATE_LIMITED = "too many maps requests; try again in a minute";
const UNCONFIGURED = "no maps key is set up; the person can add one under Maps & routes";

const reply = (status: GeoReply["status"], body: unknown, decision: AccessDecision): GeoReply => ({
  status,
  body,
  decision,
  isError: status >= 400,
});

/** Search results numbered for `pick`. */
export function numbered(candidates: readonly CandidateView[]): Array<CandidateView & { pick: number }> {
  return candidates.map((c, i) => ({ pick: i + 1, ...c }));
}

type Shared = Extract<EtaOutcome | SearchOutcome, { kind: "hidden" | "denied" | "rate_limited" | "unconfigured" | "failed" }>;

/** The refusals and failures an ETA and a search share. */
function shared(outcome: Shared): GeoReply {
  switch (outcome.kind) {
    case "hidden":
      return reply(403, { error: "presence is hidden from agents by policy", privacy: "hidden" }, { outcome: "hidden" });
    case "denied":
      return reply(403, { error: outcome.reason }, { outcome: "denied", denial: outcome.reason });
    case "rate_limited":
      return reply(429, { error: RATE_LIMITED }, { outcome: "denied", denial: RATE_LIMITED });
    case "unconfigured":
      return reply(409, { error: UNCONFIGURED }, { outcome: "error", denial: UNCONFIGURED });
    case "failed":
      return reply(502, { error: outcome.message, kind: outcome.error }, { outcome: "error", denial: `${outcome.error}: ${outcome.message}` });
  }
}

export function etaReply(outcome: EtaOutcome): GeoReply {
  switch (outcome.kind) {
    case "ok":
      return reply(200, outcome.answer, { outcome: "allowed", ...(outcome.precise ? { precise: true } : {}) });
    case "no_location":
      return reply(404, { error: "no location recorded yet" }, { outcome: "allowed" });
    case "too_old": {
      const error = `the location is too old to time a route from (${outcome.freshness}, last report ${outcome.originAgeMin} min ago): a route needs a live reading, or a quiet phone inside a registered place`;
      return reply(409, { error, freshness: outcome.freshness, originAgeMin: outcome.originAgeMin }, { outcome: "denied", denial: error });
    }
    case "not_found":
      return reply(404, { error: outcome.reason }, { outcome: "allowed" });
    case "unsupported_mode": {
      const error = `${outcome.provider} does not route ${outcome.mode}; it routes ${outcome.supported.join(", ")}`;
      return reply(409, { error, unsupported: "mode", mode: outcome.mode, provider: outcome.provider, supported: outcome.supported }, { outcome: "error", denial: error });
    }
    case "ambiguous":
      // Answered: the caller picks one and asks again.
      return {
        ...reply(409, {
          ambiguous: true,
          error: "several places match; ask again with pick set to the number of the one meant",
          candidates: numbered(outcome.candidates),
        }, { outcome: "allowed" }),
        isError: false,
      };
    default:
      return shared(outcome);
  }
}

/** A search that did not answer with candidates. */
export function searchReply(outcome: Exclude<SearchOutcome, { kind: "ok" }>): GeoReply {
  return shared(outcome);
}
