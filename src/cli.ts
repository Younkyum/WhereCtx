/**
 * Operator commands, run on the server host against the configured database.
 *
 *   node dist/cli.js reset-access <userId>     (or: npm run reset-access -- <userId>)
 *
 * reset-access is the break-glass for a person locked out of their account
 * (no passkey, no recovery code), and the way a user migrated from before
 * accounts, other than USER_ID, claims their account. It prints a one-time
 * access code, valid for an hour, that registers a new passkey for that user
 * through POST /v1/auth/access-code/options|verify. Redeeming it signs out the
 * user's other sessions and issues new recovery codes. Only someone with shell
 * access to the server can run it, the same trust as reading the setup code.
 */

import { loadConfig } from "./config.js";
import { createDb, ensureSchema } from "./db/index.js";
import { AccessCodesStore } from "./accounts/accessCodesStore.js";
import { PasskeysStore } from "./accounts/passkeysStore.js";
import { UsersStore } from "./accounts/usersStore.js";
import { asUserId } from "./types.js";

const USAGE = "usage: wherectx-admin reset-access <userId>";

async function resetAccess(rawUserId: string | undefined): Promise<number> {
  if (!rawUserId) {
    console.error(USAGE);
    return 2;
  }
  const config = loadConfig();
  const handle = createDb(config.databaseUrl);
  try {
    await ensureSchema(handle);
    const userId = asUserId(rawUserId);
    if (!(await new UsersStore(handle.db).get(userId))) {
      console.error(`no user with id "${userId}"`);
      return 1;
    }
    const codes = new AccessCodesStore(handle.db, new PasskeysStore(handle.db));
    const { code, expiresAt } = await codes.issue(userId);
    console.log(
      `One-time access code for "${userId}" (valid until ${expiresAt}):\n\n    ${code}\n\n` +
        "Give it to that person only. It registers a new passkey through\n" +
        "POST /v1/auth/access-code/options and /verify, signs out their other\n" +
        "sessions, and issues new recovery codes.",
    );
    return 0;
  } finally {
    handle.client.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === "reset-access") return resetAccess(args[0]);
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error("fatal:", err);
    process.exit(1);
  },
);
