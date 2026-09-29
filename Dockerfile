# Hex-World server in a container. The hooks still run on your machine (Claude Code runs them there);
# they POST to 127.0.0.1:8787, which compose publishes to this container. See README → "Docker".
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
COPY config ./config
COPY public ./public
COPY server ./server
ENV HEX_WORLD_DOCKER=1 HEX_WORLD_HOST=0.0.0.0 HEX_WORLD_STATE_FILE=/data/worlds.json
USER node
EXPOSE 8787
CMD ["node", "server/server.mjs"]
