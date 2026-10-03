FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# Reproducible install from the lockfile, runtime dependencies only.
RUN npm ci --omit=dev
COPY . .
# Run unprivileged. /app/uploads is shared with the AI service through a volume (both run as uid 1000).
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 4000
CMD ["node", "index.js"]
