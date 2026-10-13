/**
 * @file        index.js
 * @description Addon de Stremio para reproducir streams de deportes en vivo.
 *              Sirve los canales definidos en streams.json — mantenido automáticamente
 *              por el servicio updater (Docker local). Sin lógica de extracción.
 * @usage       Vercel serverless — auto-detectado como función por estar en api/.
 *              Desarrollo local: node api/index.js
 * @data        streams.json en la raíz del repo — URLs frescas escritas cada 3h por el updater.
 */

'use strict';

const express = require('express');

const app = express();

// ─── Configuración ────────────────────────────────────────────────────────────

/**
 * URL del streams.json en GitHub.
 * El updater Docker hace push cada 3h con URLs frescas.
 * Cache-busting con timestamp para evitar CDN de GitHub.
 * Sobreescribible con la variable de entorno STREAMS_JSON_URL en Vercel.
 */
const STREAMS_JSON_URL = process.env.STREAMS_JSON_URL ||
  'https://raw.githubusercontent.com/claudioale36/stremio-deportes/streams.json';

/** TTL del caché en memoria — 5 minutos */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Caché de canales ─────────────────────────────────────────────────────────

let _channelsCache  = null;
let _cacheTimestamp = 0;

/**
 * Obtiene los canales desde GitHub con caché de 5 minutos.
 * Fail-safe: devuelve caché anterior si el fetch falla.
 * @returns {Promise<Array>}
 */
async function getChannels() {
  const now = Date.now();
  if (_channelsCache && (now - _cacheTimestamp) < CACHE_TTL_MS) return _channelsCache;

  try {
    const res = await fetch(`${STREAMS_JSON_URL}?_=${now}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data      = await res.json();
    _channelsCache  = data.channels || [];
    _cacheTimestamp = now;
    console.log(`[streams] ${_channelsCache.length} canales cargados`);
    return _channelsCache;
  } catch (err) {
    console.error('[streams] Error:', err.message);
    return _channelsCache || [];
  }
}

// ─── Helper de respuesta ──────────────────────────────────────────────────────

/**
 * Responde con JSON, headers CORS y Cache-Control.
 * @param {object} res
 * @param {object} data
 * @param {number} maxAgeSeconds - 0 = no-store
 */
function respond(res, data, maxAgeSeconds = 300) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader(
    'Cache-Control',
    maxAgeSeconds > 0
      ? `public, max-age=${maxAgeSeconds}, stale-while-revalidate=60`
      : 'no-store'
  );
  return res.json(data);
}

// ─── Manifest ─────────────────────────────────────────────────────────────────

const MANIFEST = {
  id:          'stremio.deportes',
  version:     '1.0.0',
  name:        'Deportes en Vivo',
  description: 'Canales de deportes en vivo. Links actualizados automáticamente cada 3 horas.',
  logo:        'https://upload.wikimedia.org/wikipedia/commons/1/1d/FIA_F1_Imola_2025_No._43_Colapinto_%282%29.jpg',
  types:       ['tv'],
  catalogs: [
    {
      type: 'tv',
      id:   'deportes-live',
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
  behaviorHints: { configurable: false }
};

// ─── Rutas ────────────────────────────────────────────────────────────────────

app.get('/manifest.json', (_, res) => respond(res, MANIFEST, 3600));

/**
 * Construye el objeto meta de Stremio a partir de un canal.
 * @param {object} ch
 * @returns {object}
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
app.get('/catalog/tv/deportes-live.json', async (_, res) => {
  const channels = await getChannels();
  respond(res, { metas: channels.map(buildMeta) });
});

// Catálogo filtrado por género
app.get('/catalog/tv/deportes-live/genre=:genre.json', async (req, res) => {
  const channels = await getChannels();
  const genre    = decodeURIComponent(req.params.genre);
  respond(res, { metas: channels.filter(ch => (ch.genres || []).includes(genre)).map(buildMeta) });
});

// Catálogo con búsqueda
app.get('/catalog/tv/deportes-live/search=:query.json', async (req, res) => {
  const channels = await getChannels();
  const query    = decodeURIComponent(req.params.query).toLowerCase();
  respond(res, {
    metas: channels
      .filter(ch => ch.name.toLowerCase().includes(query) || (ch.description || '').toLowerCase().includes(query))
      .map(buildMeta)
  });
});

// Meta individual
app.get('/meta/tv/:id.json', async (req, res) => {
  const channels = await getChannels();
  const ch = channels.find(c => c.id === req.params.id.replace(/^deportes-/, ''));
  if (!ch) return res.status(404).json({ err: 'no encontrado' });
  respond(res, { meta: buildMeta(ch) }, 300);
});

/**
 * Stream de un canal — sin caché HTTP.
 * Itera streams[], filtra entradas con url vacía, y aplica headers si están definidos.
 * El slot streams[0] con label "HD (auto)" es escrito por el updater con la URL fresca.
 */
app.get('/stream/tv/:id.json', async (req, res) => {
  const channels = await getChannels();
  const ch = channels.find(c => c.id === req.params.id.replace(/^deportes-/, ''));

  if (!ch) return respond(res, { streams: [] }, 0);

  const streams = (ch.streams || [])
    .filter(s => s.url)
    .map(s => {
      const stream = {
        title:         s.label || ch.name,
        url:           s.url,
        behaviorHints: { notWebReady: false }
      };
      if (s.headers && typeof s.headers === 'object') {
        stream.behaviorHints.proxyHeaders = { request: s.headers };
      }
      return stream;
    });

  respond(res, { streams }, 0);
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

/** Exportar para Vercel (serverless handler) */
module.exports = (req, res) => app(req, res);

/** Arranque local: node api/index.js */
if (require.main === module) {
  const PORT = process.env.PORT || 7001;
  app.listen(PORT, () => console.log(`\n🟢 Addon en http://localhost:${PORT}/manifest.json\n`));
}
