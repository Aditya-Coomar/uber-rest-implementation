# syntax = docker/dockerfile:1
# Optional container image. The demo itself runs these services directly with Node.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package*.json ./
USER node
# Inside a container, bind to all interfaces and publish the port to localhost only.
ENV BIND_HOST=0.0.0.0
CMD ["node", "dist/server.js"]
