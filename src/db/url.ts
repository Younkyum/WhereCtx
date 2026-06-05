/**
 * Single source of truth for DATABASE_URL normalization.
 *
 * Imported by both src/config.ts (runtime) and drizzle.config.ts (drizzle-kit)
 * so the migration tooling and the running server can never target different
 * database files for the same env value. Dependency-free on purpose.
 *
 * Normalizes into a libsql connection URL. Examples:
 *   :memory: / file::memory: / sqlite::memory:  -> :memory:
 *   file:./data/wherectx.db                     -> file:./data/wherectx.db
 *   sqlite:////data/wherectx.db   (4 slashes)   -> file:/data/wherectx.db   (absolute)
 *   sqlite:///wherectx.db         (3 slashes)   -> file:wherectx.db         (relative)
 *   sqlite://./data/wherectx.db                 -> file:./data/wherectx.db  (relative)
 *   /data/wherectx.db                           -> file:/data/wherectx.db
 *   libsql:// / http(s):// / ws(s)://           -> passed through (remote turso)
 */
export function normalizeDatabaseUrl(raw: string): string {
  const value = raw.trim();

  // In-memory database: short-circuit so it is never mangled into a named file.
  if (value === ":memory:" || value === "file::memory:" || value === "sqlite::memory:") {
    return ":memory:";
  }

  if (value.startsWith("file:")) return value;

  if (
    value.startsWith("libsql:") ||
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("ws://") ||
    value.startsWith("wss://")
  ) {
    return value;
  }

  if (value.startsWith("sqlite:")) {
    let rest = value.slice("sqlite:".length);
    if (rest === ":memory:") return ":memory:";
    // SQLAlchemy-style slash convention:
    //   sqlite:///rel.db   (3 slashes) -> relative `rel.db`
    //   sqlite:////abs.db  (4 slashes) -> absolute `/abs.db`
    //   sqlite://./rel.db  (authority + ./) -> relative `./rel.db`
    const m = rest.match(/^\/+/);
    if (m) {
      const n = m[0].length;
      const prefix = n >= 4 ? "/" : "";
      rest = prefix + rest.slice(n);
    }
    return `file:${rest}`;
  }

  // Bare filesystem path.
  return `file:${value}`;
}
