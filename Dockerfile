# ---- Build stage ----
FROM node:24-alpine AS build
WORKDIR /app

# Install all deps for typecheck/build tooling
COPY package.json bun.lock* ./
RUN npm install --no-audit --no-fund

# ---- Runtime stage ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install production dependencies only
COPY package.json bun.lock* ./
RUN npm install --omit=dev --no-audit --no-fund

# Install tsx globally to execute TypeScript directly
RUN npm install -g tsx

# Copy application source and migrations
COPY src ./src
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY tsconfig.json ./tsconfig.json

EXPOSE 8787

CMD ["npm", "run", "start"]
