FROM node:22-bookworm-slim AS base

# Install security updates
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r agentgate && useradd -r -g agentgate -m agentgate

WORKDIR /app

# Copy dependency files first for layer caching
COPY package.json package-lock.json ./

# Install production deps only
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY src/ src/
COPY public/ public/
COPY docs/ docs/

# Data directory for SQLite DB + avatars — mount a volume here
RUN mkdir -p /data && chown agentgate:agentgate /data
VOLUME /data
ENV AGENTGATE_DATA_DIR=/data

# Default port
EXPOSE 3000

# Switch to non-root
USER agentgate

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/readme').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
