# Nippes Nights: game server and built client in one image, one port.
#   npm run pipeline                      (once: creates apps/client/public/world, ~350 MB, not in the repository)
#   docker build -f apps/server/Dockerfile -t nippes-nights .     (context: the repository root)
#   docker run -p 127.0.0.1:2567:2567 -e MAX_PLAYERS=60 nippes-nights
#
# WORLD_FILES=full (default): the image serves the whole world under /world/ itself.
# WORLD_FILES=server: the image keeps only the files the server loads (SERVER_WORLD_FILES in @nn/shared); browsers load
#   the world from object storage (WORLD_URL, published with `npm run world:publish`). Much smaller image.
#   docker build -f apps/server/Dockerfile --build-arg WORLD_FILES=server -t nippes-nights .

# ---- build: client bundle (with the world), pre-compressed ----
FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG WORLD_FILES=full
RUN case "$WORLD_FILES" in full|server) ;; *) \
      echo "ERROR: WORLD_FILES must be 'full' or 'server', not '$WORLD_FILES'." >&2; exit 1;; \
    esac

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/pipeline/package.json packages/pipeline/
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
RUN npm ci

# The world is generated, not versioned; fail early with a clear message.
COPY apps/client/public/ ./apps/client/public/
RUN for f in index.json manifest.json collision.bin terrain.bin; do \
      test -f "apps/client/public/world/$f" || { \
        if [ "$f" = index.json ] && [ -f apps/client/public/world/manifest.json ]; then \
          echo "ERROR: apps/client/public/world/index.json is missing in the build context. Run 'npm run world:index' in the repository root first." >&2; \
        else \
          echo "ERROR: apps/client/public/world/$f is missing in the build context. Run 'npm run pipeline' in the repository root first (and do not exclude the folder in .dockerignore)." >&2; \
        fi; \
        exit 1; }; \
    done

COPY packages ./packages
COPY apps ./apps
COPY scripts ./scripts
# Brotli/gzip variants of earlier builds (CI fills it on the runner for the full image, see
# .github/workflows/docker-image.yml; otherwise empty, but it must exist: `mkdir -p .precompress-cache`): unchanged
# world files are not compressed again.
COPY .precompress-cache/ /precompress-cache/
# `npm run build` in its two steps: with WORLD_FILES=server everything but the server's world files is removed from the
# bundle between the client build and the compression, so nothing is compressed that the image does not keep.
RUN npm run build -w @nn/client
RUN if [ "$WORLD_FILES" = server ]; then \
      cd apps/server && node --import tsx -e " \
        import('@nn/shared').then(async ({ SERVER_WORLD_FILES }) => { \
          const { readdir, rm } = await import('node:fs/promises'); \
          const dir = '../client/dist/world'; \
          for (const f of await readdir(dir)) \
            if (!SERVER_WORLD_FILES.includes(f)) await rm(dir + '/' + f, { recursive: true }); \
        })"; \
    fi
RUN NN_PRECOMPRESS_CACHE=/precompress-cache node scripts/precompress.mjs

# ---- runtime: server (tsx) + built client ----
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=2567

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/pipeline/package.json packages/pipeline/
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev -w @nn/server -w @nn/shared && npm cache clean --force

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY --from=build /app/apps/client/dist apps/client/dist

USER node
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# node itself is PID 1 (no npm/sh in between), so SIGTERM from `docker stop` reaches the server
WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/main.ts"]
