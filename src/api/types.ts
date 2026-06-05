import type { VerifiedToken } from "../auth/tokens.js";

/** Hono environment: the authenticated token is attached by bearerAuth. */
export type AppEnv = {
  Variables: {
    token: VerifiedToken;
  };
};
