# Fixed controller-owned Dockerfile, never loaded from the PR.
ARG HARNESS_IMAGE
FROM ${HARNESS_IMAGE}
USER root
COPY source.tar /tmp/source.tar
RUN mkdir /app && tar -xf /tmp/source.tar -C /app --strip-components=1 \
    && rm /tmp/source.tar \
    && cp -a /work/node_modules /app/node_modules \
    && cp -a /work/auth-worker/node_modules /app/auth-worker/node_modules \
    && cp -a /work/sync-worker/node_modules /app/sync-worker/node_modules \
    && cp /work/scripts/e2e-up.ts /app/scripts/e2e-up.ts \
    && chown -R node:node /app
USER node
WORKDIR /app
# Install scripts run only inside this credential-free build container.
RUN pnpm install --frozen-lockfile \
    && pnpm --dir auth-worker install --frozen-lockfile \
    && pnpm --dir sync-worker install --frozen-lockfile
ENV CI=1 E2E_SERVE_ONLY=1 \
    E2E_PG_ADMIN_URL=postgresql://aquilla:aquilla@localhost:5432/postgres
CMD ["pnpm", "exec", "tsx", "scripts/e2e-up.ts"]
