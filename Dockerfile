# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json server.mjs ./
COPY public ./public
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5173

RUN apk add --no-cache curl

COPY --from=build --chown=node:node /app/server.mjs ./server.mjs
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 5173

CMD ["node", "server.mjs"]
