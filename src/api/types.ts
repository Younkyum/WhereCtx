import type { AccountScope, UserScope } from "../app/context.js";
import type { Principal } from "../auth/principal.js";
import type { IngestVerdict } from "../activity/types.js";
import type { AccessNote } from "./accessAudit.js";

/**
 * Hono environment, filled by `authenticate`: the principal for scope checks
 * and the user scope every handler reads and writes through.
 */
export type AppEnv = {
  Variables: {
    principal: Principal;
    scope: UserScope;
    /** The request's access decision so far (api/accessAudit.ts `decide`). */
    access?: AccessNote;
    /** Set by an ingest handler whose response alone does not tell (OwnTracks always answers 200). */
    ingestVerdict?: IngestVerdict;
  };
};

/**
 * Environment of routes behind `sessionAuth`: the signed-in person's account
 * scope, the only thing those handlers act through.
 */
export type SessionEnv = {
  Variables: {
    account: AccountScope;
    /** Set for the access log, which records a token refused here. */
    principal?: Principal;
    access?: AccessNote;
  };
};
