/**
 * @file        api/index.js
 * @description Addon de Stremio para reproducir streams de deportes en vivo (.m3u8 / .mpd).
 *              Expone los endpoints del protocolo Stremio (manifest, catalog, meta, stream).
 *              Los canales se leen desde streams.json alojado en GitHub (sin backend propio).
 * @usage       Desplegado como función serverless en Vercel. Localmente con `node api/index.js`.
 * @data        streams.json del repositorio GitHub — URLs de canales de deportes en vivo.
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
  id: 'ar.claudioale.stremio.deportes',
  version: '1.0.0',
  name: 'Deportes en Vivo',
  description:
    'Canales de deportes en vivo con streams .m3u8 y .mpd. ' +
    'Contenido provisto por el usuario — verificar legalidad en tu jurisdicción.',
  logo: 'https://i.imgur.com/placeholder-logo.png', // reemplazar con logo propio
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
 * Stream de un canal — SIN caché (URLs con tokens expirables).
 * Construye el array de streams a partir del campo `streams` del canal en el JSON.
 * Soporta headers HTTP opcionales para streams que requieren Referer / User-Agent.
 */
app.get('/stream/tv/:id.json', async (req, res) => {
  const channels = await getChannels();

  const rawId = req.params.id.replace(/^deportes-/, '');
  const ch = channels.find(c => c.id === rawId);

  // Si no existe el canal o no tiene streams definidos, devolver lista vacía
  if (!ch || !Array.isArray(ch.streams) || ch.streams.length === 0) {
    return respond(res, { streams: [] }, 0);
  }

  const streams = ch.streams.map(s => {
    const stream = {
      title: s.label || ch.name,
      url:   s.url,
      behaviorHints: {
        notWebReady: false
      }
    };

    // Headers HTTP opcionales (ej: Referer, User-Agent) para streams que los requieren
    if (s.headers && typeof s.headers === 'object') {
      stream.behaviorHints.proxyHeaders = {
        request: s.headers
      };
    }

    return stream;
  });

  respond(res, { streams }, 0);
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

/** Exportar la app para Vercel (serverless handler) */
module.exports = app;

/** Arranque local para desarrollo: `node api/index.js` */
if (require.main === module) {
  const PORT = process.env.PORT || 7001;
  app.listen(PORT, () => {
    console.log(`\n🟢 Addon corriendo en: http://localhost:${PORT}/manifest.json\n`);
  });
}
