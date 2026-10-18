import type { UserScope } from "../app/context.js";
import type { Principal } from "../auth/principal.js";

/**
 * Hono environment, filled by bearerAuth: the principal for scope checks and
 * the user scope every handler reads and writes through.
 */
export type AppEnv = {
  Variables: {
    principal: Principal;
    scope: UserScope;
  };
};
