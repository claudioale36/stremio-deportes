# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — stremio-deportes-updater
# Servicio liviano que extrae URLs .m3u8 frescas desde la IP del hogar
# y hace push a GitHub cada 3 horas via SSH.
# El repositorio se monta como volumen — el contenedor no clona nada.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:18-alpine

# Instalar git y openssh (requeridos por simple-git para hacer push)
# Se combinan en un solo RUN para reducir capas
RUN apk add --no-cache git openssh-client

WORKDIR /app/updater

# Copiar lockfile primero — si no cambió, npm ci usa el caché de capas Docker
# y el build tarda segundos en vez de minutos.
# Si no tenés package-lock.json: corré `npm install --production` en tu máquina
# y commitea el lockfile antes de buildear.
COPY package.json package-lock.json ./

# npm ci usa el lockfile: más rápido, reproducible y sin resolver deps desde cero.
# --omit=dev equivale a --production (sintaxis moderna de npm).
# Se setea el registry explícito y un timeout razonable para evitar cuelgues en Alpine.
RUN pnpm ci --omit=dev \
      --registry=https://registry.pnpmjs.org/ \
      --fetch-timeout=60000 \
      --fetch-retry-mintimeout=10000 \
      --fetch-retry-maxtimeout=60000

# Copiar el script y la config de extractores
COPY updater.js .
COPY extractor-config.json .

# Variables de entorno con defaults — sobreescribibles en docker-compose.yml
ENV REPO_PATH=/app/repo
ENV STREAMS_JSON_PATH=/app/repo/streams.json
ENV EXTRACTOR_CONFIG_PATH=/app/updater/extractor-config.json
ENV UPDATE_INTERVAL_HOURS=3
ENV MAX_TOKEN_AGE_HOURS=3

CMD ["node", "updater.js"]
