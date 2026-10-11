# Stremio — Deportes en Vivo

Addon de Stremio para reproducir streams `.m3u8` y `.mpd` de deportes en vivo.

**Sin backend propio.** Los canales se definen en `streams.json` (este repo).  
El addon corre como función serverless en Vercel y fetchea el JSON desde GitHub en cada request.

---

## Flujo de uso

```
📱 Teléfono / PC
  → Encontrás un stream .m3u8
  → Editás streams.json desde github.com (botón ✏️ Edit)
  → Commit directo a main

📺 AndroidTV (Stremio)
  → Abrís el addon "Deportes en Vivo"
  → El addon fetchea streams.json actualizado (caché máx. 5 min)
  → Reproducís el stream
```

---

## Despliegue en Vercel

### 1. Crear repo en GitHub

```bash
git init
git remote add origin https://github.com/USUARIO/stremio-deportes.git
git add .
git commit -m "init"
git push -u origin main
```

### 2. Desplegar en Vercel

- Entrá a [vercel.com](https://vercel.com) → Import Project → seleccioná el repo
- En **Environment Variables** agregá:

| Variable | Valor |
|----------|-------|
| `STREAMS_JSON_URL` | `https://raw.githubusercontent.com/USUARIO/stremio-deportes/main/streams.json` |

- Deploy → Vercel te da una URL pública: `https://stremio-deportes.vercel.app`

### 3. Instalar el addon en Stremio

En Stremio → Addons → opción "Add addon URL":

```
https://stremio-deportes.vercel.app/manifest.json
```

---

## Editar canales desde el teléfono

1. Abrís `github.com/USUARIO/stremio-deportes` en el navegador del teléfono
2. Tocás `streams.json`
3. Tocás el ícono ✏️ (Edit this file)
4. Editás las URLs y campos que necesites
5. Tocás **Commit changes** → directo a main

Los cambios se reflejan en Stremio en máximo **5 minutos** (TTL del caché).

---

## Estructura de `streams.json`

```json
{
  "channels": [
    {
      "id":          "id-unico",          // único por canal, sin espacios
      "name":        "Nombre del Canal",
      "description": "Descripción breve",
      "logo":        "https://url-imagen.png",   // opcional
      "background":  "https://url-fondo.png",    // opcional
      "genres":      ["Fútbol", "Deportes"],     // opcional, para filtrar
      "streams": [
        {
          "url":   "https://ejemplo.com/stream.m3u8",
          "label": "HD 1080p",            // texto que aparece en Stremio
          "headers": {                    // opcional — para streams con autenticación
            "Referer":    "https://origen.com/",
            "User-Agent": "Mozilla/5.0 ..."
          }
        }
      ]
    }
  ]
}
```

> **Múltiples streams por canal**: agregá más objetos al array `streams` del canal.  
> Stremio los mostrará como opciones alternativas de calidad.

---

## Desarrollo local

```bash
npm install
npm run dev
# Addon disponible en http://localhost:7001/manifest.json
```
