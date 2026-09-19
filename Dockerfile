# syntax=docker/dockerfile:1

# ---- Build stage ----
FROM oven/bun:1.4-alpine AS build
WORKDIR /app

# Gateway: install deps first (cached unless package.json / bun.lock change)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Compile TypeScript -> dist (cached unless src/ changes)
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN bun run build

# Chat UI: install deps first (cached unless chat/package.json / chat/bun.lock change)
COPY chat/package.json chat/bun.lock ./chat/
RUN cd chat && bun install --frozen-lockfile

# Build the chat UI (React + Vite) for serving at the gateway root path.
# .dockerignore excludes chat/node_modules + chat/dist so the cache layer above survives.
COPY chat ./chat
RUN cd chat && bun run build

# ---- Runtime stage ----
FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only
COPY package.json bun.lock ./
RUN bun install --omit=dev --frozen-lockfile

# Copy compiled output, migrations, and the built chat UI
COPY --from=build /app/dist ./dist
COPY --from=build /app/chat/dist ./chat/dist
COPY drizzle ./drizzle

# Run as a non-root user
USER bun

EXPOSE 8787

CMD ["bun", "dist/src/index.js"]
