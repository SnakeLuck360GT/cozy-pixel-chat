# The chat server: API, live updates and attachments. The pages in public/
# are served by Caddy (see docker-compose.yml), but they're copied in here
# too so the image works on its own behind any proxy that can do the same.
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002 \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js manage.js ./
COPY lib ./lib
COPY public ./public

# docker compose exec app chat-admin add-user me --owner
RUN printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/manage.js "$@"\n' > /usr/local/bin/chat-admin \
 && chmod 755 /usr/local/bin/chat-admin \
 && mkdir -p /data \
 && chown node:node /data

USER node
VOLUME /data
EXPOSE 3002

# Anything under 500 means it's up (/api/me is a 401 when logged out).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3002/api/me').then(r => process.exit(r.status < 500 ? 0 : 1), () => process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
