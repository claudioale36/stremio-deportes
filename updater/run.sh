#!/bin/sh
# stremio-addons/stremio-deportes/updater/run.sh
#
# Bucle de ejecucion del updater.
# Node.js arranca, extrae streams, termina — memoria completamente liberada entre ciclos.
# La periodicidad la maneja este script via sleep, no setInterval dentro de Node.
# UPDATE_INTERVAL_HOURS se hereda del entorno Docker (ENV en Dockerfile / docker-compose.yml).

WAIT_HOURS=${UPDATE_INTERVAL_HOURS:-3}

while true; do
  echo "[run.sh] $(date -u +%Y-%m-%dT%H:%M:%SZ) — Iniciando ciclo de extraccion..."
  node /app/updater/updater.js
  EXIT_CODE=$?
  echo "[run.sh] $(date -u +%Y-%m-%dT%H:%M:%SZ) — Ciclo terminado (exit ${EXIT_CODE}). Proxima ejecucion en ${WAIT_HOURS}h."
  sleep $(( WAIT_HOURS * 3600 ))
done
