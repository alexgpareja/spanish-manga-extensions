# Contexto: Extensiones Paperback iOS — Estado actual

## Repo
- **Local**: `/Users/alex/Claude/spanish-manga-extensions`
- **GitHub**: `https://github.com/alexgpareja/spanish-manga-extensions`
- **GitHub Pages**: `https://alexgpareja.github.io/spanish-manga-extensions/`
- Pages configurado: Branch `main`, Folder `/docs`

## Workflow de desarrollo
```bash
cd /Users/alex/Claude/spanish-manga-extensions
npx paperback bundle        # compila → genera bundles/
rm -rf docs && mv bundles docs
git add -A && git commit -m "mensaje" && git push
```
Se commitea y pushea directo a `main` (sin PRs), salvo que se pida explícitamente lo contrario.

## Convención: fechas reales de capítulos

**Regla**: `getChapters()` siempre debe rellenar `time` con la fecha real de publicación cuando el sitio la exponga, no dejarlo `undefined`. Si `time` no se pasa a `App.createChapter()`, Paperback lo interpreta como "ahora" y muestra "in 0 seconds" / "hace 0 segundos" en TODOS los capítulos — es un bug fácil de introducir sin darse cuenta al añadir una extensión nueva.

Al implementar `getChapters` en una extensión nueva:
1. Busca en el HTML/API una fecha de publicación por capítulo (nombres típicos: `publishAt`, `RegistrationDate`, `createdAt`, un `<span>` con texto de fecha tipo "27 Jun 2026", un atributo `datetime`).
2. Parséala con `new Date(...)` y valida con `!isNaN(d.getTime())` antes de usarla.
3. Solo omite `time` si el sitio genuinamente no expone ninguna fecha para ese capítulo (ver caso TmoManhwa abajo) — eso es aceptable, no es un bug.

## Extensiones en el repo actualmente

### ✅ TmoManhwa (`src/TmoManhwa/`) — v1.0.0
- URL: `https://tmomanhwa.com`
- Sin Cloudflare
- Fechas: `getChapters` ya extrae `span.ct-update` (texto tipo "04 Jan 2026") y lo parsea con `new Date()`. **Ya usa fecha real — no tenía el bug.**
- Limitación conocida del sitio (no arreglable): los ~8-10 capítulos más recientes muestran una insignia `<img alt="NEW">` en vez de fecha, y no hay fecha real disponible en ningún sitio (ni listado ni página del capítulo) para esos casos. Se deja `time` sin definir ahí a propósito.
- Estado: funcional básico (no verificado en profundidad más allá de fechas)

### ✅ LectorXD (`src/LectorXD/`) — v1.0.2
- URL: `https://lectorxd.com`
- Cloudflare: SÍ — el usuario debe pulsar el bypass button en Paperback antes de usar.
  - **El bypass apunta a `${BASE_URL}/manhwa/x`, NO a la home.** Las páginas de detalle (`/manhwa/*`, `/manga/*`...) tienen un challenge de Cloudflare más estricto que la home; bypassear solo la home no lo resolvía y dejaba `getChapters` recibiendo la pantalla de "Just a moment" en vez del HTML real (lista de capítulos vacía). Fix: commit `d8fe5b1`.
- Fechas: `getChapters` extrae las props del componente `<astro-island component-url="/_astro/ChapterList...">` (el sitio es Astro), que trae `publishAt` real por capítulo. Antes usaba solo `chaptersList = [...]` (sin fecha) → causaba el bug de "in 0 seconds". Fix: commit `fde1271`. Si el sitio cambia y ya no hay `ChapterList` island, cae a `chaptersList = [...]` como fallback (sin fecha, pero no rompe).
- Discover: 3 secciones — "📚 Catálogo" (`/api/catalog`, orden por fecha de alta), "🕒 Recientes" y "🔥 Populares" (ambas via `/catalogo?...` HTML, island `CatalogGrid`). **`/api/catalog` ignora el parámetro `orderBy` pase lo que se le pase** (siempre devuelve orden por `createdAt` desc) — solo `/catalogo?orderBy=views&...` lo respeta server-side (comprobado: `initialMangas` viene correctamente ordenado por `views` desc). Por eso "Populares" usa `fetchCatalogPage` (lee el HTML de `/catalogo`, más pesado que la API JSON) en vez de `fetchCatalog`. Ninguna de las dos rutas necesita Cloudflare bypass. Fix: commit `3f6374b`.
- Estado: **funcional** (bugs de imágenes lazy-load, Cloudflare bypass, fechas y discover ya resueltos)
- Nota para el futuro: las props del `ChapterList` island también traen las páginas/imágenes de cada capítulo (`pages: ["/4119/96/1.webp", ...]`) — podría eliminarse la petición extra a `/leer/{chapterId}` en `getChapterDetails` reusando estos datos, pero no se ha hecho aún.

### ✅ InManga (`src/InManga/`) — v1.0.0
- URL: `https://inmanga.com`
- `SourceIntents.CLOUDFLARE_BYPASS_REQUIRED` declarado, pero en pruebas con `curl` la home, el catálogo (`POST /manga/getMangasConsultResult`) y `GET /chapter/getall?mangaIdentification=...` respondieron 200 sin bloqueo — no se ha confirmado si el bypass hace falta para otros endpoints (p.ej. `chapterIndexControls`, lectura de páginas).
- Fechas: `getChapters` ya usa `RegistrationDate` de la API (`GET /chapter/getall`), formato ISO tipo `"2016-08-29T00:00:00"`, parseado y validado correctamente. **Ya usa fecha real — no tenía el bug.**
- Estado: parcialmente verificado (catálogo, capítulos y fechas confirmados funcionando vía curl; lectura de páginas del capítulo no verificada end-to-end)

## API de LectorXD (verificada)
| Endpoint | Cloudflare | Uso |
|---|---|---|
| `/api/catalog?page=N` | ❌ No | Listado de manga — funciona siempre |
| `/api/catalog?search=QUERY&page=N` | ❌ No | Búsqueda — funciona siempre |
| `/manhwa/{slug}` | ✅ Sí (challenge estricto propio) | Detalle + chapters — necesita bypass apuntado a una ruta `/manhwa/*` |
| `/manhwa/{slug}/leer/{N}` | ✅ Sí | Lector — necesita bypass |
| `s1.cdnlxd.xyz/{numId}/{chapNum}/{page}.jpg` | ❌ No | Imágenes CDN — funcionan siempre |

**mangaId interno**: `{type}/{slug}` ej: `manhwa/tomb-raider-king`
**chapterId**: número del capítulo como string ej: `"37"`, `"411.5"`

**getChapters**: Extrae las props del `<astro-island component-url="/_astro/ChapterList...">` (JSON con `chapter`, `publishAt`, etc., serializado por Astro como `[tag, valor]`). Fallback: `chaptersList = [...]` del HTML con contador de brackets (no regex, que falla con +400 capítulos), sin fecha.

**getMangaDetails**: Usa `/api/catalog?search={slug con espacios}&page=1` para obtener descripción, géneros y estado sin necesitar Cloudflare. Hace match por `m.slug === slug`.

**getChapterDetails**: Busca `img.page-image` con `data-src` (lazy) y `src` (preloaded), priorizando siempre `data-src`. CDN: `s1/s2.cdnlxd.xyz`.

## API Paperback 0.8 — Referencia rápida
```typescript
// Estructura mínima
export class MiExtension implements
    SearchResultsProviding, MangaProviding, ChapterProviding,
    HomePageSectionsProviding, CloudflareBypassRequestProviding
{
    constructor(private cheerio: CheerioAPI) {}
    RETRIES = 3
    requestManager = App.createRequestManager({ requestsPerSecond: 3, requestTimeout: 20000 })
}
```

### Métodos que Paperback llama
- `getMangaDetails(mangaId)` → `App.createSourceManga({ id, mangaInfo: App.createMangaInfo({image, titles, desc, status:string, tags?, hentai?}) })`
- `getChapters(mangaId)` → `App.createChapter({ id, chapNum, name?, langCode?, time? })` — **sin mangaId**. Rellenar `time` con fecha real cuando exista (ver convención arriba).
- `getChapterDetails(mangaId, chapterId)` → `App.createChapterDetails({ id, mangaId, pages:string[] })`
- `getSearchResults(query, metadata)` → `App.createPagedResults({ results: PartialSourceManga[], metadata? })`
- `getSearchTags()` → `TagSection[]`
- `getHomePageSections(sectionCallback)` → void
- `getViewMoreItems(sectionId, metadata)` → `PagedResults`
- `getCloudflareBypassRequestAsync()` → `Request` — apuntar a la ruta que realmente está protegida (no asumir que la home basta; verificar si las páginas de detalle tienen un challenge distinto/más estricto, como pasó en LectorXD).

### HTTP
```typescript
const resp = await this.requestManager.schedule(
    App.createRequest({ url: '...', method: 'GET' }), this.RETRIES
)
const $ = this.cheerio.load(resp.data)
// O para JSON:
const data = JSON.parse(resp.data)
```

### Errores comunes
- `extends Source` → ❌ usar `implements` las interfaces
- Sin `constructor(private cheerio: CheerioAPI) {}` → ❌ crash silencioso
- `App.createMangaTile()` → ❌ no existe, usar `App.createPartialSourceManga({mangaId, image, title})`
- `status: MangaStatus.ONGOING` → ❌ usar string `'Ongoing'`
- `getTags()` → ❌ usar `getSearchTags()`
- Omitir `time` en `App.createChapter()` cuando el sitio sí tiene fecha → ❌ Paperback muestra "in 0 seconds" en todos los capítulos

## Siguientes pasos sugeridos
1. Verificar InManga end-to-end (lectura real de páginas de un capítulo, y si `chapterIndexControls` necesita el bypass de Cloudflare)
2. **Paperback 0.9**: El equipo de Inkdex ofreció acceso beta. La nueva API es muy diferente (`pbconfig.ts`, `getDiscoverSections`, `getChapterDetails` recibe el Chapter objeto entero, etc.)
3. **Más fuentes**: Lectormanga, OlympusXYZ son candidatos sin Cloudflare pesado
4. Posible mejora futura en LectorXD: reusar las `pages` que ya vienen en las props del `ChapterList` island para evitar la petición extra en `getChapterDetails`

## Otras fuentes investigadas (no implementadas)
- **LectorTMOo** (`lectortmoo.com`): Cloudflare tipo 403 — bypass funciona. HTML tiene lista de capítulos en `ul.chapter-list`. Capítulos: `/{slug}-capitulo-{N}/`
- **KuManga** (`kumanga.com`): Cloudflare Managed Challenge — TLS fingerprint bloquea requestManager incluso con bypass. Abandonado.
- **TuMangaOnline**: Caído por operación policial española (abril 2026)
