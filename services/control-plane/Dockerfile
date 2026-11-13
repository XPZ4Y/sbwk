# Zero-dependency: no npm install, no build step.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY *.mjs ./
COPY public ./public
RUN mkdir -p /data && chown node:node /data
EXPOSE 4300
USER node
CMD ["node", "server.mjs"]
