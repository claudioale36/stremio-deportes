/**
 * @file        updater.js
 * @description Servicio de actualización automática de streams para el Add-On de Stremio.
 *              Extrae URLs .m3u8 frescas usando Puppeteer (browser headless) para ejecutar
 *              el JS de las páginas de streaming y capturar el token real generado en runtime.
 *              fetch() solo descarga HTML estático — los tokens reales los genera JS en el browser.
 *              Escribe el resultado en streams.json y hace push al repositorio GitHub vía SSH.
 * @usage       node updater.js (dentro del contenedor Docker)
 * @data        updater/extractor-config.json — config de fuentes por canal.
 *              streams.json (raíz del repo) — escribe URLs frescas en el slot "HD (auto)" de cada canal.
 *              FORCE_UPDATE=1 — env var para forzar extracción inmediata al arrancar (bypass del chequeo de edad).
 *              CHROMIUM_PATH — ruta al binario de Chromium (default: /usr/bin/chromium).
 */

'use strict';

const fs        = require('fs');
const path      = require('path');
const puppeteer = require('puppeteer-core');
const { simpleGit } = require('simple-git');

// ─── Configuración ────────────────────────────────────────────────────────────

/** Ruta raíz del repositorio (montada como volumen en Docker) */
const REPO_PATH = process.env.REPO_PATH ||
  path.resolve(__dirname, '..');

/** Ruta al streams.json que lee el Add-On */
const STREAMS_JSON_PATH = process.env.STREAMS_JSON_PATH ||
  path.join(REPO_PATH, 'streams.json');

/** Ruta a la config de extractores (solo la lee el updater) */
const EXTRACTOR_CONFIG_PATH = process.env.EXTRACTOR_CONFIG_PATH ||
  path.join(__dirname, 'extractor-config.json');

/** Intervalo entre actualizaciones (horas) */
const UPDATE_INTERVAL_HOURS = parseFloat(process.env.UPDATE_INTERVAL_HOURS || '3');

/** Si los streams tienen más edad que esto al arrancar, extrae inmediatamente */
const MAX_TOKEN_AGE_HOURS = parseFloat(process.env.MAX_TOKEN_AGE_HOURS || '3');

/**
 * Ruta al binario de Chromium instalado en el sistema.
 * puppeteer-core no incluye Chromium propio — requiere que esté instalado por separado.
 * En el Dockerfile se instala via apt (chromium) y queda en /usr/bin/chromium.
 */
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

// ─── Caché de la API de agenda ────────────────────────────────────────────────

const DIARIES_API_URL   = 'https://api.wqxag.com/diaries.json';
const DIARIES_CACHE_TTL = 30 * 60 * 1000; // 30 minutos

let _diariesCache  = null;
let _diariesCacheTs = 0;

/**
 * Obtiene y cachea el listado de embeds únicos desde la API de agenda.
 * Aplana todos los embeds de todos los eventos en un array deduplicado.
 * Este fetch() sí es correcto — es una API JSON pura, sin JS que ejecutar.
 * @returns {Promise<Array<{name: string, iframe: string}>>}
 */
async function getDiariesEmbeds() {
  const now = Date.now();
  if (_diariesCache && (now - _diariesCacheTs) < DIARIES_CACHE_TTL) return _diariesCache;

  const res  = await fetch(`${DIARIES_API_URL}?_=${now}`);
  if (!res.ok) throw new Error(`Diaries API HTTP ${res.status}`);
  const data = await res.json();
  const all  = [];

  for (const event of (data.data || [])) {
    for (const embed of (event?.attributes?.embeds?.data || [])) {
      const a = embed?.attributes;
      if (a?.embed_name && a?.embed_iframe) all.push({ name: a.embed_name, iframe: a.embed_iframe });
    }
  }

  // Deduplicar por iframe URL — la misma señal aparece en múltiples eventos
  const seen   = new Set();
  const unique = all.filter(e => { if (seen.has(e.iframe)) return false; seen.add(e.iframe); return true; });

  _diariesCache   = unique;
  _diariesCacheTs = now;

  console.log(`[diaries] ${unique.length} embeds únicos`);
  return unique;
}

/**
 * Normaliza nombre de canal para comparación sin acentos ni separadores.
 * @param {string} s
 * @returns {string}
 */
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[|\u2503+]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Extracción con browser headless ─────────────────────────────────────────

/**
 * Usa Puppeteer (Chromium headless) para navegar a la URL e interceptar
 * la primera request de red a un .m3u8 o .mpd.
 *
 * ¿Por qué esto en lugar de fetch()?
 * Las páginas de streaming (tvf90.com/5.php, etc.) generan el token vía JS:
 *   fetch() descarga el HTML → encuentra un token placeholder corto → ftlly.com devuelve 403
 *   Puppeteer ejecuta el JS → el player genera el token real con timestamps → token válido
 *
 * @param {string}  startUrl - URL de la página que contiene el player de video
 * @param {Browser} browser  - Instancia de Puppeteer compartida entre canales (reutilizar)
 * @returns {Promise<{url: string, referer: string}|null>}
 */
async function extractWithBrowser(startUrl, browser) {
  const page = await browser.newPage();

  try {
    // Inyectar antes de que cargue cualquier script — los players comprueban estas propiedades
    // en cuanto arrancan para detectar browsers automatizados.
    await page.evaluateOnNewDocument(() => {
      // navigator.webdriver es el indicador más usado para detectar Puppeteer/CDP
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // Eliminar trazas del Chrome DevTools Protocol que dejan versiones antiguas de Chromium
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });

    // User-Agent de Chrome real — algunos servidores bloquean headless explícitamente
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Viewport realista — algunos players no inicializan si el área visible es cero o muy pequeña
    await page.setViewport({ width: 1280, height: 720 });

    // Silenciar dialogs (alert/confirm) que podrían bloquear la carga
    page.on('dialog', async dialog => dialog.dismiss().catch(() => {}));

    let capturedUrl     = null;
    let capturedReferer = startUrl;
    let resolveCapture;

    // Promesa que se resuelve en cuanto capturamos el stream
    const streamFoundPromise = new Promise(resolve => { resolveCapture = resolve; });

    // Escuchar responses (no-bloqueante) en lugar de interceptar requests.
    // setRequestInterception suspende CADA request hasta que Puppeteer llame continue(),
    // lo que altera el timing de carga del JS del player: Clappr/SwarmCloud tienen
    // lógica de inicialización sensible al orden de carga y fallan silenciosamente
    // si sus módulos no llegan en la secuencia correcta — el browser recibe los requests
    // pero el player nunca llega a hacer la request al CDN por ese desorden de timing.
    // page.on('response') observa sin interferir — el player arranca normalmente.
    page.on('response', response => {
      const url = response.url();

      if (!capturedUrl && url.match(/\.(?:m3u8|mpd)/i)) {
        // Filtrar para capturar solo streams reales:
        // Los streams auténticos siempre tienen ?token= en la URL (auth del CDN).
        // Los .m3u8 sin token son manifests internos del player (test-stream, splash, etc.)
        // Token CDN real: formato hexhash-id-ts-ts (con guiones y timestamps).
        // Tokens cortos sin guiones son manifests internos/splash del player — ignorarlos.
        if (/[?&]token=[0-9a-f]+-[0-9a-f]+-\d+-\d+/i.test(url)) {
          // Stream real con token CDN completo — este es el que necesitamos
          capturedUrl     = url;
          capturedReferer = response.request().headers()['referer'] || startUrl;
          resolveCapture({ url: capturedUrl, referer: capturedReferer });
        } else {
          // .m3u8 con token incompleto o sin token — manifest interno del player, ignorar
          console.log(`    [browser] .m3u8 sin token CDN ignorado: ${url.substring(0, 90)}`);
        }
      }
    });

    // Timeout total de 30s — aumentado para dar más tiempo al player en carga lenta
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => {
        reject(new Error(`Timeout (30s): no se capturó stream`));
      }, 30_000)
    );

    // Iniciar navegación — loguear errores (antes se silenciaban con .catch(() => {}),
    // ocultando si la navegación fallaba antes de que el player pudiera arrancar)
    page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      .catch(err => console.warn(`    [browser] goto error (ignorado): ${err.message.split('\n')[0]}`));

    // Esperar a que se capture el stream o se agote el timeout
    return await Promise.race([streamFoundPromise, timeoutPromise]);

  } catch (err) {
    if (err.message.includes('Timeout')) {
      console.warn(`    [browser] ⏱️  ${err.message}`);
      return null;
    }
    throw err;
  } finally {
    // Cerrar la page pero no el browser — el browser se reutiliza entre canales
    await page.close().catch(() => {});
  }
}

// ─── Funciones de extracción (legacy — mantenidas como referencia) ─────────────
// Estas funciones fetch-based ya no se usan para la extracción principal
// porque no ejecutan JS. Se conservan por si se necesitan para fuentes
// que sí devuelvan la URL directamente en el HTML (sin JS dinámico).

/**
 * Hace fetch a una URL y extrae la primera URL .m3u8 o .mpd del HTML.
 * NOTA: solo funciona si la URL está hardcodeada en el HTML (sin JS).
 * @param {string} url
 * @param {object} headers
 * @returns {Promise<{url: string, referer: string}|null>}
 */
async function fetchAndExtractM3u8(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
  const html  = await res.text();
  const match = html.match(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)[^\s"'<>\\]*/i);
  return match ? { url: match[0], referer: url } : null;
}

/**
 * Sigue la cadena de iframes nivel a nivel hasta encontrar un .m3u8.
 * NOTA: solo funciona si la URL está en el HTML estático (sin JS).
 * @param {string} startUrl
 * @param {object} headers
 * @param {number} maxDepth
 * @returns {Promise<{url: string, referer: string}|null>}
 */
async function followIframeChain(startUrl, headers, maxDepth) {
  let currentUrl     = startUrl;
  let currentHeaders = { ...headers };

  for (let depth = 0; depth <= maxDepth; depth++) {
    console.log(`    [chain] Nivel ${depth}: ${currentUrl}`);

    const res = await fetch(currentUrl, { headers: currentHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status} en nivel ${depth}`);
    const html = await res.text();

    // ¿Encontramos el stream en este nivel?
    const streamMatch = html.match(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)[^\s"'<>\\]*/i);
    if (streamMatch) {
      console.log(`    [chain] ✅ Stream en nivel ${depth}`);
      return { url: streamMatch[0], referer: currentUrl };
    }

    if (depth === maxDepth) break;

    // Bajar al siguiente iframe
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!iframeMatch) { console.warn(`    [chain] Sin iframe en nivel ${depth}`); break; }

    const nextUrl  = new URL(iframeMatch[1], currentUrl).href;
    currentHeaders = { ...currentHeaders, Referer: currentUrl };
    currentUrl     = nextUrl;
  }

  return null;
}

// ─── Lógica de extracción por tipo ────────────────────────────────────────────

/**
 * Extrae la URL del stream para un canal tipo "api-embed":
 * 1. Consulta la API de agenda para obtener el embed del canal (fetch — API pura, no JS)
 * 2. Decodifica la URL tvf90.com del base64
 * 3. Usa el browser para navegar a esa URL e interceptar el token real
 *
 * @param {object}  extractor - Config del extractor (desde extractor-config.json)
 * @param {Browser} browser   - Instancia de Puppeteer compartida
 * @returns {Promise<{url: string, referer: string}|null>}
 */
async function fetchFromDiariesApi(extractor, browser) {
  const embeds = await getDiariesEmbeds();
  const target = normalizeName(extractor.channelName);

  // Buscar el embed que corresponde al canal por nombre normalizado
  const matching = embeds.filter(e => normalizeName(e.name.split(/[|\u2503]/)[0]) === target);

  if (!matching.length) {
    console.warn(`    [api-embed] Sin embed para "${extractor.channelName}" en la agenda de hoy`);
    // Mostrar nombres similares para facilitar diagnóstico cuando el nombre no matchea
    const targetWords = target.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const similar = embeds
      .filter(e => targetWords.some(w => normalizeName(e.name).includes(w)))
      .map(e => e.name)
      .slice(0, 5);
    if (similar.length) console.log(`    [api-embed] Nombres similares disponibles: ${similar.join(' | ')}`);
    return null;
  }

  // Preferir la variante hd.php si existe y preferHD no está desactivado
  let chosen = matching[0];
  if (extractor.preferHD !== false) {
    const hd = matching.find(e => e.iframe.includes('hd.php'));
    if (hd) { chosen = hd; console.log(`    [api-embed] Usando variante HD`); }
  }

  // Extraer y decodificar el parámetro ?r= (URL tvf90.com en base64)
  const rMatch = chosen.iframe.match(/[?&]r=([^&\s]+)/);
  if (!rMatch) return null;

  let tvfUrl;
  try {
    tvfUrl = Buffer.from(rMatch[1], 'base64').toString('utf8').trim();
  } catch {
    return null;
  }

  console.log(`    [api-embed] URL decodificada: ${tvfUrl}`);

  // Navegar con el browser al embed de tvf90.com — aquí el JS genera el token real
  return await extractWithBrowser(tvfUrl, browser);
}

/**
 * Ejecuta la estrategia de extracción según el tipo configurado.
 * Todos los tipos usan Puppeteer para ejecutar el JS del player y capturar el token real.
 *
 * Soporta: "html-regex" | "iframe-chain" | "api-embed"
 *
 * @param {object}  extractor  - Config del extractor (desde extractor-config.json)
 * @param {string}  channelId
 * @param {Browser} browser    - Instancia de Puppeteer compartida entre canales
 * @returns {Promise<{url: string, referer: string}|null>}
 */
async function extractStreamUrl(extractor, channelId, browser) {
  if (extractor.type === 'html-regex' || extractor.type === 'iframe-chain') {
    if (!extractor.url) {
      console.warn(`  [extractor] URL vacía para ${channelId}`);
      return null;
    }
    // El browser navega al startUrl y deja que el JS del player construya la URL real;
    // los iframes internos también se cargan automáticamente (Puppeteer los maneja)
    console.log(`    [browser] Navegando a: ${extractor.url}`);
    return await extractWithBrowser(extractor.url, browser);
  }

  if (extractor.type === 'api-embed') {
    // La API de la agenda se consulta con fetch (es JSON puro, sin JS);
    // solo el último paso (cargar el embed de tvf90.com) necesita el browser
    return await fetchFromDiariesApi(extractor, browser);
  }

  console.warn(`[extractor] Tipo desconocido: ${extractor.type}`);
  return null;
}

// ─── Autenticación Git ───────────────────────────────────────────────────

/**
 * Verifica la autenticación SSH con GitHub al arranque del servicio.
 * Ejecuta `ssh -T git@github.com` para confirmar que la clave SSH está disponible.
 * GitHub responde con código de salida 1 pero mensaje "Hi <user>!" — se considera éxito.
 * @returns {Promise<boolean>} true si la autenticación fue exitosa
 */
async function checkGitHubAuth() {
  const { execFile } = require('child_process');
  return new Promise(resolve => {
    execFile(
      'ssh', ['-T', '-o', 'StrictHostKeyChecking=accept-new', 'git@github.com'],
      { timeout: 10000 },
      (_err, stdout, stderr) => {
        const output = (stdout + stderr).trim();
        if (output.includes('successfully authenticated') || output.includes('Hi ')) {
          console.log(`[git] ✅ Auth SSH GitHub OK — ${output}`);
          resolve(true);
        } else {
          console.error(`[git] ❌ Auth SSH GitHub FALLÓ — ${output || '(sin respuesta)'}`);
          resolve(false);
        }
      }
    );
  });
}

// ─── Lógica de actualización ──────────────────────────────────────────────────

/**
 * Extrae todos los canales configurados y actualiza streams.json.
 * Escribe la URL fresca en el slot con label "HD (auto)" de cada canal,
 * junto con los headers (Referer) necesarios para que Stremio los envíe al CDN.
 * Usa una única instancia de browser Chromium compartida entre todos los canales.
 * Al finalizar, actualiza lastUpdated y hace push al repo.
 */
async function extractAll() {
  console.log('\n[updater] ──────────────────────────────────────────────────────');
  console.log(`[updater] Iniciando extracción — ${new Date().toISOString()}`);
  console.log('[updater] ──────────────────────────────────────────────────────');

  // Cargar config del extractor
  let config;
  try {
    config = JSON.parse(fs.readFileSync(EXTRACTOR_CONFIG_PATH, 'utf8')).channels || [];
  } catch (err) {
    console.error(`[updater] ❌ No se pudo leer extractor-config.json: ${err.message}`);
    return;
  }

  // Cargar streams.json — si no existe, el volumen Docker no está montado correctamente
  let streamsData;
  try {
    streamsData = JSON.parse(fs.readFileSync(STREAMS_JSON_PATH, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[updater] ❌ streams.json no encontrado en: ${STREAMS_JSON_PATH}`);
      console.error('[updater]    Causa probable: el volumen Docker no apunta al repo correcto.');
      console.error('[updater]    Verificar en docker-compose.yml: volumes: ../:/app/repo');
    } else {
      console.error(`[updater] ❌ Error leyendo streams.json: ${err.message}`);
    }
    return;
  }

  // ── Lanzar browser Chromium — una instancia compartida para todos los canales ──
  // Reutilizarla evita el overhead de arrancar Chromium (~2-3s) por cada canal.
  // Se cierra en el bloque finally para garantizar que no queden procesos huérfanos.
  console.log(`[browser] Lanzando Chromium: ${CHROMIUM_PATH}`);
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless:        true,
    args: [
      '--no-sandbox',                                   // Requerido en Docker (el contenedor corre como root)
      '--disable-setuid-sandbox',                       // Ídem
      '--disable-dev-shm-usage',                        // Evita crashes por falta de memoria compartida en Docker
      '--disable-gpu',                                  // Sin GPU en servidor headless
      '--mute-audio',                                   // No reproducir audio durante la extracción
      '--no-zygote',                                    // Evita procesos zombie en entornos con pid namespace restringido
      '--disable-blink-features=AutomationControlled',  // Oculta el flag CDP que delata al browser automatizado
      '--autoplay-policy=no-user-gesture-required',     // Permite que el player arranque sin gesto del usuario
    ]
  });
  console.log('[browser] ✅ Chromium iniciado');

  const total          = config.length;
  let   updated        = 0;
  let   failed         = 0;
  const failedChannels = [];

  try {
    for (let i = 0; i < config.length; i++) {
      const channelConfig = config[i];
      const channel = streamsData.channels.find(c => c.id === channelConfig.id);

      if (!channel) {
        console.warn(`\n[updater] [${i + 1}/${total}] Canal "${channelConfig.id}" no en streams.json — omitiendo`);
        continue;
      }

      console.log(`\n[updater] [${i + 1}/${total}] → ${channel.name} (${channelConfig.id})`);

      try {
        // Pasar el browser compartido para que la extracción pueda abrir una nueva page
        const result = await extractStreamUrl(channelConfig.extractor, channelConfig.id, browser);

        if (result) {
          // Buscar el slot "HD (auto)" que espera la URL fresca
          const autoSlot = (channel.streams || []).find(s => s.label === 'HD (auto)');

          if (!autoSlot) {
            console.warn(`  ⚠️  No se encontró slot "HD (auto)" para ${channel.name} — omitiendo`);
            continue;
          }

          const oldUrl = autoSlot.url || '(vacío)';

          autoSlot.url       = result.url;
          // Guardar Referer y User-Agent como headers para que index.js los envíe a Stremio
          // via behaviorHints.proxyHeaders.request — el CDN puede requerir el Referer correcto
          autoSlot.headers   = {
            'Referer':    result.referer,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          };
          autoSlot.updatedAt = new Date().toISOString();

          console.log(`  ANTERIOR: ${oldUrl.substring(0, 80)}`);
          console.log(`  NUEVO:    ${result.url.substring(0, 80)}`);
          console.log(`  REFERER:  ${result.referer}`);
          updated++;

        } else {
          console.warn(`  ⚠️  No se pudo extraer URL — slot sin cambios`);
          failed++;
          failedChannels.push(channel.name);
        }

      } catch (err) {
        console.error(`  ❌ Error: ${err.message}`);
        failed++;
        failedChannels.push(`${channel.name} (${err.message.substring(0, 60)})`);
      }
    }

  } finally {
    // Cerrar el browser siempre, incluso si hubo errores
    await browser.close().catch(err => console.error(`[browser] Error al cerrar: ${err.message}`));
    console.log('[browser] Chromium cerrado');
  }

  // Actualizar timestamp en la raíz del JSON
  streamsData.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STREAMS_JSON_PATH, JSON.stringify(streamsData, null, 2) + '\n', 'utf8');

  console.log('\n[updater] ──────────────────────────────────────────────────────');
  console.log(`[updater] Resultado: ${updated} OK / ${failed} fallidos / ${total} total`);

  if (failedChannels.length) {
    console.log('[updater] Sin enlace:');
    failedChannels.forEach(name => console.log(`[updater]   • ${name}`));
  }

  console.log('[updater] streams.json escrito en disco');

  // Push al repositorio GitHub
  await gitPush(updated, total);
}

/**
 * Hace git add + commit + push del streams.json actualizado.
 * Autenticación: HTTPS + Personal Access Token (GITHUB_TOKEN env var).
 * HTTPS + PAT es el estándar para push automático en Docker: evita los problemas
 * de bad owner que tiene SSH cuando los archivos montados pertenecen a otro UID.
 * La rama se detecta dinámicamente — no está hardcodeada.
 * @param {number} updated  - Canales actualizados con éxito (para el mensaje de commit).
 * @param {number} total    - Total de canales procesados.
 */
async function gitPush(updated = 0, total = 0) {
  // Verificar token antes de cualquier operación git
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('[git] ❌ GITHUB_TOKEN no definido — push cancelado');
    return;
  }

  const git = simpleGit(REPO_PATH);

  // Configurar identidad del committer (requerida en el contenedor)
  await git.addConfig('user.name',  'stremio-updater');
  await git.addConfig('user.email', 'updater@local');

  // Construir remote URL con token embebido — nunca se loguea completo
  const remoteUrl = `https://${token}@github.com/claudioale36/stremio-deportes.git`;
  console.log('[git] Remote: https://***@github.com/claudioale36/stremio-deportes.git');

  // Detectar la rama actual del repo en vez de hardcodear 'main'
  const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  console.log(`[git] Rama activa: ${currentBranch}`);

  // Stagear el streams.json (ruta relativa a REPO_PATH)
  const streamsRelPath = path.relative(REPO_PATH, STREAMS_JSON_PATH);
  await git.add(streamsRelPath);

  const status = await git.status();
  if (!status.staged.length) {
    console.log('[git] Sin cambios para pushear');
    return;
  }

  const timestamp    = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const commitMsg    = `chore: actualizar streams.json — ${updated}/${total} canales [${timestamp}]`;
  const commitResult = await git.commit(commitMsg);
  console.log(`[git] Commit: ${commitResult.commit} — "${commitMsg}"`);

  // Push usando la URL con token — sin depender de claves SSH
  await git.push(remoteUrl, currentBranch);
  console.log(`[git] ✅ Push exitoso → origin/${currentBranch}`);
}

// ─── Ciclo de vida ────────────────────────────────────────────────────────────

/**
 * Punto de entrada del servicio.
 * Extrae una vez y termina — el ciclo periódico lo maneja run.sh via sleep.
 * Esto garantiza que Node.js libere toda la memoria (heap V8 + Chromium) al finalizar.
 */
async function main() {
  console.log('╔═════════════════════════════════════════╗');
  console.log('║    Stremio Deportes — Updater           ║');
  console.log('╚═════════════════════════════════════════╝');
  console.log(`[updater] Repo:             ${REPO_PATH}`);
  console.log(`[updater] streams.json:     ${STREAMS_JSON_PATH}`);
  console.log(`[updater] Chromium:         ${CHROMIUM_PATH}`);

  // ── Verificar token de GitHub ──────────────────────────────────
  if (!process.env.GITHUB_TOKEN) {
    console.error('[git] ⚠️  GITHUB_TOKEN no definido — el push automático no funcionará');
  } else {
    console.log('[git] ✅ GITHUB_TOKEN presente — push HTTPS habilitado');
  }

  // ── Extraer y salir ────────────────────────────────────────────────────────
  // El ciclo periódico es responsabilidad de run.sh (sleep entre invocaciones).
  // Node.js termina con process.exit() para liberar heap V8 y procesos Chromium.
  await extractAll();

  console.log('\n[updater] ✅ Ciclo completado — proceso terminado\n');
  process.exit(0);
}

main().catch(err => {
  console.error('[updater] Error fatal:', err);
  process.exit(1);
});
