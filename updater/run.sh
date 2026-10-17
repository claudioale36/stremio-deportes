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

  # Matar cualquier proceso Chromium huerfano que no haya cerrado correctamente.
  # Con pipe:true y process.exit(0), el pipe se rompe antes de que browser.close()
  # termine de enviar la señal de cierre — Chromium puede quedar corriendo en el cgroup.
  #
  # Se usa SIGKILL (-9) en lugar de SIGTERM (default) porque SIGTERM puede ser
  # ignorado o demorado por signal handlers de Chromium, especialmente en la
  # segunda pasada cuando el proceso tiene estado acumulado.
  pkill -9 -f chromium 2>/dev/null || true

  # Safety net para Node.js: cubre el caso en que updater.js no llegó a
  # process.exit(0) (ej: git push colgado, error de red sin timeout).
  # pkill dentro del contenedor solo ve el PID namespace propio — no afecta al host.
  pkill -9 -f "node" 2>/dev/null || true

  echo "[run.sh] $(date -u +%Y-%m-%dT%H:%M:%SZ) — Ciclo terminado (exit ${EXIT_CODE}). Proxima ejecucion en ${WAIT_HOURS}h."
  sleep $(( WAIT_HOURS * 3600 ))
done
