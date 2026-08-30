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
    HomePageSectionsProviding,
    MangaProviding,
    ChapterProviding,
    SearchResultsProviding,
} from '@paperback/types'

const BASE_URL = 'https://olympusxyz.com'
const API_URL = 'https://panel.olympusxyz.com'

export const OlympusXYZInfo: SourceInfo = {
    version: '1.0.0',
    name: 'OlympusXYZ',
    icon: 'icon.png',
    author: 'alexgpareja',
    description: 'Olympus Scanlation — Manhwa y Manhua en Español',
    contentRating: ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    language: 'es',
    sourceTags: [{ text: 'Español', type: BadgeColor.GREY }],
    intents: SourceIntents.MANGA_CHAPTERS | SourceIntents.HOMEPAGE_SECTIONS,
}

function getType(mangaId: string): string { return mangaId.split('/')[0] ?? mangaId }
function getSlug(mangaId: string): string { return mangaId.split('/').slice(1).join('/') }

function parseStatus(s: string): string {
    const t = s.toLowerCase()
    if (t.includes('activo') || t.includes('emision')) return 'Ongoing'
    if (t.includes('final')) return 'Completed'
    if (t.includes('hiatus') || t.includes('pausa')) return 'Hiatus'
    if (t.includes('cancel')) return 'Cancelled'
    return 'Unknown'
}

/**
 * Resuelve el bloque __NUXT_DATA__ (Nuxt 3, formato "devalue"): un array
 * plano donde cada objeto referencia otros valores por índice en vez de
 * contenerlos directamente. Devuelve el fieldMap del manga (id, name,
 * status, genres... → índices) y un resolver para seguir esos índices.
 */
function extractNuxtSeriesFieldMap(html: string): { fieldMap: any, resolve: (i: number) => any } | null {
    const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
    if (!m) return null
    let arr: any[]
    try { arr = JSON.parse(m[1]!) } catch { return null }
    const resolve = (i: number): any => arr[i]
    try {
        const obj1 = resolve(arr[0][1])
        const wrap2 = resolve(obj1.data)
        const obj3 = resolve(wrap2[1])
        const obj4 = resolve(Object.values(obj3)[0] as number)
        const fieldMap = resolve(obj4.data)
        return { fieldMap, resolve }
    } catch { return null }
}

// Tarjeta genérica: <a href="/series/{type}-{slug}" title="..."><img alt="..." src="..."></a>
function tileFromAnchor($: CheerioAPI, el: Element): PartialSourceManga | null {
    const href = $(el).attr('href') ?? ''
    const m = href.match(/^\/series\/(comic|novela)-(.+)$/)
    if (!m) return null
    const img = $(el).find('img').first()
    if (!img.length) return null
    const type = m[1]!, slug = m[2]!
    const title = (img.attr('alt') || $(el).attr('title') || '').trim() || slug.replace(/-/g, ' ')
    return App.createPartialSourceManga({ mangaId: `${type}/${slug}`, image: img.attr('src') ?? '', title })
}

function collectTiles($: CheerioAPI, anchors: ReturnType<CheerioAPI>): PartialSourceManga[] {
    const seen = new Set<string>()
    const tiles: PartialSourceManga[] = []
    anchors.each((_: number, el: Element) => {
        const t = tileFromAnchor($, el)
        if (!t || seen.has(t.mangaId)) return
        seen.add(t.mangaId); tiles.push(t)
    })
    return tiles
}

export class OlympusXYZ implements
    SearchResultsProviding,
    MangaProviding,
    ChapterProviding,
    HomePageSectionsProviding {
    constructor(private cheerio: CheerioAPI) { }

    RETRIES = 3
    requestManager = App.createRequestManager({ requestsPerSecond: 3, requestTimeout: 20000 })

    getMangaShareUrl(mangaId: string): string {
        return `${BASE_URL}/series/${getType(mangaId)}-${getSlug(mangaId)}`
    }

    // ── getMangaDetails ──────────────────────────────────────────────────────
    // Meta tags para título/portada/sinopsis. Estado y géneros vienen del
    // bloque __NUXT_DATA__ (no se renderizan como texto plano en el HTML).

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const resp = await this.requestManager.schedule(
            App.createRequest({ url: this.getMangaShareUrl(mangaId), method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        const rawTitle = $('meta[property="og:title"]').attr('content') ?? ''
        const title = rawTitle.replace(/\s*\|\s*Olympus Scanlation$/, '').trim()
            || getSlug(mangaId).replace(/-/g, ' ')
        const image = $('meta[property="og:image"]').attr('content') ?? ''
        const desc = $('meta[property="og:description"]').attr('content') ?? ''

        let status = 'Unknown'
        const tagItems: ReturnType<typeof App.createTag>[] = []
        const nuxt = extractNuxtSeriesFieldMap(resp.data)
        if (nuxt) {
            const { fieldMap, resolve } = nuxt
            try {
                const statusRef = resolve(fieldMap.status)
                status = parseStatus(String(resolve(statusRef.name) ?? ''))
            } catch { /* se queda en Unknown */ }
            try {
                const genreIdxs: number[] = resolve(fieldMap.genres) ?? []
                for (const gi of genreIdxs) {
                    const g = resolve(gi)
                    const label = String(resolve(g.name) ?? '').trim()
                    if (label) tagItems.push(App.createTag({ id: label.toLowerCase(), label }))
                }
            } catch { /* sin géneros */ }
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
    // API pública (sin Cloudflare, sin firma): trae published_at real por
    // capítulo. Pagina con meta.last_page hasta agotar páginas.

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const type = getType(mangaId), slug = getSlug(mangaId)
        const chapters: Chapter[] = []
        let page = 1
        for (; ;) {
            const resp = await this.requestManager.schedule(
                App.createRequest({
                    url: `${API_URL}/api/series/${slug}/chapters?page=${page}&direction=desc&type=${type}`,
                    method: 'GET', headers: { Referer: BASE_URL },
                }), this.RETRIES
            )
            let data: any
            try { data = JSON.parse(resp.data) } catch { break }
            const list: any[] = data.data ?? []
            for (const c of list) {
                chapters.push(App.createChapter({
                    id: String(c.id), chapNum: parseFloat(c.name),
                    name: `Capítulo ${c.name}`, langCode: 'es',
                    time: c.published_at ? new Date(c.published_at) : undefined,
                }))
            }
            const lastPage = data.meta?.last_page ?? page
            if (page >= lastPage || list.length === 0) break
            page++
        }
        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ────────────────────────────────────────────────────
    // Imágenes directas en CDN (media.imagesolymp.xyz), sin proxy ni token.

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const type = getType(mangaId), slug = getSlug(mangaId)
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url: `${BASE_URL}/capitulo/${chapterId}/${type}-${slug}`, method: 'GET',
                headers: { Referer: this.getMangaShareUrl(mangaId) },
            }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)
        const seen = new Set<string>()
        const pages: string[] = []
        $('img').each((_: number, el: Element) => {
            const src = $(el).attr('src') ?? ''
            if (src.includes('/comics/') && !src.includes('/comics/covers/') && !seen.has(src)) {
                seen.add(src); pages.push(src)
            }
        })
        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ────────────────────────────────────────────────
    // La home trae "Nuevos Lanzamientos" y "Popular Del Dia" reales — sin
    // Cloudflare, todo vía SSR. Ninguna sección pagina (son widgets fijos).

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const sections = [
            App.createHomeSection({ id: 'recent', title: '🕒 Recientes', type: HomeSectionType.singleRowNormal, containsMoreItems: false }),
            App.createHomeSection({ id: 'popular', title: '🔥 Populares', type: HomeSectionType.singleRowNormal, containsMoreItems: false }),
            App.createHomeSection({ id: 'catalog', title: '📚 Top Series', type: HomeSectionType.singleRowNormal, containsMoreItems: false }),
        ]
        sections.forEach(sectionCallback)

        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)
        sections[0]!.items = this.tilesUnderHeading($, 'Nuevos Lanzamientos')
        sections[1]!.items = this.tilesUnderHeading($, 'Popular Del Dia')
        sections[2]!.items = this.tilesUnderHeading($, 'Top Series')
        sections.forEach(sectionCallback)
    }

    async getViewMoreItems(_sectionId: string, _metadata: any): Promise<PagedResults> {
        // Ninguna sección de la home anuncia containsMoreItems — no debería llamarse.
        return App.createPagedResults({ results: [] })
    }

    // ── getSearchResults ─────────────────────────────────────────────────────
    // No hay endpoint de búsqueda/catálogo público: panel.olympusxyz.com/api/series
    // (listado y búsqueda) está detrás de Cloudflare. Se filtra por título dentro
    // de lo que la home + /series exponen sin bloqueo (unas 40-60 series).

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        if (metadata?.done) return App.createPagedResults({ results: [] })
        const term = (query.title ?? '').trim().toLowerCase()
        const pool = await this.fetchSearchPool()
        const results = term ? pool.filter((t) => t.title.toLowerCase().includes(term)) : pool
        return App.createPagedResults({ results, metadata: { done: true } })
    }

    async getSearchTags(): Promise<TagSection[]> { return [] }

    private async fetchSearchPool(): Promise<PartialSourceManga[]> {
        const [homeResp, catalogResp] = await Promise.all([
            this.requestManager.schedule(App.createRequest({ url: `${BASE_URL}/`, method: 'GET' }), this.RETRIES),
            this.requestManager.schedule(App.createRequest({ url: `${BASE_URL}/series`, method: 'GET' }), this.RETRIES),
        ])
        const seen = new Set<string>()
        const tiles: PartialSourceManga[] = []
        for (const html of [homeResp.data, catalogResp.data]) {
            const $ = this.cheerio.load(html)
            for (const t of collectTiles($, $('a[href*="/series/"]'))) {
                if (seen.has(t.mangaId)) continue
                seen.add(t.mangaId); tiles.push(t)
            }
        }
        return tiles
    }

    private tilesUnderHeading($: CheerioAPI, headingText: string): PartialSourceManga[] {
        const h2 = $('h2').filter((_: number, el: Element) => $(el).text().trim() === headingText)
        const section = h2.closest('section')
        return collectTiles($, section.find('a[href*="/series/"]'))
    }
}
