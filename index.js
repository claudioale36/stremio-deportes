/**
 * @file        index.js
 * @description Addon de Stremio para reproducir enlaces .m3u8 y .mpd.
 *              Expone los endpoints del protocolo Stremio (manifest, catalog, meta, stream).
 *              Los canales se leen desde streams.json alojado en GitHub.
 * @usage       Desplegado como función serverless en Vercel. Localmente con `node index.js`.
 * @data        streams.json del repositorio GitHub.
 */

'use strict';

const express = require('express');

const app = express();

// ─── Configuración ────────────────────────────────────────────────────────────

/**
 * URL del streams.json en GitHub (rama main).
 * Se configura como variable de entorno en Vercel.
 * Formato: https://raw.githubusercontent.com/USUARIO/REPO/main/streams.json
 */
const STREAMS_JSON_URL = process.env.STREAMS_JSON_URL ||
  'https://raw.githubusercontent.com/claudioale36/stremio-deportes/main/streams.json';

/** TTL del caché en memoria — 5 minutos (en milisegundos) */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Caché en memoria ─────────────────────────────────────────────────────────

/**
 * Caché simple con TTL.
 * Nota: en Vercel (serverless) las instancias son efímeras;
 * el caché aplica dentro de la misma instancia activa, no entre cold starts.
 */
let _channelsCache = null;
let _cacheTimestamp = 0;

/**
 * Obtiene los canales desde GitHub con caché de 5 minutos.
 * Si la request falla, devuelve el caché anterior si existe (fail-safe).
 * @returns {Promise<Array>} Lista de canales del streams.json
 */
async function getChannels() {
  const now = Date.now();

  // Retornar caché si está vigente
  if (_channelsCache && (now - _cacheTimestamp) < CACHE_TTL_MS) {
    return _channelsCache;
  }

  try {
    // Cache-busting con timestamp para evitar CDN de GitHub
    const url = `${STREAMS_JSON_URL}?_=${now}`;
    const res = await fetch(url);

    if (!res.ok) throw new Error(`GitHub respondió HTTP ${res.status}`);

    const data = await res.json();
    _channelsCache = data.channels || [];
    _cacheTimestamp = now;

    console.log(`[streams] Cargados ${_channelsCache.length} canales desde GitHub`);
    return _channelsCache;

  } catch (err) {
    console.error('[streams] Error al obtener streams.json:', err.message);

    // Fail-safe: devolver caché anterior aunque esté vencido
    if (_channelsCache) {
      console.warn('[streams] Usando caché anterior (stale)');
      return _channelsCache;
    }

    return [];
  }
}

// ─── Caché de URLs de stream extraídas ───────────────────────────────────────

/**
 * Caché en memoria para URLs .m3u8/.mpd extraídas dinámicamente.
 * Independiente del caché de canales — tiene su propio TTL configurable por canal.
 * Clave: channel id. Valor: { url: string, timestamp: number }.
 */
const _streamUrlCache = new Map();

/**
 * Punto de entrada del sistema de extracción.
 * Decide qué estrategia usar según extractor.type y gestiona el caché.
 * Tipos soportados: "html-regex" | "iframe-chain" (ver EXTRACTION.md).
 *
 * @param {object} extractor - Objeto extractor del canal en streams.json
 * @param {string} channelId - ID del canal (clave de caché)
 * @returns {Promise<string|null>} URL del stream fresca o null si falló
 */
async function extractStreamUrl(extractor, channelId) {
  // TTL configurable por canal (campo cacheTTL en streams.json), default: 30 min
  const ttlMs = (extractor.cacheTTL || 1800) * 1000;
  const cached = _streamUrlCache.get(channelId);

  // Retornar caché si está vigente
  if (cached && (Date.now() - cached.timestamp) < ttlMs) {
    console.log(`[extractor] Cache hit para canal "${channelId}"`);
    return cached.url;
  }

  // Headers base que imitan un browser real (necesario para que el servidor responda)
  const baseHeaders = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
    ...(extractor.headers || {}) // headers adicionales definidos en streams.json
  };

  let streamUrl = null;

  try {
    if (extractor.type === 'html-regex') {
      // Tipo directo: la URL .m3u8 está en el HTML de extractor.url
      streamUrl = await fetchAndExtractM3u8(extractor.url, baseHeaders);

    } else if (extractor.type === 'iframe-chain') {
      // Tipo encadenado: seguir iframes hasta encontrar el .m3u8
      const depth = extractor.depth || 2;
      streamUrl = await followIframeChain(extractor.url, baseHeaders, depth);
    }

  } catch (err) {
    console.error(`[extractor] Error en canal "${channelId}":`, err.message);
  }

  // Guardar en caché solo si se obtuvo una URL válida
  if (streamUrl) {
    _streamUrlCache.set(channelId, { url: streamUrl, timestamp: Date.now() });
    console.log(`[extractor] URL obtenida para "${channelId}": ${streamUrl.substring(0, 80)}...`);
  } else {
    console.warn(`[extractor] No se encontró stream para canal "${channelId}"`);
  }

  return streamUrl;
}

/**
 * Hace fetch a una URL y extrae la primera URL .m3u8 o .mpd del HTML.
 * Regex cubre URLs con parámetros (tokens, query strings, etc.).
 *
 * @param {string} url     - URL a fetchear
 * @param {object} headers - Headers HTTP a enviar
 * @returns {Promise<string|null>} URL del stream o null
 */
async function fetchAndExtractM3u8(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} al fetchear ${url}`);
  const html = await res.text();

  // Captura URLs .m3u8 o .mpd con sus parámetros completos (tokens incluidos)
  const match = html.match(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)[^\s"'<>\\]*/i);
  return match ? match[0] : null;
}

/**
 * Sigue la cadena de iframes de una página hasta encontrar un .m3u8.
 * En cada nivel: busca .m3u8 en el HTML actual → si no hay, extrae el src
 * del primer iframe y repite (actualizando Referer en cada salto).
 *
 * Cadena detectada en futbollibre.mom (depth=2):
 *   Nivel 0: futbollibre.mom/canal/fox-sports/       → no tiene m3u8, tiene iframe
 *   Nivel 1: tvf90.com/1.php?stream=foxsports        → no tiene m3u8, tiene iframe (ads)
 *   Nivel 2: tvf90.com/6.php?stream=foxsports        → var playbackURL = "...m3u8..." ✅
 *
 * @param {string} startUrl  - URL de entrada de la cadena
 * @param {object} headers   - Headers base (Referer se actualiza en cada nivel)
 * @param {number} maxDepth  - Máximos niveles de iframe a seguir
 * @returns {Promise<string|null>} URL del stream o null
 */
async function followIframeChain(startUrl, headers, maxDepth) {
  let currentUrl = startUrl;
  let currentHeaders = { ...headers };

  for (let depth = 0; depth <= maxDepth; depth++) {
    console.log(`[extractor] Nivel ${depth}: ${currentUrl}`);

    const res = await fetch(currentUrl, { headers: currentHeaders });
    if (!res.ok) throw new Error(`HTTP ${res.status} en nivel ${depth}: ${currentUrl}`);
    const html = await res.text();

    // Buscar .m3u8 en el HTML de este nivel
    const streamMatch = html.match(/https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)[^\s"'<>\\]*/i);
    if (streamMatch) {
      console.log(`[extractor] Stream encontrado en nivel ${depth}`);
      return streamMatch[0];
    }

    // No hay stream — buscar el siguiente iframe para bajar un nivel más
    if (depth === maxDepth) break;
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    if (!iframeMatch) {
      console.warn(`[extractor] Sin iframe en nivel ${depth}, cadena interrumpida`);
      break;
    }

    // Resolver URL relativa (ej: src="/6.php?stream=x" → https://tvf90.com/6.php?stream=x)
    const nextUrl = new URL(iframeMatch[1], currentUrl).href;
    currentHeaders = { ...currentHeaders, Referer: currentUrl }; // actualizar Referer
    currentUrl = nextUrl;
  }

  return null;
}

// ─── Helper de respuesta ──────────────────────────────────────────────────────

/**
 * Responde con JSON y headers CORS + Cache-Control estándar de Stremio.
 * @param {object} res         - Objeto response de Express
 * @param {object} data        - Datos a serializar como JSON
 * @param {number} maxAgeSeconds - Tiempo de caché HTTP (0 = sin caché)
 */
function respond(res, data, maxAgeSeconds = 300) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (maxAgeSeconds > 0) {
    res.setHeader(
      'Cache-Control',
      `public, max-age=${maxAgeSeconds}, stale-while-revalidate=60`
    );
  } else {
    // Sin caché para streams en vivo (URLs pueden tener tokens que expiran)
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  }

  return res.json(data);
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

/**
 * Manifest del addon Stremio.
 * Define las capacidades que expone: catálogo, meta y stream de tipo 'tv'.
 */
const MANIFEST = {
  id: 'stremio.deportes',
  version: '1.0.0',
  name: 'Deportes en Vivo',
  description:
    'Canales de deportes en vivo.' +
    'Contenido provisto por el usuario — verificar legalidad en tu jurisdicción.',
  logo: 'https://upload.wikimedia.org/wikipedia/commons/1/1d/FIA_F1_Imola_2025_No._43_Colapinto_%282%29.jpg',
  types: ['tv'],
  catalogs: [
    {
      type: 'tv',
      id: 'deportes-live',
      name: 'Deportes en Vivo',
      extra: [
        { name: 'genre',  isRequired: false },
        { name: 'search', isRequired: false }
      ]
    }
  ],
  resources: [
    'catalog',
    { name: 'meta',   types: ['tv'], idPrefixes: ['deportes-'] },
    { name: 'stream', types: ['tv'], idPrefixes: ['deportes-'] }
  ],
  behaviorHints: {
    configurable: false
  }
};

// ─── Rutas ────────────────────────────────────────────────────────────────────

/** Manifest — cacheado 1 hora */
app.get('/manifest.json', (_req, res) => {
  respond(res, MANIFEST, 3600);
});

/**
 * Construye el objeto `meta` de Stremio a partir de un canal del streams.json.
 * @param {object} ch - Canal del streams.json
 * @returns {object} Meta object de Stremio
 */
function buildMeta(ch) {
  return {
    id:          `deportes-${ch.id}`,
    type:        'tv',
    name:        ch.name,
    poster:      ch.logo        || '',
    logo:        ch.logo        || '',
    background:  ch.background  || '',
    description: ch.description || '',
    genres:      ch.genres      || []
  };
}

// Catálogo completo
app.get('/catalog/tv/deportes-live.json', async (_req, res) => {
  const channels = await getChannels();
  respond(res, { metas: channels.map(buildMeta) });
});

// Catálogo filtrado por género
app.get('/catalog/tv/deportes-live/genre=:genre.json', async (req, res) => {
  const channels = await getChannels();
  const genre = decodeURIComponent(req.params.genre);

  const filtered = channels.filter(ch => (ch.genres || []).includes(genre));
  respond(res, { metas: filtered.map(buildMeta) });
});

// Catálogo con búsqueda por texto
app.get('/catalog/tv/deportes-live/search=:query.json', async (req, res) => {
  const channels = await getChannels();
  const query = decodeURIComponent(req.params.query).toLowerCase();

  const filtered = channels.filter(ch =>
    ch.name.toLowerCase().includes(query) ||
    (ch.description || '').toLowerCase().includes(query)
  );

  respond(res, { metas: filtered.map(buildMeta) });
});

// Meta de un canal individual — cacheado 5 minutos
app.get('/meta/tv/:id.json', async (req, res) => {
  const channels = await getChannels();

  // Los IDs en Stremio llevan el prefijo "deportes-"; lo removemos para buscar en el JSON
  const rawId = req.params.id.replace(/^deportes-/, '');
  const ch = channels.find(c => c.id === rawId);

  if (!ch) return res.status(404).json({ err: 'Canal no encontrado' });

  respond(res, { meta: buildMeta(ch) }, 300);
});

/**
 * Stream de un canal — SIN caché HTTP (los tokens de URL expiran).
 * Dos modos según la configuración del canal en streams.json:
 *
 *   Modo 1 — Extractor dinámico (campo `extractor` presente):
 *     El addon extrae la URL .m3u8 fresca desde la fuente en cada solicitud.
 *     La URL extraída sí se cachea en memoria (TTL: extractor.cacheTTL, default 30 min).
 *     Soporta tipos: "iframe-chain" | "html-regex" (ver EXTRACTION.md).
 *
 *   Modo 2 — Streams estáticos (campo `streams[]`, sin extractor):
 *     Devuelve las URLs hardcodeadas en streams.json tal como están.
 *     Útil para URLs fijas o con tokens de larga duración renovados manualmente.
 */
app.get('/stream/tv/:id.json', async (req, res) => {
  const channels = await getChannels();

  const rawId = req.params.id.replace(/^deportes-/, '');
  const ch = channels.find(c => c.id === rawId);

  if (!ch) return respond(res, { streams: [] }, 0);

  // ── Modo 1: extractor dinámico ──────────────────────────────────────────
  if (ch.extractor && ch.extractor.url && ch.extractor.type) {
    const streamUrl = await extractStreamUrl(ch.extractor, ch.id);

    if (!streamUrl) {
      console.error(`[stream] No se pudo obtener URL para canal "${ch.id}"`);
      return respond(res, { streams: [] }, 0);
    }

    return respond(res, {
      streams: [{
        title: ch.name,
        url:   streamUrl,
        behaviorHints: { notWebReady: false }
      }]
    }, 0);
  }

  // ── Modo 2: streams estáticos (sin extractor o como fallback) ───────────
  if (!Array.isArray(ch.streams) || ch.streams.length === 0) {
    return respond(res, { streams: [] }, 0);
  }

  const streams = ch.streams.map(s => {
    const stream = {
      title: s.label || ch.name,
      url:   s.url,
      behaviorHints: { notWebReady: false }
    };

    // Headers HTTP opcionales (ej: Referer, User-Agent) para streams que los requieren
    if (s.headers && typeof s.headers === 'object') {
      stream.behaviorHints.proxyHeaders = { request: s.headers };
    }

    return stream;
  });

  respond(res, { streams }, 0);
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

/**
 * Exportar como handler explícito para Vercel.
 * Wrappear la app en una función garantiza compatibilidad con @vercel/node,
 * evitando ambigüedades cuando Vercel recibe module.exports = expressApp directamente.
 */
module.exports = (req, res) => app(req, res);

/** Arranque local para desarrollo: `node api/index.js` */
if (require.main === module) {
  const PORT = process.env.PORT || 7001;
  app.listen(PORT, () => {
    console.log(`\n🟢 Addon corriendo en: http://localhost:${PORT}/manifest.json\n`);
  });
}
