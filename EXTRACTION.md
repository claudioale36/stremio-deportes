# Método de extracción de streams HLS/DASH sin Puppeteer

Documentación del proceso de investigación e implementación para extraer URLs `.m3u8` / `.mpd`
de sitios de streaming deportivo, sin browser headless ni scraping complejo.

Reusable en cualquier proyecto que necesite obtener streams dinámicos.

---

## Conceptos clave

| Término | Descripción |
|---|---|
| **HLS** | HTTP Live Streaming — playlist `.m3u8`, estándar Apple |
| **DASH** | Dynamic Adaptive Streaming — manifiesto `.mpd`, estándar ISO |
| **Token** | Parámetro en la URL que expira (ej: `?token=abc123-timestamp`) |
| **iframe-chain** | Patrón donde la página wrapper embebe el player real en un `<iframe>` |
| **SSR** | Server-Side Rendering — el servidor incluye la URL en el HTML inicial |
| **CSR** | Client-Side Rendering — JS genera la URL en el browser (requiere ejecución) |

---

## Paso 1 — Clasificar el sitio

Antes de escribir código, identificar qué tipo de extracción es posible.

### 1.1 — ¿El `.m3u8` está en el HTML inicial?

```bash
curl -s \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  -H "Accept: text/html,application/xhtml+xml" \
  "https://SITIO/pagina-del-canal/" \
  | grep -o 'https://[^"'\'']*\.m3u8[^"'\'']*'
```

**Resultado vacío** → la URL la genera JavaScript. Continuar al paso 1.2.  
**Resultado con URL** → extracción directa (Tipo A). Ir al paso 3.

### 1.2 — ¿Qué JavaScript carga la página?

```bash
# Listar scripts externos
curl -s \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://SITIO/pagina-del-canal/" \
  | grep -o 'src="[^"]*\.js[^"]*"'

# Ver si hay referencias al stream en el HTML
curl -s \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://SITIO/pagina-del-canal/" \
  | grep -i 'm3u8\|stream\|iframe\|source\|file\|token' -A 2 -B 2
```

### 1.3 — ¿Hay un iframe con un player externo?

```bash
curl -s \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  "https://SITIO/pagina-del-canal/" \
  | grep -o '<iframe[^>]*src="[^"]*"'
```

**Si hay iframe** → el sitio es un wrapper. El player real está en la URL del iframe.  
Repetir el proceso de investigación con esa URL (paso 1.1 con la URL del iframe).

---

## Paso 2 — Leer el JS relevante

Si el `.m3u8` no está en el HTML pero la URL del iframe sí, leer el JS de la página que genera la URL:

```bash
curl -s \
  -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
  -H "Referer: https://SITIO/pagina-del-canal/" \
  "https://SITIO/js/script.js"
```

### Qué buscar en el JS

**Patrón A — Variable con URL directa:**
```javascript
var streamUrl = "https://cdn.ejemplo.com/canal.m3u8?token=...";
```
→ La URL está hardcodeada en el JS. Extraer con regex del `.js`.

**Patrón B — Fetch a una API:**
```javascript
fetch('https://api.ejemplo.com/stream?canal=foxsports')
  .then(r => r.json())
  .then(data => player.load(data.url));
```
→ Replicar ese fetch desde el servidor. No necesita browser.

**Patrón C — Iframe con parámetro:**
```html
<iframe src="https://player.ejemplo.com/embed?stream=foxsports">
```
→ Patrón **iframe-chain**: extraer `src` del iframe, luego hacer fetch al player.

**Patrón D — JS con lógica compleja (tokens locales, WebCrypto, obfuscado):**
→ Necesita Puppeteer/Playwright. Ver sección "Cuándo sí se necesita browser".

---

## Paso 3 — Implementar el extractor

### Tipo A — m3u8 en el HTML directo

```javascript
/**
 * Extrae URL .m3u8 o .mpd directamente del HTML de la página.
 * Útil para sitios SSR que incluyen el stream en el HTML inicial.
 * @param {string} pageUrl - URL de la página del canal
 * @param {object} headers - Headers HTTP adicionales (Referer, etc.)
 * @returns {Promise<string|null>} URL del stream o null si no se encontró
 */
async function extractFromHtml(pageUrl, headers = {}) {
  const res = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      ...headers
    }
  });
  const html = await res.text();

  // Regex que captura URLs .m3u8 o .mpd dentro de atributos HTML o JS inline
  const match = html.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd)[^\s"'<>]*/i);
  return match ? match[0] : null;
}
```

### Tipo B — fetch a una API conocida

```javascript
/**
 * Replica una llamada a la API interna del sitio que devuelve el stream.
 * Requiere haber identificado el endpoint y parámetros en el Network tab.
 * @param {string} apiUrl     - URL de la API interna
 * @param {string} streamPath - Ruta JSON donde está la URL (ej: "data.stream.url")
 * @param {object} headers    - Headers requeridos por la API
 * @returns {Promise<string|null>} URL del stream o null
 */
async function extractFromApi(apiUrl, streamPath, headers = {}) {
  const res = await fetch(apiUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...headers
    }
  });
  const data = await res.json();

  // Navegar el path anidado: "data.stream.url" → data["data"]["stream"]["url"]
  return streamPath.split('.').reduce((obj, key) => obj?.[key], data) ?? null;
}
```

### Tipo C — iframe-chain (patrón detectado en futbollibre.mom)

```javascript
/**
 * Patrón iframe-chain: extrae la URL del iframe de la página wrapper,
 * luego busca el .m3u8 en la página del player embebido.
 *
 * Ejemplo de cadena:
 *   futbollibre.mom/canal/fox-sports/
 *     → <iframe src="https://tvf90.com/1.php?stream=foxsports">
 *       → .m3u8 en el HTML del player
 *
 * @param {string} wrapperUrl    - URL de la página que contiene el iframe
 * @param {RegExp} iframePattern - Regex para filtrar el iframe correcto (si hay varios)
 * @returns {Promise<string|null>} URL del stream o null
 */
async function extractIframeChain(wrapperUrl, iframePattern = null) {
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml'
  };

  // Paso 1: Obtener HTML de la página wrapper
  const wrapperRes = await fetch(wrapperUrl, { headers: baseHeaders });
  const wrapperHtml = await wrapperRes.text();

  // Paso 2: Extraer src del iframe
  const iframeMatches = [...wrapperHtml.matchAll(/<iframe[^>]+src="([^"]+)"/gi)];
  const iframeMatch = iframePattern
    ? iframeMatches.find(m => iframePattern.test(m[1]))
    : iframeMatches[0];

  if (!iframeMatch) return null;
  const iframeSrc = iframeMatch[1];

  // Paso 3: Fetch al player real, usando la página wrapper como Referer
  const playerRes = await fetch(iframeSrc, {
    headers: {
      ...baseHeaders,
      'Referer': wrapperUrl,
      'Origin': new URL(wrapperUrl).origin
    }
  });
  const playerHtml = await playerRes.text();

  // Paso 4: Extraer .m3u8 o .mpd del HTML del player
  const streamMatch = playerHtml.match(/https?:\/\/[^\s"'<>]+\.(?:m3u8|mpd)[^\s"'<>]*/i);
  return streamMatch ? streamMatch[0] : null;
}
```

---

## Paso 4 — Integración con el addon de Stremio

### Estructura del `streams.json`

```jsonc
{
  "channels": [
    {
      "id": "fox-sports",
      "name": "Fox Sports HD",
      "logo": "https://...",
      "genres": ["Fútbol", "Deportes"],

      // Extractor dinámico — el addon obtiene la URL fresca en cada request
      "extractor": {
        "type": "iframe-chain",         // Tipo A | B | C según lo investigado
        "url": "https://futbollibre.mom/canal/fox-sports/",
        "iframePattern": "tvf90",       // Solo para tipo C — filtrar el iframe correcto
        "headers": {                    // Opcional — headers adicionales
          "Referer": "https://futbollibre.mom/"
        },
        "cacheTTL": 1800                // Segundos — 30 min por defecto
      }

      // Canales sin extractor usan el array streams[] estático como fallback
    },
    {
      "id": "canal-estatico",
      "name": "Canal con URL fija",
      "streams": [
        { "url": "https://cdn.ejemplo.com/canal.m3u8", "label": "HD" }
      ]
    }
  ]
}
```

### TTL de caché recomendado por tipo de token

| Patrón de token | TTL sugerido |
|---|---|
| Sin token (URL fija) | No cachear / ∞ |
| Token con timestamp, TTL ~5h | 30 min |
| Token con TTL ~1h | 20 min |
| Token con TTL ~15min | 5 min |

Para identificar el TTL del token, comparar los dos timestamps al final:
```
?token=abc123-a7-1791777116-1791759116
                  ^^^^^^^^^^  ^^^^^^^^^^
                  expiry      creacion
  TTL = 1791777116 - 1791759116 = 18000 seg = 5 horas
```

---

## Cuándo sí se necesita browser headless (Puppeteer/Playwright)

Usar Puppeteer solo cuando:

- El JS ejecuta **WebCrypto** o lógica de firma local para generar el token
- El JS está **ofuscado** (obfuscator.io, javascript-obfuscator) y no es legible
- El stream requiere que el browser complete un **captcha** o challenge de JS
- La URL se genera solo **después de interacción del usuario** (click en play)

En esos casos, el addon no puede correr en Vercel (límite de 50MB por función).
Alternativas: Docker propio, Railway, o Render.

---

## Árbol de decisión resumido

```
¿Aparece .m3u8 en el HTML (curl)?
  ├─ SÍ → Tipo A (extractFromHtml) → Vercel ✅
  └─ NO
      ├─ ¿Hay iframe con player externo?
      │    └─ SÍ → Tipo C (extractIframeChain)
      │              ├─ ¿El player tiene .m3u8 en su HTML? → Vercel ✅
      │              └─ NO → seguir investigando el player
      ├─ ¿Hay fetch a una API identificable en Network/XHR?
      │    └─ SÍ → Tipo B (extractFromApi) → Vercel ✅
      └─ JS ofuscado / WebCrypto / captcha → Puppeteer → Docker ⚠️
```

---

## Casos documentados

| Sitio | Patrón | Tipo | Notas |
|---|---|---|---|
| `futbollibre.mom` | iframe → `tvf90.com/1.php` | C (iframe-chain) | iframe src en HTML estático ✅ |
| `tvf90.com/1.php` | iframe → `tvf90.com/6.php` | C (iframe-chain) | Solo lógica de ads/geo, stream en siguiente nivel |
| `tvf90.com/6.php` | ??? → `fubo18.com/*.m3u8` | pendiente investigar | Nivel final probable |

### Cadena completa detectada en `futbollibre.mom/canal/fox-sports/`

```
futbollibre.mom/canal/fox-sports/            ← Wrapper principal (HTML estático)
  iframe src → tvf90.com/1.php?stream=foxsports
                 └─ JS: solo ads + detección geo (GEO_URL, COUNTRY_LINKS)
                 iframe src → tvf90.com/6.php?stream=foxsports
                               └─ ??? (pendiente)
                                    └─ am91cm5leq.fubo18.com/foxsports/mono.m3u8?token=...
```

**Patrón reconocible:** sitios que usan capas de iframes para separar ads de player.
La capa de ads (1.php) siempre contiene `GEO_URL`, `COUNTRY_LINKS`, `trkr.ppof.net` — ignorar.
El player real está siempre en la siguiente capa (`6.php` o similar).
