# syntax=docker/dockerfile:1

# ---- builder: install everything, build web + server, then prune to prod ----
FROM node:22-bookworm-slim AS builder
# CI=true lets pnpm purge node_modules for the prod re-resolve without a TTY prompt.
ENV CI=true
RUN corepack enable
WORKDIR /app

# Install deps first (cached until a manifest or the lockfile changes).
# The server's postinstall (fetch-scrcpy-server) downloads scrcpy-server.jar,
# so this layer needs network — available during `docker build`.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile

# Build the web bundle (Vite) and the server bundle (tsup).
COPY . .
RUN pnpm build

# Re-resolve to production dependencies only. This drops Vite/tsup/esbuild and
# re-runs the postinstall, so scrcpy-server.jar is guaranteed present.
RUN pnpm install --prod --frozen-lockfile

# ---- runtime: Node + adb, running the built bundle ----
FROM node:22-bookworm-slim AS runtime

# adb talks to devices over wireless adb; tini reaps the adb daemon and any
# scrcpy child processes so the container exits cleanly. Debian's `adb` package
# (main, Apache-2.0) ships for both amd64 and arm64 — Google's platform-tools
# zip is amd64-only, so it would break arm64 images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends adb tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    SPEEDCRCPY_DATA_DIR=/data \
    SPEEDCRCPY_HOST=0.0.0.0 \
    SPEEDCRCPY_PORT=8000

WORKDIR /app
COPY --from=builder /app ./
RUN mkdir -p /data

# /data     — password, HMAC secret, known-device list (persist this)
# /root/.android — adb keys, so device authorization survives restarts
VOLUME ["/data", "/root/.android"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.SPEEDCRCPY_PORT||8000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
