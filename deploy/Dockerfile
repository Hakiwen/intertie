# The Intertie Slack host (multi-workspace) or any single adapter. Zero runtime dependencies.
#   docker build -f deploy/Dockerfile -t intertie .
#   docker run -p 8700:8700 --env-file host.env -v intertie-state:/state intertie
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts && rm -rf packages/*/test
ENV INTERTIE_STATE_DIR=/state INTERTIE_LISTEN_HOST=0.0.0.0 INTERTIE_PORT=8700 NODE_ENV=production
USER node
VOLUME ["/state"]
EXPOSE 8700
CMD ["node", "packages/slack-adapter/src/cli.ts", "host"]
