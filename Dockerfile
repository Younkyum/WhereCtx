# ── build stage ────────────────────────────────────────────────────────
# Node 20 LTS (not 24): npm's install finalizer ("Exit handler") breaks on old
# NAS kernels (e.g. Synology DSM on Linux 4.4) — node:20 runs cleanly there and
# everywhere else. glibc base for broad @libsql/client prebuild compatibility.
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
# Server (tsc -> dist/) and dashboard (Vite -> dist/web/, static files only).
RUN npm run build

# ── runtime stage ──────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Only production deps.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Compiled app, the built dashboard (dist/web) and the canonical migrations
# (required at boot). React and the design system are build-time devDependencies,
# so they are not installed here.
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

# Run as a non-root user (least privilege). NOTE: with a bind mount
# (./data:/data) the host directory's owner wins, so on first run the operator
# must `chown 10001 ./data` (or use a named volume); a named volume inherits
# this ownership automatically.
RUN useradd -u 10001 -r -s /usr/sbin/nologin wherectx \
  && mkdir -p /data \
  && chown -R wherectx:wherectx /data /app
USER wherectx

ENV PORT=8787 HOST=0.0.0.0 DATABASE_URL=file:/data/wherectx.db
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
