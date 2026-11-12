# Zero-dependency: no npm install, no build step. Shares node:22-alpine with the
# rest of the SBWK stack, so it adds no extra base-image pull (vs ~200MB httpbin).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY server.mjs ./
EXPOSE 8000
USER node
CMD ["node", "server.mjs"]
