# Zero-dependency: no npm install, no build step.
FROM node:22-alpine
# su-exec lets the entrypoint start as root, fix DATA_DIR ownership, then drop
# privileges to the same unprivileged user the image would otherwise use.
RUN apk add --no-cache su-exec
WORKDIR /app
ENV NODE_ENV=production
COPY *.mjs ./
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 4300
# Deliberately NO `USER node`: the entrypoint needs root once to chown the
# mounted volume, then immediately execs as `node`. Running this container as an
# arbitrary uid (compose `user:`) is still supported — the entrypoint just skips
# the chown and the store reports the remedy if the dir is unwritable.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
