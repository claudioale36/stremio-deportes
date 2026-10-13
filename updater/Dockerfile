# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — stremio-deportes-updater
# Servicio liviano que extrae URLs .m3u8 frescas desde la IP del hogar
# y hace push a GitHub cada 3 horas via SSH.
# El repositorio se monta como volumen — el contenedor no clona nada.
#
# Operaciones de red en el build (mínimas):
#   1. apk add  → git + openssh desde mirrors Alpine
#   2. npm ci   → simple-git desde npm (usa package-lock.json, sin resolver deps)
# ─────────────────────────────────────────────────────────────────────────────

FROM node:18-alpine

# git + openssh: requeridos por simple-git para el push a GitHub
RUN apk add --no-cache git openssh-client

WORKDIR /app/updater

# Copiar lockfile antes que el código — si no cambia, Docker reutiliza esta capa
# Requiere package-lock.json generado localmente con: npm install --production
COPY package.json package-lock.json ./

# npm ci: instala exactamente lo que dice el lockfile, sin resolver nada
# Mucho más rápido que npm install y reproducible
RUN npm ci --omit=dev

# Código y config (estas capas cambian seguido, van al final para aprovechar caché)
COPY updater.js .
COPY extractor-config.json .

ENV REPO_PATH=/app/repo
ENV STREAMS_JSON_PATH=/app/repo/streams.json
ENV EXTRACTOR_CONFIG_PATH=/app/updater/extractor-config.json
ENV UPDATE_INTERVAL_HOURS=3
ENV MAX_TOKEN_AGE_HOURS=3

CMD ["node", "updater.js"]
