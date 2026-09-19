# ---- Build stage ----
FROM node:24-alpine AS build
WORKDIR /app

# Install all deps (incl. dev) for typecheck + tsc compile
COPY package.json bun.lock* ./
RUN npm install --no-audit --no-fund

# Compile TypeScript -> dist
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Build the chat UI (React + Vite) for serving at the gateway root path.
COPY chat/package.json chat/bun.lock* ./chat/
RUN cd chat && npm install --no-audit --no-fund
COPY chat ./chat
RUN cd chat && npm run build

# ---- Runtime stage ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only
COPY package.json bun.lock* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy compiled output, migrations, and the built chat UI
COPY --from=build /app/dist ./dist
COPY --from=build /app/chat/dist ./chat/dist
COPY drizzle ./drizzle

EXPOSE 8787

CMD ["node", "dist/src/index.js"]
