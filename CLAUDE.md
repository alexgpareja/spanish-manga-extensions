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
- Discover: 3 secciones — "🕒 Recientes" (`.latest-list`, real, con paginación vía `/biblioteca/page/{N}/`), "🆕 Nuevas Obras" (`.trending-block.recently-items`, real, sin paginación — el widget de la home solo trae 9-10), "📚 Catálogo" (`/biblioteca/`). **No hay sección "Populares"**: no existe ranking por vistas en ningún sitio del site (ni en la home, ni un `?orderby=` en `/biblioteca/`, ni una página `/ranking` o similar) — comprobado explícitamente, no se inventó. Antes "Recientes" y "Biblioteca completa" salían de cortar en dos mitades arbitrarias la misma lista de tiles de la home (mezclaba capítulos recientes con obras nuevas sin darse cuenta) — bug corregido escaneando cada contenedor por separado (`parseTiles($, scope)`). Fix: commit `2980150`.
- Géneros (`getSearchTags`): **el filtro SÍ funciona de verdad** (`/genero/{slug}/` devuelve listados genuinamente distintos por género — comprobado comparando `accion` vs `romance` vs `boys-love`, etc., cero o poco solapamiento), pero está **oculto**: ningún sitio de la web (ni nav, ni páginas de manga) enlaza a `/genero/*` — solo funciona si conoces la URL. Se quitó "gore" de la lista hardcodeada de 20 géneros porque esa ruta da 404 (no existe en el sitio); quedan 19. Fix: commit `67ede54`.
- Estado: funcional básico (no verificado en profundidad más allá de fechas y discover)

### ✅ LectorXD (`src/LectorXD/`) — v1.0.2
- URL: `https://lectorxd.com`
- Cloudflare: SÍ — el usuario debe pulsar el bypass button en Paperback antes de usar.
  - **El bypass apunta a `${BASE_URL}/manhwa/x`, NO a la home.** Las páginas de detalle (`/manhwa/*`, `/manga/*`...) tienen un challenge de Cloudflare más estricto que la home; bypassear solo la home no lo resolvía y dejaba `getChapters` recibiendo la pantalla de "Just a moment" en vez del HTML real (lista de capítulos vacía). Fix: commit `d8fe5b1`.
- Fechas: `getChapters` extrae las props del componente `<astro-island component-url="/_astro/ChapterList...">` (el sitio es Astro), que trae `publishAt` real por capítulo. Antes usaba solo `chaptersList = [...]` (sin fecha) → causaba el bug de "in 0 seconds". Fix: commit `fde1271`. Si el sitio cambia y ya no hay `ChapterList` island, cae a `chaptersList = [...]` como fallback (sin fecha, pero no rompe).
- Discover: 3 secciones, orden **Recientes → Populares → Catálogo** — "🕒 Recientes" y "🔥 Populares" via `/catalogo?...` HTML (island `CatalogGrid`), "📚 Catálogo" via `/api/catalog` (orden por fecha de alta). **`/api/catalog` ignora el parámetro `orderBy` pase lo que se le pase** (siempre devuelve orden por `createdAt` desc) — solo `/catalogo?orderBy=views&...` lo respeta server-side (comprobado: `initialMangas` viene correctamente ordenado por `views` desc). Por eso "Populares" usa `fetchCatalogPage` (lee el HTML de `/catalogo`, más pesado que la API JSON) en vez de `fetchCatalog`. Ninguna de las dos rutas necesita Cloudflare bypass. Fix: commits `3f6374b`, orden `2980150`.
- Estado: **funcional** (bugs de imágenes lazy-load, Cloudflare bypass, fechas y discover ya resueltos)
- Nota para el futuro: las props del `ChapterList` island también traen las páginas/imágenes de cada capítulo (`pages: ["/4119/96/1.webp", ...]`) — podría eliminarse la petición extra a `/leer/{chapterId}` en `getChapterDetails` reusando estos datos, pero no se ha hecho aún.

### ✅ InManga (`src/InManga/`) — v1.0.0
- URL: `https://inmanga.com`
- `SourceIntents.CLOUDFLARE_BYPASS_REQUIRED` declarado, pero en pruebas con `curl` la home, el catálogo (`POST /manga/getMangasConsultResult`) y `GET /chapter/getall?mangaIdentification=...` respondieron 200 sin bloqueo — no se ha confirmado si el bypass hace falta para otros endpoints (p.ej. `chapterIndexControls`, lectura de páginas).
- Fechas: `getChapters` ya usa `RegistrationDate` de la API (`GET /chapter/getall`), formato ISO tipo `"2016-08-29T00:00:00"`, parseado y validado correctamente. **Ya usa fecha real — no tenía el bug.**
- Discover: 3 secciones, orden **Recientes → Populares → Catálogo**. "🕒 Recientes" y "🔥 Populares" salen de los widgets reales de la home (`GET /chapter/getRecentChapters` — necesita header `X-Requested-With: XMLHttpRequest` o da 404 —, `GET /manga/getMostViewedMangas`), ambos devuelven HTML parcial (no JSON) sin paginación real (siempre el mismo puñado fijo, `containsMoreItems: false`). `getRecentChapters` es a nivel de capítulo (`/ver/manga/{slug}/{chapNum}/{chapUuid}`, el UUID del manga sale de la imagen `i/m/{mangaUuid}/t/o/...`, no del href) — se deduplica por manga quedándose con el capítulo más reciente de cada uno (`parseRecentChapterMangas`). Ninguno de los dos necesita Cloudflare bypass (confirmado con curl plano). Fix: commit `2980150`.
- **Géneros: NO implementados a propósito.** El sitio tiene 56 checkboxes de género reales en `/manga/consult` (ids 33-88, ver lista completa más abajo), pero el filtro está **roto en el propio sitio**: probado con clic real en la web (checkbox "Yuri", id 52) y también replicando la llamada AJAX exacta que usa su propio JS (`POST /manga/getMangasConsultResult` con `filter.generes: [52]`) — en ambos casos devuelve siempre el mismo top de populares (One Piece, Boku no Hero Academia, Kimetsu no Yaiba...) sin importar el género. Añadir `getSearchTags()` aquí reproduciría el mismo bug que tenía TmoManhwa (seleccionar cualquier género muestra todo) — decisión explícita del usuario de no añadirlo mientras esto siga roto.
- Estado: parcialmente verificado (catálogo, capítulos, fechas y discover confirmados funcionando vía curl/browser; lectura de páginas del capítulo no verificada end-to-end)

### 🆕 OlympusXYZ (`src/OlympusXYZ/`) — v1.0.0
- URL: `https://olympusxyz.com` · API: `https://panel.olympusxyz.com`
- Sin Cloudflare en las páginas de lectura (detalle, capítulo, home, `/series`, `/capitulos`) — confirmado con `curl` plano repetidamente.
- **mangaId**: `{type}/{slug}` con `type` = `comic` o `novela` (ej. `comic/el-legendario-prodigio-del-ducado`). La URL real junta ambos con un guion: `/series/{type}-{slug}`.
- **getChapters**: API pública y sin firma `GET panel.olympusxyz.com/api/series/{slug}/chapters?page=N&direction=desc&type={type}` — JSON limpio con `published_at` real (ISO) por capítulo, paginación estándar Laravel (`meta.last_page`). Mucho mejor que scrapear HTML.
- **getChapterDetails**: imágenes directas en `media.imagesolymp.xyz/comics/{seriesId}/{chapterId}/{page}.webp`, sin proxy ni token — filtra `img[src*="/comics/"]` excluyendo `/comics/covers/` (esas son portadas de "series similares" en la misma página).
- **getMangaDetails**: título/portada/sinopsis vía meta tags (`og:title` con sufijo `" | Olympus Scanlation"` a quitar). Estado y géneros **no están en el HTML como texto plano** — hay que resolver el bloque `<script id="__NUXT_DATA__">` (formato "devalue" de Nuxt 3: un array plano donde los campos de un objeto son índices a otras posiciones del array, no valores directos). Función `extractNuxtSeriesFieldMap` hace el resolver mínimo necesario (título/status/genres), no un deserializador genérico.
- **Discover**: 3 secciones reales sacadas de la home (`Nuevos Lanzamientos` → 🕒 Recientes, `Popular Del Dia` → 🔥 Populares, `Top Series` → 📚 catálogo), todas SSR y sin Cloudflare. Ninguna pagina (son widgets fijos de la home), `containsMoreItems: false`.
- **Búsqueda: limitada a propósito.** El catálogo/búsqueda real del sitio (`panel.olympusxyz.com/api/series` sin el sub-path `/chapters`, tanto listado como `?search=`) **sí está detrás de Cloudflare** (403 por curl) — a diferencia del endpoint de capítulos, que no lo está. No hay página de búsqueda por URL (`/buscar`, `/search` → 404) ni parámetro de paginación que funcione en `/series` (`?page=2` → 404; la paginación real del catálogo depende del mismo API bloqueado). `getSearchResults` filtra por substring de título dentro de un pool combinado de la home + `/series` (unas 60 series de las ~862 totales) — decisión explícita del usuario de implementar así en vez de descartar la fuente entera.
- Estado: verificado con datos reales (curl + cheerio en Node) para las 5 funciones antes de desplegar; no probado end-to-end en Paperback todavía.

**Géneros de InManga (id → label)**, extraídos de `/manga/consult` — por si algún día se arregla el filtro y se quiere implementar `getSearchTags()`:
`33 Aventura, 34 Shounen, 35 Suspenso, 36 Misterio, 37 Acción, 38 Fantasía, 39 Gore, 40 Sobrenatural, 41 Romance, 42 Drama, 43 Artes Marciales, 44 Ciencia Ficción, 45 Thriller, 46 Comedia, 47 Mecha, 48 Supernatural, 49 Tragedia, 50 Adulto, 51 Harem, 52 Yuri, 53 Seinen, 54 Horror, 55 Webtoon, 56 Apocalíptico, 57 Boys Love, 58 Ciberpunk, 59 Crimen, 60 Demonios, 61 Deporte, 62 Ecchi, 63 Extranjero, 64 Familia, 65 Fantasia, 66 Género Bender, 67 Girls Love, 68 Guerra, 69 Historia, 70 Magia, 71 Militar, 72 Musica, 73 Parodia, 74 Policiaco, 75 Psicológico, 76 Realidad, 77 Realidad Virtual, 78 Recuentos de la vida, 79 Reencarnación, 80 Samurái, 81 Superpoderes, 82 Supervivencia, 83 Vampiros, 84 Vida Escolar, 85 Cooking, 86 Shonen, 87 Shounen, 88 Deportes`
(nota: 34/86/87 = Shounen/Shonen/Shounen y 61/88 = Deporte/Deportes son duplicados reales del propio sitio, no error de transcripción; 38/65 = Fantasía/Fantasia también.)

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
- **YupManga** (`yupmanga.com`): Abandonado — bloqueo más serio que Cloudflare. Home/detalle vía navegador real pasan sin challenge visible, pero por HTTP plano (curl, y por tanto probablemente el `requestManager` de Paperback) dan 403 "Sorry, you have been blocked" (WAF, no un challenge resoluble). Y aunque eso se sorteara, **leer un capítulo exige resolver un proof-of-work JS propio del sitio**: `POST /ajax/get_challenge.php` devuelve un string de código JS (~1730 chars, distinto cada vez) que el cliente debe `eval`uar (`new Function(challenge_js)()`) para obtener una respuesta, que se envía a `/ajax/open_chapter.php` para conseguir el `token` real de `reader_v2.php?chapter=...&token=...`. Sin cuenta hay además límite de capítulos leídos (429 "Límite de lectura alcanzado"). El `requestManager` de Paperback no tiene motor JS/eval — no hay forma de resolver esto sin reimplementar/burlar su challenge, que es justamente el mecanismo anti-bot que el sitio puso para bloquear esto. Estructura del sitio (por si se reevalúa en el futuro): manga en `/series.php?id={id opaco}`, capítulos y fechas reales disponibles en JSON-LD embebido (`schema.org` `episode[].datePublished`), imágenes servidas vía `/image-proxy-v2.php?k={clave firmada}` (sin token no carga).
