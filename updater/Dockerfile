# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — stremio-deportes-updater
# Servicio liviano que extrae URLs .m3u8 frescas desde la IP del hogar
# y hace push a GitHub cada 3 horas via SSH.
# El repositorio se monta como volumen — el contenedor no clona nada.
#
# Usa pnpm para instalar dependencias:
#   - corepack (incluido en node:18-alpine) habilita pnpm sin instalación extra
#   - pnpm install --frozen-lockfile garantiza reproducibilidad total
#   - La capa de deps se cachea si pnpm-lock.yaml no cambió
# ─────────────────────────────────────────────────────────────────────────────

FROM node:18-alpine

# Habilitar pnpm via corepack (viene incluido en Node 18+, sin descarga extra)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Instalar git y openssh (requeridos por simple-git para hacer push)
RUN apk add --no-cache git openssh-client

WORKDIR /app/updater

# Copiar solo los archivos de dependencias primero.
# Si pnpm-lock.yaml no cambia entre builds, Docker reutiliza esta capa (caché).
COPY package.json pnpm-lock.yaml ./

# --frozen-lockfile: falla si el lockfile no está sincronizado (equivale a npm ci)
# --prod: solo dependencias de producción, sin devDeps
RUN pnpm install --frozen-lockfile --prod

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
