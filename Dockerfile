# Dockerfile — Store Intelligence API

# ──────────────────────────────────────────────────────────────
# Stage 1: Install dependencies
# ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

# ──────────────────────────────────────────────────────────────
# Stage 2: Runtime image
# ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=deps /app/node_modules ./node_modules

COPY app/ ./app/
COPY dashboard/ ./dashboard/
COPY data/ ./data/
COPY package.json ./

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV LOG_LEVEL=info

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "app/index.js"]
