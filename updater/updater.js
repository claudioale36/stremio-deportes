/**
 * @file        updater.js
 * @description Servicio de actualización automática de streams para el Add-On de Stremio.
 *              Extrae URLs .m3u8 frescas usando la lógica de extracción (iframe-chain, api-embed)
 *              desde la IP del hogar (evita el bloqueo 403 que ocurría en Vercel), escribe
 *              el resultado en add-on/streams.json y hace push al repositorio GitHub vía SSH.
 * @usage       node updater.js (dentro del contenedor Docker)
 * @data        updater/extractor-config.json — config de fuentes por canal.
 *              add-on/streams.json — escribe URLs frescas en el slot "HD (auto)" de cada canal.
 */

'use strict';

const fs        = require('fs');
const path      = require('path');
const simpleGit = require('simple-git');

// ─── Configuración ────────────────────────────────────────────────────────────

/** Ruta raíz del repositorio (montada como volumen en Docker) */
const REPO_PATH = process.env.REPO_PATH ||
  path.resolve(__dirname, '..');

/** Ruta al streams.json que lee el Add-On */
const STREAMS_JSON_PATH = process.env.STREAMS_JSON_PATH ||
  path.join(REPO_PATH, 'add-on', 'streams.json');

/** Ruta a la config de extractores (solo la lee el updater) */
const EXTRACTOR_CONFIG_PATH = process.env.EXTRACTOR_CONFIG_PATH ||
  path.join(__dirname, 'extractor-config.json');

/** Intervalo entre actualizaciones (horas) */
const UPDATE_INTERVAL_HOURS = parseFloat(process.env.UPDATE_INTERVAL_HOURS || '3');

/** Si los streams tienen más edad que esto al arrancar, extrae inmediatamente */
const MAX_TOKEN_AGE_HOURS = parseFloat(process.env.MAX_TOKEN_AGE_HOURS || '3');

// ─── Caché de la API de agenda ────────────────────────────────────────────────

const DIARIES_API_URL   = 'https://api.wqxag.com/diaries.json';
const DIARIES_CACHE_TTL = 30 * 60 * 1000; // 30 minutos

let _diariesCache  = null;
let _diariesCacheTs = 0;

/**
 * Obtiene y cachea el listado de embeds únicos desde la API de agenda.
 * Aplana todos los embeds de todos los eventos en un array deduplicado.
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

// ─── Funciones de extracción ──────────────────────────────────────────────────

/**
 * Hace fetch a una URL y extrae la primera URL .m3u8 o .mpd del HTML.
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
 * Actualiza el Referer en cada salto para imitar el comportamiento del browser.
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

/**
 * Extrae stream usando la API de agenda (api-embed).
 * Decodifica el base64 del embed_iframe y sigue la cadena resultante.
 * Prioriza la variante hd.php si preferHD es true.
 * @param {string}  channelName
 * @param {boolean} preferHD
 * @param {number}  depth
 * @param {object}  headers
 * @returns {Promise<{url: string, referer: string}|null>}
 */
async function fetchFromDiariesApi(channelName, preferHD, depth, headers) {
  const embeds = await getDiariesEmbeds();
  const target = normalizeName(channelName);

  // Comparar por nombre base del embed (antes del primer separador)
  const matching = embeds.filter(e => normalizeName(e.name.split(/[|\u2503]/)[0]) === target);

  if (!matching.length) {
    console.warn(`    [api-embed] Sin embed para "${channelName}" en la agenda de hoy`);
    return null;
  }

  let chosen = matching[0];
  if (preferHD) {
    const hd = matching.find(e => e.iframe.includes('hd.php'));
    if (hd) { chosen = hd; console.log(`    [api-embed] Usando variante HD`); }
  }

  // Extraer y decodificar el parámetro ?r= (URL en base64)
  const rMatch = chosen.iframe.match(/[?&]r=([^&\s]+)/);
  if (!rMatch) return null;

  let tvfUrl;
  try {
    tvfUrl = Buffer.from(rMatch[1], 'base64').toString('utf8').trim();
  } catch {
    return null;
  }

  console.log(`    [api-embed] URL decodificada: ${tvfUrl}`);
  return await followIframeChain(tvfUrl, headers, depth);
}

/**
 * Ejecuta la estrategia de extracción según el tipo configurado.
 * Soporta: "html-regex" | "iframe-chain" | "api-embed"
 * @param {object} extractor - Config del extractor (desde extractor-config.json)
 * @param {string} channelId
 * @returns {Promise<{url: string, referer: string}|null>}
 */
async function extractStreamUrl(extractor, channelId) {
  // Headers que imitan un browser real — necesarios para que los servidores respondan
  const baseHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8'
  };

  if (extractor.type === 'html-regex') {
    return await fetchAndExtractM3u8(extractor.url, baseHeaders);
  }

  if (extractor.type === 'iframe-chain') {
    if (!extractor.url) { console.warn(`  [extractor] URL vacía para ${channelId}`); return null; }
    return await followIframeChain(extractor.url, baseHeaders, extractor.depth || 2);
  }

  if (extractor.type === 'api-embed') {
    return await fetchFromDiariesApi(
      extractor.channelName,
      extractor.preferHD !== false,
      extractor.depth || 1,
      baseHeaders
    );
  }

  console.warn(`[extractor] Tipo desconocido: ${extractor.type}`);
  return null;
}

// ─── Lógica de actualización ──────────────────────────────────────────────────

/**
 * Extrae todos los canales configurados y actualiza streams.json.
 * Escribe la URL fresca en el slot con label "HD (auto)" de cada canal.
 * Al finalizar, actualiza lastUpdated y hace push al repo.
 */
async function extractAll() {
  console.log('\n[updater] ──────────────────────────────────────────────────────');
  console.log(`[updater] Iniciando extracción — ${new Date().toISOString()}`);
  console.log('[updater] ──────────────────────────────────────────────────────');

  const config      = JSON.parse(fs.readFileSync(EXTRACTOR_CONFIG_PATH, 'utf8')).channels || [];
  const streamsData = JSON.parse(fs.readFileSync(STREAMS_JSON_PATH, 'utf8'));

  let updated = 0;
  let failed  = 0;

  for (const channelConfig of config) {
    const channel = streamsData.channels.find(c => c.id === channelConfig.id);

    if (!channel) {
      console.warn(`\n[updater] Canal "${channelConfig.id}" no encontrado en streams.json — omitiendo`);
      continue;
    }

    console.log(`\n[updater] → ${channel.name} (${channelConfig.id})`);

    try {
      const result = await extractStreamUrl(channelConfig.extractor, channelConfig.id);

      if (result) {
        // Buscar el slot "HD (auto)" que espera la URL fresca
        const autoSlot = (channel.streams || []).find(s => s.label === 'HD (auto)');

        if (!autoSlot) {
          console.warn(`  ⚠️ No se encontró slot "HD (auto)" para ${channel.name} — omitiendo`);
          continue;
        }

        autoSlot.url       = result.url;
        autoSlot.referer   = result.referer; // guardado en el JSON para debug
        autoSlot.updatedAt = new Date().toISOString();

        console.log(`  ✅ ${result.url.substring(0, 75)}...`);
        updated++;

      } else {
        console.warn(`  ⚠️ No se pudo extraer URL — slot sin cambios`);
        failed++;
      }

    } catch (err) {
      console.error(`  ❌ Error: ${err.message}`);
      failed++;
    }
  }

  // Actualizar timestamp en la raíz del JSON
  streamsData.lastUpdated = new Date().toISOString();
  fs.writeFileSync(STREAMS_JSON_PATH, JSON.stringify(streamsData, null, 2) + '\n', 'utf8');

  console.log(`\n[updater] Resultado: ${updated} OK / ${failed} fallidos / ${config.length} total`);
  console.log('[updater] streams.json escrito en disco');

  // Push al repositorio GitHub
  await gitPush();
}

/**
 * Hace git add + commit + push del streams.json actualizado.
 * Usa las claves SSH del host montadas en /root/.ssh (volumen Docker).
 */
async function gitPush() {
  const git = simpleGit(REPO_PATH);

  // Configurar identidad del committer (requerida en el contenedor)
  await git.addConfig('user.name',  'stremio-updater');
  await git.addConfig('user.email', 'updater@local');

  // Solo stagear el streams.json del add-on
  await git.add('streams.json');

  const status = await git.status();
  if (!status.staged.length) {
    console.log('[git] Sin cambios para pushear');
    return;
  }

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  await git.commit(`chore: actualizar streams.json [${timestamp}]`);
  await git.push('origin', 'main');

  console.log('[git] ✅ Push exitoso');
}

// ─── Ciclo de vida ────────────────────────────────────────────────────────────

/**
 * Punto de entrada del servicio.
 * Al arrancar: verifica edad de los streams y extrae si superan MAX_TOKEN_AGE_HOURS.
 * Luego programa el ciclo periódico con UPDATE_INTERVAL_HOURS.
 */
async function main() {
  console.log('╔═════════════════════════════════════════╗');
  console.log('║    Stremio Deportes — Updater           ║');
  console.log('╚═════════════════════════════════════════╝');
  console.log(`[updater] Intervalo:        cada ${UPDATE_INTERVAL_HOURS}h`);
  console.log(`[updater] Edad máx. tokens: ${MAX_TOKEN_AGE_HOURS}h`);
  console.log(`[updater] Repo:             ${REPO_PATH}`);
  console.log(`[updater] streams.json:     ${STREAMS_JSON_PATH}`);

  // ── Verificar edad de los streams al arrancar ────────────────────────────
  let runImmediately = true;

  try {
    const data        = JSON.parse(fs.readFileSync(STREAMS_JSON_PATH, 'utf8'));
    const lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;

    if (lastUpdated) {
      const ageHours = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60);
      console.log(`\n[updater] Edad de los streams: ${ageHours.toFixed(1)}h`);

      if (ageHours <= MAX_TOKEN_AGE_HOURS) {
        const nextIn = UPDATE_INTERVAL_HOURS - ageHours;
        console.log(`[updater] Tokens vigentes — próxima extracción en ${nextIn.toFixed(1)}h`);
        runImmediately = false;
      } else {
        console.log(`[updater] Tokens vencidos (${ageHours.toFixed(1)}h > ${MAX_TOKEN_AGE_HOURS}h) — extrayendo ya`);
      }
    } else {
      console.log('[updater] Sin lastUpdated — extrayendo inmediatamente');
    }
  } catch (err) {
    console.error('[updater] Error leyendo streams.json:', err.message);
  }

  if (runImmediately) {
    await extractAll().catch(err => console.error('[updater] Error en extracción inicial:', err.message));
  }

  // ── Ciclo periódico ──────────────────────────────────────────────────────
  const intervalMs = UPDATE_INTERVAL_HOURS * 60 * 60 * 1000;
  setInterval(async () => {
    await extractAll().catch(err => console.error('[updater] Error en ciclo periódico:', err.message));
  }, intervalMs);

  console.log('\n[updater] ✅ Servicio activo\n');
}

main().catch(err => {
  console.error('[updater] Error fatal:', err);
  process.exit(1);
});
