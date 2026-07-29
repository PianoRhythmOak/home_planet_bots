# ---- build stage -------------------------------------------------------------
FROM node:22-bookworm-slim AS build

# better-sqlite3 ships prebuilt binaries for most platforms, but falls back to
# compiling from source — these are what it needs when it does.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we're going to copy forward.
RUN npm prune --omit=dev

# ---- runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

# The SQLite file lives here. Mount a volume so tickets survive a redeploy:
#   docker run -v homeplanet-data:/app/data ...
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

# config.json and .env are NOT baked into the image — mount or inject them:
#   docker run --env-file .env -v $(pwd)/config.json:/app/config.json:ro ...
USER node

CMD ["node", "dist/index.js"]
