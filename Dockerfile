# syntax=docker/dockerfile:1

FROM node:22.19.0-bookworm-slim AS build

ARG AUTH_PROVIDER=workos
ARG VITE_OAO_API_MODE=http
ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
ENV AUTH_PROVIDER=${AUTH_PROVIDER}
ENV VITE_OAO_API_MODE=${VITE_OAO_API_MODE}

WORKDIR /app

RUN corepack enable && corepack install --global pnpm@10.27.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc ./
RUN pnpm fetch --frozen-lockfile

COPY . .
RUN pnpm install --offline --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @oao/api --prod deploy --legacy /opt/oao-api \
 && pnpm --filter @oao/runtime-worker --prod deploy --legacy /opt/oao-runtime-worker

FROM node:22.19.0-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /opt/oao-api /app/apps/api
COPY --from=build --chown=node:node /opt/oao-runtime-worker /app/apps/runtime-worker
COPY --from=build --chown=node:node /app/apps/console/dist /app/apps/console/dist
COPY --from=build --chown=node:node /app/docker-entrypoint.sh /app/docker-entrypoint.sh

RUN chmod 0555 /app/docker-entrypoint.sh

USER node

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["api"]
