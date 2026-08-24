# ── Stage 1: Build frontend ───────────────────────────────────────────────────
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
# vite.config.ts outDir is ../backend/public → lands at /app/backend/public

# ── Stage 2: Build backend ────────────────────────────────────────────────────
FROM node:22-alpine AS backend-builder
# python3/make/g++ are required to compile better-sqlite3 native addon
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package.json ./
RUN npm install
COPY backend/ ./
RUN npm run build
# Prune dev dependencies so we only ship what's needed at runtime
RUN npm prune --omit=dev

# ── Stage 3: Final image ──────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

# Copy compiled backend + production node_modules (includes native .node files)
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=backend-builder /app/backend/node_modules ./node_modules
COPY --from=backend-builder /app/backend/package.json ./

# Copy built frontend
COPY --from=frontend-builder /app/backend/public ./public

RUN mkdir -p /data/uploads

EXPOSE 8080
VOLUME ["/data"]

ENV PORT=8080 \
    DB_PATH=/data/vtt.db \
    UPLOADS_DIR=/data/uploads \
    STATIC_DIR=/app/public

CMD ["node", "dist/index.js"]
