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

const BASE_URL = 'https://inmanga.com'
const CDN_URL  = 'https://cdn1.intomanga.com'

export const InMangaInfo: SourceInfo = {
    version:        '1.0.0',
    name:           'InManga',
    icon:           'icon.png',
    author:         'alexgpareja',
    description:    'InManga — Manga en Español',
    contentRating:  ContentRating.MATURE,
    websiteBaseURL: BASE_URL,
    language:       'es',
    sourceTags: [{ text: 'Español', type: BadgeColor.GREY }],
    intents: SourceIntents.MANGA_CHAPTERS
           | SourceIntents.HOMEPAGE_SECTIONS
           | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
}

// ── ID helpers ────────────────────────────────────────────────────────────────
// mangaId   = "{slug}|{mangaUuid}"  e.g. "One-Piece|dfc7ecb5-e9b3-4aa5-a61b-a498993cd935"
// chapterId = "{chapNum}|{chapUuid}" e.g. "1187|cdb7f662-3199-4301-b01d-86a03cc602d0"

function getSlug(mangaId: string):     string { return mangaId.split('|')[0]   ?? mangaId }
function getMangaUuid(mangaId: string): string { return mangaId.split('|')[1]   ?? mangaId }
function getChapNum(chapterId: string): string { return chapterId.split('|')[0] ?? chapterId }
function getChapUuid(chapterId: string): string { return chapterId.split('|')[1] ?? chapterId }

function coverUrl(uuid: string): string {
    return `${CDN_URL}/i/m/${uuid}/t/o/${uuid}.jpg`
}

function parseStatus(text: string): string {
    const t = text.toLowerCase()
    if (t.includes('emisión') || t.includes('en curso') || t.includes('ongoing')) return 'Ongoing'
    if (t.includes('finaliz') || t.includes('complet'))                            return 'Completed'
    if (t.includes('hiatus')  || t.includes('pausa'))                              return 'Hiatus'
    return 'Unknown'
}

// ── Source class ──────────────────────────────────────────────────────────────

export class InManga implements
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
        return `${BASE_URL}/ver/manga/${getSlug(mangaId)}/${getMangaUuid(mangaId)}`
    }

    // ── getMangaDetails ───────────────────────────────────────────────────────

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const slug = getSlug(mangaId)
        const uuid = getMangaUuid(mangaId)
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/ver/manga/${slug}/${uuid}`,
                method:  'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        const title  = $('h1').first().text().trim() || slug.replace(/-/g, ' ')
        const desc   = $('meta[name="description"]').attr('content')
                    || $('meta[property="og:description"]').attr('content')
                    || ''
        const status = parseStatus(
            $('span.label-success, span.label-warning, span.label-danger').first().text().trim()
        )

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({ image: coverUrl(uuid), titles: [title], desc, status, hentai: false }),
        })
    }

    // ── getChapters ───────────────────────────────────────────────────────────
    // API: GET /chapter/getall?mangaIdentification={uuid}
    // Returns: { data: "<JSON string>" } → parse twice
    // Each chapter: { Number, Identification, FriendlyChapterNumberUrl, RegistrationDate }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const uuid = getMangaUuid(mangaId)
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/chapter/getall?mangaIdentification=${uuid}`,
                method:  'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES
        )

        let result: any[] = []
        try {
            const outer = JSON.parse(resp.data)
            const inner = JSON.parse(outer.data)
            result = inner.result ?? []
        } catch { return [] }

        return result
            .map((c: any) => {
                const chapNum  = parseFloat(c.Number)
                const chapUrl  = String(c.FriendlyChapterNumberUrl)
                const chapUuid = String(c.Identification).toLowerCase()
                const time     = c.RegistrationDate ? new Date(c.RegistrationDate) : undefined
                return App.createChapter({
                    id:       `${chapUrl}|${chapUuid}`,
                    chapNum,
                    name:     `Capítulo ${chapUrl}`,
                    langCode: 'es',
                    ...(time && !isNaN(time.getTime()) ? { time } : {}),
                })
            })
            .sort((a: Chapter, b: Chapter) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ─────────────────────────────────────────────────────
    // Page IDs from GET /chapter/chapterIndexControls?identification={chapUuid}
    // Returns 175KB HTML with #PageList options populated (server-side rendered with auth)
    // Wrong param (?chapterIdentification=) returns 8KB with empty #PageList

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const mangaUuid = getMangaUuid(mangaId)
        const chapUuid  = getChapUuid(chapterId)

        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/chapter/chapterIndexControls?identification=${chapUuid}`,
                method:  'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        const seen  = new Set<string>()
        const pages: string[] = []

        $('#PageList option').each((_: number, el: Element) => {
            const pageId = $(el).attr('value') ?? ''
            if (!pageId || seen.has(pageId)) return
            seen.add(pageId)
            pages.push(`${CDN_URL}/i/m/${mangaUuid}/c/${chapUuid}/o/${pageId}.jpg`)
        })

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ───────────────────────────────────────────────────
    // "recent" y "popular" salen de los widgets reales de la home
    // (GET /chapter/getRecentChapters, GET /manga/getMostViewedMangas — HTML
    // parcial, no JSON). Ninguno de los dos soporta paginación (siempre
    // devuelven el mismo puñado fijo de resultados).

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const recent  = App.createHomeSection({ id: 'recent',  title: '🕒 Recientes', type: HomeSectionType.singleRowNormal, containsMoreItems: false })
        const popular = App.createHomeSection({ id: 'popular', title: '🔥 Populares',  type: HomeSectionType.singleRowNormal, containsMoreItems: false })
        const catalog = App.createHomeSection({ id: 'catalog', title: '📚 Catálogo',   type: HomeSectionType.singleRowNormal, containsMoreItems: true  })
        ;[recent, popular, catalog].forEach(sectionCallback)

        const [recentResp, popularResp, catalogTiles] = await Promise.all([
            this.requestManager.schedule(App.createRequest({
                url: `${BASE_URL}/chapter/getRecentChapters`, method: 'GET',
                headers: { Referer: BASE_URL, 'X-Requested-With': 'XMLHttpRequest' },
            }), this.RETRIES),
            this.requestManager.schedule(App.createRequest({
                url: `${BASE_URL}/manga/getMostViewedMangas`, method: 'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES),
            this.fetchCatalog('', 0, 15),
        ])

        recent.items  = this.parseRecentChapterMangas(this.cheerio.load(recentResp.data))
        popular.items = this.parseTiles(this.cheerio.load(popularResp.data))
        catalog.items = catalogTiles
        sectionCallback(recent); sectionCallback(popular); sectionCallback(catalog)
    }

    async getViewMoreItems(_sectionId: string, metadata: any): Promise<PagedResults> {
        const skip = metadata?.skip ?? 0
        const take = 12
        const tiles = await this.fetchCatalog('', skip, take)
        return App.createPagedResults({
            results:  tiles,
            metadata: tiles.length >= take ? { skip: skip + take } : undefined,
        })
    }

    // ── getSearchResults ──────────────────────────────────────────────────────

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const term = (query.title ?? '').trim()
        const skip = metadata?.skip ?? 0
        const take = 12
        const tiles = await this.fetchCatalog(term, skip, take)
        const hasNext = tiles.length >= take
        return App.createPagedResults({
            results:  tiles,
            metadata: hasNext ? { skip: skip + take } : undefined,
        })
    }

    // ── fetchCatalog ──────────────────────────────────────────────────────────
    // Real endpoint: POST /manga/getMangasConsultResult
    // Only skip/take/sortby — any extra param activates a user-favorites filter

    private async fetchCatalog(name: string, skip: number, take: number): Promise<PartialSourceManga[]> {
        let body = `skip=${skip}&take=${take}&sortby=1`
        if (name) body += `&name=${encodeURIComponent(name)}`
        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:    `${BASE_URL}/manga/getMangasConsultResult`,
                method: 'POST',
                headers: {
                    'Content-Type':     'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest',
                    Referer:            BASE_URL,
                },
                data: body,
            }), this.RETRIES
        )
        return this.parseTiles(this.cheerio.load(resp.data))
    }

    // ── parseTiles ────────────────────────────────────────────────────────────
    // Manga card links: /ver/manga/{slug}/{uuid}  (no chapNum segment)

    parseTiles($: CheerioAPI): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []
        const seen  = new Set<string>()

        $('a[href*="/ver/manga/"]').each((_: number, el: Element) => {
            const href = $(el).attr('href') ?? ''
            // Must end with the UUID — chapter URLs have an extra segment after
            const m = href.match(/\/ver\/manga\/([^/]+)\/([a-f0-9-]{36})\/?$/i)
            if (!m) return

            const slug    = m[1]!
            const uuid    = m[2]!.toLowerCase()
            const mangaId = `${slug}|${uuid}`
            if (seen.has(mangaId)) return
            seen.add(mangaId)

            const img      = $(el).find('img').first()
            const rawImage = img.attr('data-src') || img.attr('src') || ''
            const image    = rawImage.startsWith('http') && !rawImage.includes('loading-gear')
                ? rawImage
                : coverUrl(uuid)

            const title = (img.attr('alt') ?? '')
                .replace(/ Manga Online - InManga$/i, '').trim()
                || slug.replace(/-/g, ' ')

            tiles.push(App.createPartialSourceManga({ mangaId, image, title }))
        })

        return tiles
    }

    // ── parseRecentChapterMangas ─────────────────────────────────────────────
    // getRecentChapters da links a CAPÍTULOS: /ver/manga/{slug}/{chapNum}/{chapUuid}
    // — el UUID del manga está en la imagen (i/m/{mangaUuid}/t/o/...), no en el href.
    // Deduplica por manga, quedándose con el capítulo más reciente de cada uno.

    private parseRecentChapterMangas($: CheerioAPI): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []
        const seen  = new Set<string>()

        $('a[href*="/ver/manga/"]').each((_: number, el: Element) => {
            const href = $(el).attr('href') ?? ''
            const m = href.match(/^\/ver\/manga\/([^/]+)\/[\d.,]+\/([a-f0-9-]{36})/i)
            if (!m) return
            const slug = m[1]!

            const img = $(el).find('img').first()
            const um  = (img.attr('src') ?? '').match(/\/i\/m\/([a-f0-9-]{36})\/t\/o\//i)
            if (!um) return
            const uuid    = um[1]!.toLowerCase()
            const mangaId = `${slug}|${uuid}`
            if (seen.has(mangaId)) return
            seen.add(mangaId)

            const title = (img.attr('alt') ?? '')
                .replace(/\s+[\d.,]+\s+Manga Online - InManga$/i, '').trim()
                || slug.replace(/-/g, ' ')

            tiles.push(App.createPartialSourceManga({ mangaId, image: coverUrl(uuid), title }))
        })

        return tiles
    }
}
