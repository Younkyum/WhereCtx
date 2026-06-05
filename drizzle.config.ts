import { defineConfig } from "drizzle-kit";
// Extensionless import: drizzle-kit's esbuild loader resolves this to the .ts
// source. Shares the single normalizer with the runtime (src/config.ts) so
// drizzle-kit and the server never target different database files.
import { normalizeDatabaseUrl } from "./src/db/url";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: normalizeDatabaseUrl(process.env.DATABASE_URL ?? "file:./data/wherectx.db"),
  },
  strict: true,
  verbose: true,
});
