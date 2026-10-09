FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY agent/package.json agent/
COPY tui/package.json tui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter . --filter @rebuno/uber-agent
COPY tsconfig.json ./
COPY agent agent
RUN pnpm --filter @rebuno/uber-agent build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @rebuno/uber-agent deploy --prod /out

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git ripgrep && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out .
RUN mkdir /config
ENV UBER_CONFIG_DIR=/config WORKSPACE_DIR=/workspace
EXPOSE 5000
CMD ["node", "dist/main.js"]
