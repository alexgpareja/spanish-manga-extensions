import {
    Chapter,
    ChapterDetails,
    ContentRating,
    HomeSection,
    HomeSectionType,
    PagedResults,
    PartialSourceManga,
    Request,
    SearchRequest,
    SourceInfo,
    SourceIntents,
    SourceManga,
    TagSection,
    BadgeColor,
    CloudflareBypassRequestProviding,
    HomePageSectionsProviding,
    MangaProviding,
    ChapterProviding,
    SearchResultsProviding,
} from '@paperback/types'

const BASE_URL = 'https://lectorxd.com'
const CDN_URL = 'https://s1.cdnlxd.xyz'

export const LectorXDInfo: SourceInfo = {
    version: '1.0.2',
    name: 'LectorXD',
    icon: 'icon.png',
    author: 'alexgpareja',
    description: 'LectorXD — Manga, Manhwa y Manhua en Español',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    language: 'es',
    sourceTags: [{ text: 'Español', type: BadgeColor.GREY }],
    intents: SourceIntents.MANGA_CHAPTERS
        | SourceIntents.HOMEPAGE_SECTIONS
        | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
}

function getSlug(mangaId: string): string { return mangaId.split('/').slice(1).join('/') }
function typeToPath(apiType: string): string {
    if (apiType === 'manhwa') return 'manhwa'
    if (apiType === 'manhua') return 'manhua'
    if (apiType === 'novela') return 'novela'
    return 'manga'
}
function coverUrl(slug: string): string { return `${CDN_URL}/manga/covers/${slug}.webp` }
function parseStatus(s: string): string {
    if (!s) return 'Unknown'
    if (s.includes('emision') || s.includes('curso') || s === 'en_emision') return 'Ongoing'
    if (s.includes('complet') || s.includes('finaliz')) return 'Completed'
    if (s.includes('cancel')) return 'Cancelled'
    if (s.includes('hiatus') || s.includes('pausa')) return 'Hiatus'
    return 'Unknown'
}

/**
 * Extrae un array JSON de un HTML buscando el marcador y contando brackets.
 * Mucho más robusto que regex para arrays grandes (411+ capítulos).
 */
function extractJsonArray(html: string, marker: string): any[] | null {
    const markerIdx = html.indexOf(marker)
    if (markerIdx === -1) return null
    const arrayStart = html.indexOf('[', markerIdx)
    if (arrayStart === -1) return null
    let depth = 0, endIdx = -1
    for (let i = arrayStart; i < html.length; i++) {
        if (html[i] === '[') depth++
        else if (html[i] === ']') { depth--; if (depth === 0) { endIdx = i; break } }
    }
    if (endIdx === -1) return null
    try { return JSON.parse(html.substring(arrayStart, endIdx + 1)) }
    catch { return null }
}

/**
 * Extrae las props (JSON) del <astro-island> cuyo component-url empieza por
 * `componentPrefix`. Trae datos que `chaptersList` no tiene, como `publishAt`.
 */
function extractAstroIslandProps(html: string, componentPrefix: string): any | null {
    const compIdx = html.indexOf(componentPrefix)
    if (compIdx === -1) return null
    const tagStart = html.lastIndexOf('<astro-island', compIdx)
    const tagEnd = html.indexOf('>', tagStart)
    if (tagStart === -1 || tagEnd === -1) return null
    const propsMatch = html.slice(tagStart, tagEnd).match(/props="([^"]*)"/)
    if (!propsMatch) return null
    const decoded = propsMatch[1]
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    try { return JSON.parse(decoded) } catch { return null }
}

// Astro serializa las props como [tag, valor]; solo nos interesa el valor.
function unwrap(x: any): any { return Array.isArray(x) && x.length === 2 && typeof x[0] === 'number' ? x[1] : x }

export class LectorXD implements
    SearchResultsProviding,
    MangaProviding,
    ChapterProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding {
    constructor(private cheerio: CheerioAPI) { }

    RETRIES = 3
    requestManager = App.createRequestManager({ requestsPerSecond: 3, requestTimeout: 20000 })

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        // Las páginas de detalle (/manhwa/*, /manga/*...) tienen un challenge de
        // Cloudflare más estricto que la home — bypassear solo BASE_URL no lo resuelve.
        return App.createRequest({ url: `${BASE_URL}/manhwa/x`, method: 'GET' })
    }
    getMangaShareUrl(mangaId: string): string { return `${BASE_URL}/${mangaId}` }

    // ── getMangaDetails ──────────────────────────────────────────────────────
    // Usa /api/catalog?search=TITULO para obtener desc, géneros y estado.

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const slug = getSlug(mangaId)
        const titleHint = slug.replace(/-/g, ' ')

        const apiResp = await this.requestManager.schedule(
            App.createRequest({
                url: `${BASE_URL}/api/catalog?search=${encodeURIComponent(titleHint)}&page=1`,
                method: 'GET',
                headers: { Referer: BASE_URL, Accept: 'application/json' },
            }), this.RETRIES
        )

        let manga: any = null
        try {
            const data = JSON.parse(apiResp.data)
            manga = (data.mangas ?? []).find((m: any) => m.slug === slug)
                ?? (data.mangas ?? [])[0]
        } catch { /* fallback */ }

        const title = manga?.title || slug.replace(/-/g, ' ')
        const desc = manga?.description || ''
        const image = manga?.coverImage || coverUrl(slug)
        const status = parseStatus(manga?.status ?? '')

        const tagItems: ReturnType<typeof App.createTag>[] = []
        const seen = new Set<string>()
        for (const t of (manga?.tags ?? [])) {
            const id = t.tag?.slug ?? String(t.tagId)
            const label = t.tag?.name ?? id
            if (!seen.has(id)) { seen.add(id); tagItems.push(App.createTag({ id, label })) }
        }
        const tags: TagSection[] = tagItems.length
            ? [App.createTagSection({ id: 'genres', label: 'Géneros', tags: tagItems })]
            : []

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({ image, titles: [title], desc, status, tags, hentai: false }),
        })
    }

    // ── getChapters ──────────────────────────────────────────────────────────
    // Primero intenta las props del componente ChapterList (trae `publishAt`).
    // Si el sitio cambia, cae a `chaptersList = [...]` (sin fecha real).

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url: `${BASE_URL}/${mangaId}`, method: 'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES
        )

        const seen = new Set<string>()

        const props = extractAstroIslandProps(resp.data, 'component-url="/_astro/ChapterList.')
        const entries = props?.chapters ? unwrap(props.chapters) : null
        if (Array.isArray(entries)) {
            return entries
                .map((e: any) => unwrap(e))
                .filter((c: any) => c?.chapter != null)
                .map((c: any) => ({ num: String(unwrap(c.chapter)), publishAt: c.publishAt ? unwrap(c.publishAt) : null }))
                .filter((c) => { if (seen.has(c.num)) return false; seen.add(c.num); return true })
                .map((c) => App.createChapter({
                    id: c.num, chapNum: parseFloat(c.num),
                    name: `Capítulo ${c.num}`, langCode: 'es',
                    time: c.publishAt ? new Date(c.publishAt) : undefined,
                }))
                .sort((a: Chapter, b: Chapter) => b.chapNum - a.chapNum)
        }

        const list = extractJsonArray(resp.data, 'chaptersList = [')
        if (!list) return []
        return list
            .filter((c: any) => { if (seen.has(c.chapter)) return false; seen.add(c.chapter); return true })
            .map((c: any) => App.createChapter({
                id: String(c.chapter), chapNum: parseFloat(c.chapter),
                name: `Capítulo ${c.chapter}`, langCode: 'es',
            }))
            .sort((a: Chapter, b: Chapter) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ────────────────────────────────────────────────────
    // Imágenes en img.page-image con src directo — NO data-src.

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url: `${BASE_URL}/${mangaId}/leer/${chapterId}`, method: 'GET',
                headers: { Referer: `${BASE_URL}/${mangaId}` },
            }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)
        const seen = new Set<string>()
        const pages: string[] = []

        // Primero: img.page-image con src directo
        $('img.page-image, img[class*="page-image"]').each((_: number, el: Element) => {
            const src = $(el).attr('data-src') || $(el).attr('src') || ''
            if (src.includes('cdnlxd') && !seen.has(src)) { seen.add(src); pages.push(src) }
        })

        // Fallback: cualquier img del CDN (src o data-src)
        if (pages.length === 0) {
            $('img').each((_: number, el: Element) => {
                const src = $(el).attr('data-src') ?? $(el).attr('src') ?? ''
                if (src.includes('cdnlxd') && !seen.has(src)) { seen.add(src); pages.push(src) }
            })
        }

        // Fallback 2: rutas relativas del CDN en el JSON embebido
        if (pages.length === 0) {
            const list = extractJsonArray(resp.data, '"pages":[')
            if (list) {
                for (const p of list) {
                    const path = typeof p === 'string' ? p : (p?.[1]?.[0] ?? '')
                    if (path) {
                        const url = path.startsWith('http') ? path : `${CDN_URL}${path}`
                        if (!seen.has(url)) { seen.add(url); pages.push(url) }
                    }
                }
            }
        }

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ──────────────────────────────────────────────────

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const s = App.createHomeSection({
            id: 'catalog', title: '📚 Catálogo',
            type: HomeSectionType.singleRowNormal, containsMoreItems: true,
        })
        sectionCallback(s)
        s.items = await this.fetchCatalog('', 1)
        sectionCallback(s)
    }

    async getViewMoreItems(_: string, metadata: any): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const tiles = await this.fetchCatalog('', page)
        return App.createPagedResults({
            results: tiles, metadata: tiles.length >= 24 ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchResults ─────────────────────────────────────────────────────

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const term = (query.title ?? '').trim()
        const page = metadata?.page ?? 1
        const tiles = await this.fetchCatalog(term, page)
        return App.createPagedResults({
            results: tiles,
            metadata: !term && tiles.length >= 24 ? { page: page + 1 } : undefined,
        })
    }

    async getSearchTags(): Promise<TagSection[]> {
        const genres: [string, string][] = [
            ['accion', 'Acción'], ['aventura', 'Aventura'], ['comedia', 'Comedia'],
            ['drama', 'Drama'], ['ecchi', 'Ecchi'], ['fantasia', 'Fantasía'],
            ['harem', 'Harem'], ['horror', 'Horror'], ['isekai', 'Isekai'],
            ['romance', 'Romance'], ['seinen', 'Seinen'], ['shounen', 'Shounen'],
            ['shoujo', 'Shoujo'], ['sobrenatural', 'Sobrenatural'],
            ['sistema-de-niveles', 'Sistema de Niveles'], ['reencarnacion', 'Reencarnación'],
        ]
        return [App.createTagSection({
            id: 'genres', label: 'Géneros',
            tags: genres.map(([id, label]) => App.createTag({ id, label })),
        })]
    }

    // ── fetchCatalog ─────────────────────────────────────────────────────────

    private async fetchCatalog(search: string, page: number): Promise<PartialSourceManga[]> {
        let url = `${BASE_URL}/api/catalog?page=${page}`
        if (search) url += `&search=${encodeURIComponent(search)}`
        const resp = await this.requestManager.schedule(
            App.createRequest({ url, method: 'GET', headers: { Referer: BASE_URL, Accept: 'application/json' } }),
            this.RETRIES
        )
        let data: any
        try { data = JSON.parse(resp.data) } catch { return [] }
        return (data.mangas ?? []).map((m: any) => App.createPartialSourceManga({
            mangaId: `${typeToPath(m.type)}/${m.slug}`,
            image: m.coverImage || coverUrl(m.slug),
            title: m.title,
        }))
    }
}
