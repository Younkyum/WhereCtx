import type { AccountScope, UserScope } from "../app/context.js";
import type { Principal } from "../auth/principal.js";

/**
 * Hono environment, filled by `authenticate`: the principal for scope checks
 * and the user scope every handler reads and writes through.
 */
export type AppEnv = {
  Variables: {
    principal: Principal;
    scope: UserScope;
  };
};

/**
 * Environment of routes behind `sessionAuth`: the signed-in person's account
 * scope, the only thing those handlers act through.
 */
export type SessionEnv = {
  Variables: {
    account: AccountScope;
  };
};
