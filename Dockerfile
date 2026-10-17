FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm db:generate
ARG VITE_ADMIN_HOST
ENV VITE_ADMIN_HOST=$VITE_ADMIN_HOST
RUN pnpm build
# El código copiado conserva los permisos del equipo de origen; el usuario node debe poder leerlo.
RUN chmod -R a+rX /app

FROM build AS api
WORKDIR /app/apps/api
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
USER node
CMD ["pnpm", "exec", "tsx", "src/main.ts"]

FROM caddy:2-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
