FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
# Reproducible install from the lockfile, runtime dependencies only.
RUN npm ci --omit=dev
COPY . .
# Run unprivileged. /app/uploads is shared with the AI service through a volume (both run as uid 1000).
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4000}/health >/dev/null || exit 1
CMD ["node", "index.js"]
