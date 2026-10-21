FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS web
# Mini app bundle. It type-checks against the server's wire contract, so those two files come
# along; the layout under /app mirrors the repository, so the relative import resolves unchanged.
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src/core/types.ts /app/src/core/types.ts
COPY src/webapp/contract.ts /app/src/webapp/contract.ts
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/src ./src
RUN npm run build

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 WEBAPP_DIR=/app/web/dist \
    NODE_EXTRA_CA_CERTS=/app/certs/russian_trusted_root_ca.pem
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=web --chown=node:node /app/web/dist ./web/dist
COPY --chown=node:node package.json ./
COPY --chown=node:node src/data/rules ./src/data/rules
COPY --chown=node:node src/data/universities ./src/data/universities
COPY --chown=node:node src/data/i18n ./src/data/i18n
COPY --chown=node:node src/data/fonts ./src/data/fonts
# platform-api2.max.ru is issued by Russian Trusted Root CA (Минцифры), absent from Node's store
COPY --chown=node:node certs/russian_trusted_root_ca.pem /app/certs/russian_trusted_root_ca.pem
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
