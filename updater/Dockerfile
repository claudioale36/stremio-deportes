# ─────────────────────────────────────────────────────────────────────────────
# Dockerfile — stremio-deportes-updater
# Servicio liviano que extrae URLs .m3u8 frescas desde la IP del hogar
# y hace push a GitHub cada 3 horas via SSH.
# El repositorio se monta como volumen — el contenedor no clona nada.
#
# Usa node:18-slim (Debian) en lugar de Alpine porque los mirrors de Alpine
# son inaccesibles desde la red del servidor.
#
# Incluye Chromium para que Puppeteer pueda ejecutar el JS de las páginas
# de streaming y capturar el token real (fetch() solo lee el HTML estático
# y obtiene un placeholder que ftlly.com rechaza con 403).
# ─────────────────────────────────────────────────────────────────────────────

FROM node:18-slim

# git + openssh: requeridos por simple-git para el push a GitHub
# chromium: browser headless para Puppeteer — ejecuta el JS que genera los tokens
# ca-certificates: necesario para que Chromium valide HTTPS correctamente
# fonts-liberation: fuentes mínimas para que Chromium no crashee en Linux headless
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      chromium \
      ca-certificates \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Git 2.35.2+ rechaza repos owned por otro usuario ("dubious ownership").
# El contenedor corre como root pero /app/repo pertenece al usuario del host.
# safe.directory en build-time evita el error «fatal: --local can only be used inside a git repository».
RUN git config --global --add safe.directory /app/repo

WORKDIR /app/updater

# Copiar lockfile antes que el código — si no cambia, Docker reutiliza esta capa
COPY package.json package-lock.json ./

# npm ci: instala exactamente lo que dice el lockfile, sin resolver nada
# puppeteer-core no descarga Chromium propio — usa el del sistema (/usr/bin/chromium)
RUN npm ci --omit=dev

# Código y config (capas que cambian seguido — van al final para aprovechar caché)
COPY updater.js .
COPY extractor-config.json .
COPY run.sh .
RUN chmod +x /app/updater/run.sh

ENV REPO_PATH=/app/repo
ENV STREAMS_JSON_PATH=/app/repo/streams.json
ENV EXTRACTOR_CONFIG_PATH=/app/updater/extractor-config.json
ENV UPDATE_INTERVAL_HOURS=3
ENV MAX_TOKEN_AGE_HOURS=3
# Ruta al binario de Chromium instalado por apt — puppeteer-core lo requiere explícito
ENV CHROMIUM_PATH=/usr/bin/chromium

# run.sh ejecuta node updater.js, espera UPDATE_INTERVAL_HOURS horas y repite.
# Node.js termina (process.exit) despues de cada ciclo — memoria liberada entre ejecuciones.
CMD ["/bin/sh", "/app/updater/run.sh"]
