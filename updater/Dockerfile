# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — stremio-deportes-updater
# Servicio liviano que extrae URLs .m3u8 frescas desde la IP del hogar
# y hace push a GitHub cada 3 horas via SSH.
# El repositorio se monta como volumen — el contenedor no clona nada.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:18-alpine

# Instalar git (requerido por simple-git para hacer push)
RUN apk add --no-cache git openssh-client

WORKDIR /app/updater

# Instalar solo dependencias de producción
COPY package.json .
RUN npm install --production --silent

# Copiar el script y la config de extractores
COPY updater.js .
COPY extractor-config.json .

# Variables de entorno con defaults — sobreescribibles en docker-compose.yml
ENV REPO_PATH=/app/repo
ENV STREAMS_JSON_PATH=/app/repo/add-on/streams.json
ENV EXTRACTOR_CONFIG_PATH=/app/updater/extractor-config.json
ENV UPDATE_INTERVAL_HOURS=3
ENV MAX_TOKEN_AGE_HOURS=3

CMD ["node", "updater.js"]
