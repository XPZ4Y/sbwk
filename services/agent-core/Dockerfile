# Zero-dependency: no npm install, no build step.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY *.mjs ./
EXPOSE 4200
USER node
CMD ["node", "server.mjs"]
