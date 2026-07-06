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
    version:        '1.0.0',
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

// ── ID helpers ─────────────────────────────────────────────────────────────────
// mangaId   = "{typePath}/{slug}"  e.g. "manhwa/tomb-raider-king-end-line"
// chapterId = chapter number string e.g. "15.5" or "1"

function getSlug(mangaId: string):     string { return mangaId.split('/').slice(1).join('/') }
function getTypePath(mangaId: string): string { return mangaId.split('/')[0] ?? 'manga' }

// API type field → URL path prefix
function typeToPath(apiType: string): string {
    if (apiType === 'manhwa') return 'manhwa'
    if (apiType === 'manhua') return 'manhua'
    if (apiType === 'novela') return 'novela'
    return 'manga'
}

function coverUrl(slug: string): string {
    return `${CDN_URL}/manga/covers/${slug}.webp`
}

function parseStatus(text: string): string {
    const t = text.toLowerCase()
    if (t.includes('emisión') || t.includes('curso') || t.includes('ongoing')) return 'Ongoing'
    if (t.includes('complet') || t.includes('finaliz'))                         return 'Completed'
    if (t.includes('cancel'))                                                   return 'Cancelled'
    if (t.includes('hiatus') || t.includes('pausa'))                            return 'Hiatus'
    return 'Unknown'
}

// ── Source class ───────────────────────────────────────────────────────────────

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

    // ── getMangaDetails ────────────────────────────────────────────────────────
    // Fetches /{type}/{slug} HTML — title from h1, desc from og:description,
    // cover from CDN pattern, status from body text

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const slug = getSlug(mangaId)
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/${mangaId}`,
                method:  'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        const title = $('h1').first().text().trim()
            || $('meta[property="og:title"]').attr('content')?.replace(/\s*[-|].*Lector XD.*$/i, '').trim()
            || slug.replace(/-/g, ' ')

        // og:description format: "Lee {title} online... Sinopsis: {desc}"
        const ogDesc = $('meta[property="og:description"]').attr('content') ?? ''
        const desc = ogDesc.includes('Sinopsis:')
            ? ogDesc.split('Sinopsis:').slice(1).join('Sinopsis:').trim()
            : ogDesc

        const image = coverUrl(slug)

        const statusText = $('[class*="status"], [class*="estado"]').first().text().trim()
            || (resp.data.match(/\b(completado|en emisión|cancelado|hiatus|en pausa)\b/i)?.[1] ?? '')
        const status = parseStatus(statusText)

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({ image, titles: [title], desc, status, hentai: false }),
        })
    }

    // ── getChapters ────────────────────────────────────────────────────────────
    // Parses `const chaptersList = [...]` embedded in manga detail HTML
    // Each entry: { chapter: "N", groupId: null }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/${mangaId}`,
                method:  'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES
        )

        const m = resp.data.match(/const chaptersList = (\[[\s\S]*?\]);/)
        if (!m) return []

        let list: any[] = []
        try { list = JSON.parse(m[1]!) } catch { return [] }

        // Deduplicate by chapter number (multiple groups may translate same chapter)
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

    // ── getChapterDetails ──────────────────────────────────────────────────────
    // Fetches /{type}/{slug}/leer/{chapNum} HTML
    // Images in img[data-src*="cdnlxd"] — lazy-loaded, full URL in data-src

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

        $('img[data-src]').each((_: number, el: Element) => {
            const src = $(el).attr('data-src') ?? ''
            if (src.includes('cdnlxd') && !seen.has(src)) {
                seen.add(src)
                pages.push(src)
            }
        })

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ────────────────────────────────────────────────────

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

    // ── getSearchResults ───────────────────────────────────────────────────────

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const term = (query.title ?? '').trim()
        const page = metadata?.page ?? 1
        const tiles = await this.fetchCatalog(term, page)
        return App.createPagedResults({
            results:  tiles,
            // Search results are not paginated on LectorXD — all on page 1
            metadata: !term && tiles.length >= 24 ? { page: page + 1 } : undefined,
        })
    }

    // ── fetchCatalog ───────────────────────────────────────────────────────────
    // GET /api/catalog?page=N[&search=term] → { totalCount, mangas[] }
    // Page size is fixed at 24 items

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
