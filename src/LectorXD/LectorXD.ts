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
const CDN_URL  = 'https://s1.cdnlxd.xyz'

export const LectorXDInfo: SourceInfo = {
    version:        '1.0.1',
    name:           'LectorXD',
    icon:           'icon.png',
    author:         'alexgpareja',
    description:    'LectorXD — Manga, Manhwa y Manhua en Español',
    contentRating:  ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    language:       'es',
    sourceTags: [{ text: 'Español', type: BadgeColor.GREY }],
    intents: SourceIntents.MANGA_CHAPTERS
           | SourceIntents.HOMEPAGE_SECTIONS
           | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
}

// ── ID helpers ──────────────────────────────────────────────────────────────
// mangaId = "{typePath}/{slug}"  e.g. "manhwa/tomb-raider-king"

function getSlug(mangaId: string): string     { return mangaId.split('/').slice(1).join('/') }
function getTypePath(mangaId: string): string { return mangaId.split('/')[0] ?? 'manga' }

function typeToPath(apiType: string): string {
    if (apiType === 'manhwa') return 'manhwa'
    if (apiType === 'manhua') return 'manhua'
    if (apiType === 'novela') return 'novela'
    return 'manga'
}

function coverUrl(slug: string): string {
    return `${CDN_URL}/manga/covers/${slug}.webp`
}

function parseStatus(apiStatus: string): string {
    switch (apiStatus) {
        case 'en_emision': return 'Ongoing'
        case 'completado': return 'Completed'
        case 'cancelado':  return 'Cancelled'
        case 'hiatus':     return 'Hiatus'
        default:
            if (apiStatus?.includes('emision') || apiStatus?.includes('curso')) return 'Ongoing'
            if (apiStatus?.includes('complet') || apiStatus?.includes('finaliz')) return 'Completed'
            return 'Unknown'
    }
}

// ── Source class ────────────────────────────────────────────────────────────

export class LectorXD implements
    SearchResultsProviding,
    MangaProviding,
    ChapterProviding,
    HomePageSectionsProviding,
    CloudflareBypassRequestProviding
{
    constructor(private cheerio: CheerioAPI) {}

    RETRIES = 3

    requestManager = App.createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 20000,
    })

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return App.createRequest({ url: BASE_URL, method: 'GET' })
    }

    getMangaShareUrl(mangaId: string): string {
        return `${BASE_URL}/${mangaId}`
    }

    // ── getMangaDetails ──────────────────────────────────────────────────────
    // Usa la API /api/catalog?search=TITLE para obtener descripción,
    // géneros y estado completos. El slug se convierte en título de búsqueda
    // reemplazando guiones por espacios.

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const slug      = getSlug(mangaId)
        const titleHint = slug.replace(/-/g, ' ')

        // Obtener datos completos del manga desde la API
        const apiResp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/api/catalog?search=${encodeURIComponent(titleHint)}&page=1`,
                method:  'GET',
                headers: { Referer: BASE_URL, Accept: 'application/json' },
            }), this.RETRIES
        )

        let manga: any = null
        try {
            const data = JSON.parse(apiResp.data)
            // Buscar el manga con slug exacto entre los resultados
            manga = (data.mangas ?? []).find((m: any) => m.slug === slug)
                 ?? (data.mangas ?? [])[0]
        } catch { /* si falla la API, continuamos con fallback */ }

        // Extraer campos de la API
        const title  = manga?.title  || slug.replace(/-/g, ' ')
        const desc   = manga?.description || ''
        const image  = manga?.coverImage  || coverUrl(slug)
        const status = manga ? parseStatus(manga.status) : 'Unknown'

        // Tags desde la API — ya vienen como array con tag.name y tag.slug
        const tagItems: ReturnType<typeof App.createTag>[] = []
        const seenTags = new Set<string>()
        for (const t of (manga?.tags ?? [])) {
            const id    = t.tag?.slug ?? String(t.tagId)
            const label = t.tag?.name ?? id
            if (!seenTags.has(id)) {
                seenTags.add(id)
                tagItems.push(App.createTag({ id, label }))
            }
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
    // Parsea `const chaptersList = [...]` embebido en el HTML de detalle.
    // Formato: [{"chapter":"1","groupId":null}, ...]

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/${mangaId}`,
                method:  'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES
        )

        // El array chaptersList puede ser largo — usamos regex greedy
        const m = resp.data.match(/chaptersList\s*=\s*(\[[\s\S]+?\]);?\s*(?:const|let|var|<)/)
        if (!m) {
            // Fallback: buscar el patrón de array de capítulos directamente
            const m2 = resp.data.match(/\[\s*\{[\s\S]*?"chapter"[\s\S]*?\}\s*\]/)
            if (!m2) return []
            try {
                const list: any[] = JSON.parse(m2[0])
                return this.parseChapterList(list, mangaId)
            } catch { return [] }
        }

        try {
            const list: any[] = JSON.parse(m[1]!)
            return this.parseChapterList(list, mangaId)
        } catch { return [] }
    }

    private parseChapterList(list: any[], mangaId: string): Chapter[] {
        const seen = new Set<string>()
        return list
            .filter((c: any) => {
                if (seen.has(c.chapter)) return false
                seen.add(c.chapter)
                return true
            })
            .map((c: any) => App.createChapter({
                id:       String(c.chapter),
                chapNum:  parseFloat(c.chapter),
                name:     `Capítulo ${c.chapter}`,
                langCode: 'es',
            }))
            .sort((a: Chapter, b: Chapter) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ────────────────────────────────────────────────────
    // URL: /{type}/{slug}/leer/{chapNum}
    // Imágenes: img.page-image con atributo src directo al CDN cdnlxd.xyz
    // NOTA: Las imágenes usan src (no data-src) y tienen clase "page-image"

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/${mangaId}/leer/${chapterId}`,
                method:  'GET',
                headers: { Referer: `${BASE_URL}/${mangaId}` },
            }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        const seen  = new Set<string>()
        const pages: string[] = []

        // Las imágenes tienen src directo con clase page-image
        $('img.page-image, img[class*="page-image"]').each((_: number, el: Element) => {
            const src = $(el).attr('src') ?? ''
            if (src.includes('cdnlxd') && !seen.has(src)) {
                seen.add(src)
                pages.push(src)
            }
        })

        // Fallback: cualquier img del CDN
        if (pages.length === 0) {
            $('img').each((_: number, el: Element) => {
                const src = $(el).attr('src')
                         ?? $(el).attr('data-src')
                         ?? ''
                if (src.includes('cdnlxd') && !seen.has(src)) {
                    seen.add(src)
                    pages.push(src)
                }
            })
        }

        // Segundo fallback: extraer URLs del JSON embebido en el HTML
        if (pages.length === 0) {
            const rawHtml = resp.data as string
            for (const m of rawHtml.matchAll(/\"url\":\"(https?:\/\/[^"]*cdnlxd[^"]+)\"/g)) {
                if (!seen.has(m[1]!)) { seen.add(m[1]!); pages.push(m[1]!) }
            }
            // También buscar rutas relativas tipo /498/411/1.png
            for (const m of rawHtml.matchAll(/\"(\/\d+\/[0-9.]+\/\d+\.[a-z]+)\"/g)) {
                const url = `${CDN_URL}${m[1]!}`
                if (!seen.has(url)) { seen.add(url); pages.push(url) }
            }
        }

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ──────────────────────────────────────────────────

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const catalog = App.createHomeSection({
            id: 'catalog', title: '📚 Catálogo',
            type: HomeSectionType.singleRowNormal, containsMoreItems: true,
        })
        sectionCallback(catalog)
        const tiles = await this.fetchCatalog('', 1)
        catalog.items = tiles
        sectionCallback(catalog)
    }

    async getViewMoreItems(_sectionId: string, metadata: any): Promise<PagedResults> {
        const page  = metadata?.page ?? 1
        const tiles = await this.fetchCatalog('', page)
        return App.createPagedResults({
            results:  tiles,
            metadata: tiles.length >= 24 ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchResults ─────────────────────────────────────────────────────

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const term = (query.title ?? '').trim()
        const page = metadata?.page ?? 1
        const tiles = await this.fetchCatalog(term, page)
        return App.createPagedResults({
            results:  tiles,
            metadata: !term && tiles.length >= 24 ? { page: page + 1 } : undefined,
        })
    }

    // ── fetchCatalog ─────────────────────────────────────────────────────────
    // GET /api/catalog?page=N[&search=term]
    // Respuesta: { totalCount, mangas: [{id, title, slug, description, coverImage,
    //   status, type, tags:[{tag:{name,slug}}]}] }

    private async fetchCatalog(search: string, page: number): Promise<PartialSourceManga[]> {
        let url = `${BASE_URL}/api/catalog?page=${page}`
        if (search) url += `&search=${encodeURIComponent(search)}`

        const resp = await this.requestManager.schedule(
            App.createRequest({
                url,
                method:  'GET',
                headers: { Referer: BASE_URL, Accept: 'application/json' },
            }), this.RETRIES
        )

        let data: any
        try { data = JSON.parse(resp.data) } catch { return [] }

        return (data.mangas ?? []).map((m: any) => App.createPartialSourceManga({
            mangaId: `${typeToPath(m.type)}/${m.slug}`,
            image:   m.coverImage || coverUrl(m.slug),
            title:   m.title,
        }))
    }
}
