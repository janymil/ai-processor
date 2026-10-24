FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Production dependencies only (tsx is a runtime dependency). Reproducible: npm ci, not install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=root:root tsconfig.json ./
COPY --chown=root:root *.ts ./

# Never run as root: the "node" user ships with the base image.
USER node

EXPOSE 8080

# Liveness only. /health is open and answers { status, service, authConfigured }.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node_modules/.bin/tsx", "index.ts"]
