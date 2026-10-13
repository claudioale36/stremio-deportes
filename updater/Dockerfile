# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — stremio-deportes-updater
# Servicio liviano que extrae URLs .m3u8 frescas desde la IP del hogar
# y hace push a GitHub cada 3 horas via SSH.
# El repositorio se monta como volumen — el contenedor no clona nada.
#
# Usa node:18-slim (Debian) en lugar de Alpine porque los mirrors de Alpine
# son inaccesibles desde la red del servidor.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:18-slim

# git + openssh: requeridos por simple-git para el push a GitHub
# apt-get tiene mirrors Debian ampliamente disponibles
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/updater

# Copiar lockfile antes que el código — si no cambia, Docker reutiliza esta capa
COPY package.json package-lock.json ./

# npm ci: instala exactamente lo que dice el lockfile, sin resolver nada
RUN npm ci --omit=dev

# Código y config (capas que cambian seguido — van al final para aprovechar caché)
COPY updater.js .
COPY extractor-config.json .

ENV REPO_PATH=/app/repo
ENV STREAMS_JSON_PATH=/app/repo/streams.json
ENV EXTRACTOR_CONFIG_PATH=/app/updater/extractor-config.json
ENV UPDATE_INTERVAL_HOURS=3
ENV MAX_TOKEN_AGE_HOURS=3

CMD ["node", "updater.js"]
