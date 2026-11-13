# Zero-dependency: no npm install, no build step.
FROM node:22-alpine
# su-exec lets the entrypoint fix DATA_DIR ownership as root, then drop to `node`
# (the agent-core-data volume is created root:root, like every named volume).
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY *.mjs ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 4200
# No `USER node` on purpose: the entrypoint needs root once to chown the mount,
# then immediately execs as `node`.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
