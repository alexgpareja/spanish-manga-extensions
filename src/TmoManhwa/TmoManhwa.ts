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

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://tmomanhwa.com'
const IMG_CDN  = 'https://img01.tmomanhwa.com'

export const TmoManhwaInfo: SourceInfo = {
    version:        '1.0.0',
    name:           'TmoManhwa',
    icon:           'icon.png',
    author:         'alexgpareja',
    description:    'TmoManhwa — Manhwa y Manga en Español',
    contentRating:  ContentRating.ADULT,
    websiteBaseURL: BASE_URL,
    language:       'es',
    sourceTags: [
        { text: 'Español', type: BadgeColor.GREY },
        { text: '18+',     type: BadgeColor.YELLOW },
    ],
    intents: SourceIntents.MANGA_CHAPTERS
           | SourceIntents.HOMEPAGE_SECTIONS
           | SourceIntents.CLOUDFLARE_BYPASS_REQUIRED,
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** mangaId = "{slug}_{numericId}"  ej: "secret-class_6440" */
function buildId(slug: string, numId: string): string { return `${slug}_${numId}` }
function getSlug(mangaId: string): string { return mangaId.split('_')[0] ?? mangaId }
function getNumId(mangaId: string): string { return mangaId.split('_')[1] ?? '' }

/**
 * Extrae el ID numérico del og:image.
 * Patrón: uploads/{slug}-{numericId}.jpg
 */
function extractNumId(ogImage: string): string {
    return ogImage.match(/-(\d+)\.(jpg|webp|png)/)?.[1] ?? ''
}

function parseStatus(text: string): string {
    const t = text.toLowerCase()
    if (t.includes('en curso') || t.includes('ongoing') || t.includes('activo')) return 'Ongoing'
    if (t.includes('finaliz') || t.includes('complet') || t.includes('terminado')) return 'Completed'
    if (t.includes('hiatus') || t.includes('pausa')) return 'Hiatus'
    return 'Unknown'
}

// ─────────────────────────────────────────────────────────────────────────────
// Clase principal
// ─────────────────────────────────────────────────────────────────────────────

export class TmoManhwa implements
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
        return `${BASE_URL}/manhwa/${getSlug(mangaId)}/`
    }

    // ── getMangaDetails ────────────────────────────────────────────────────
    // URL: /manhwa/{slug}/
    // - Portada: meta[property="og:image"] → uploads/{slug}-{numId}.jpg
    // - ID numérico: extraído del og:image
    // - Capítulos: ul.chapter-list li a[href*="capitulo"]
    // - Géneros: a[href*="/genero/"]

    async getMangaDetails(mangaId: string): Promise<SourceManga> {
        const slug = getSlug(mangaId)
        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manhwa/${slug}/`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        const title   = $('h1').first().text().trim() || slug.replace(/-/g, ' ')
        const ogImage = $('meta[property="og:image"]').attr('content') ?? ''
        const image   = ogImage || `${BASE_URL}/uploads/${slug}-thumbnail.jpg`

        // Descripción
        const desc = $('meta[name="description"]').attr('content')
            || $('meta[property="og:description"]').attr('content')
            || $('[class*="summary"] p, .entry-content p').first().text().trim()
            || ''

        // Estado
        const bodyText    = $('body').text()
        const statusMatch = bodyText.match(/\b(En Curso|Finalizado|Completado|Hiatus|En Pausa|Activo)\b/i)
        const status      = statusMatch ? parseStatus(statusMatch[1]!) : 'Unknown'

        // Géneros
        const tagItems: ReturnType<typeof App.createTag>[] = []
        const seenTags = new Set<string>()
        $('a[href*="/genero/"]').each((_: number, el: Element) => {
            const href  = $(el).attr('href') ?? ''
            const m     = href.match(/\/genero\/([^/?#]+)/)
            if (!m) return
            const id    = m[1]!.replace(/\/$/, '')
            const label = $(el).text().trim()
            if (!label || seenTags.has(id)) return
            seenTags.add(id)
            tagItems.push(App.createTag({ id, label }))
        })

        const tags: TagSection[] = tagItems.length
            ? [App.createTagSection({ id: 'genres', label: 'Géneros', tags: tagItems })]
            : []

        return App.createSourceManga({
            id: mangaId,
            mangaInfo: App.createMangaInfo({ image, titles: [title], desc, status, tags, hentai: false }),
        })
    }

    // ── getChapters ────────────────────────────────────────────────────────
    // Lista en ul.chapter-list li a[href*="capitulo"]
    // URL capítulo: /manhwa/{slug}/capitulo-{N}/
    // Fecha: span.ct-update

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const slug = getSlug(mangaId)
        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/manhwa/${slug}/`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        // Extraer numId del og:image si no lo tenemos aún
        const ogImage = $('meta[property="og:image"]').attr('content') ?? ''
        const numId   = getNumId(mangaId) || extractNumId(ogImage)

        const chapters: Chapter[] = []
        const seen = new Set<string>()

        $('ul.chapter-list li a[href*="capitulo"]').each((_: number, el: Element) => {
            const href = $(el).attr('href') ?? ''
            const m    = href.match(/capitulo-([0-9]+(?:\.[0-9]+)?)/)
            if (!m) return
            const chapNum = parseFloat(m[1]!)
            const chapId  = `${numId}_${m[1]!}`   // "{numId}_{chapNum}" — necesario para construir URL imagen
            if (seen.has(chapId)) return
            seen.add(chapId)

            // Fecha: "27 Jun 2026" en span.ct-update
            const dateText = $(el).find('.ct-update, [class*="update"]').text().trim()
            let time: Date | undefined
            if (dateText) {
                const d = new Date(dateText)
                if (!isNaN(d.getTime())) time = d
            }

            chapters.push(App.createChapter({
                id:       chapId,
                chapNum,
                name:     `Capítulo ${m[1]}`,
                langCode: 'es',
                ...(time ? { time } : {}),
            }))
        })

        return chapters.sort((a, b) => b.chapNum - a.chapNum)
    }

    // ── getChapterDetails ──────────────────────────────────────────────────
    // chapterId = "{numId}_{chapNum}" ej: "3737_35"
    // Imágenes en: #chapter-images img con src directo
    // CDN patrón: img01.tmomanhwa.com/online/{numId}/{chapNum}/{page}-947.jpg

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const slug    = getSlug(mangaId)
        const chapNum = chapterId.split('_')[1] ?? chapterId

        const resp = await this.requestManager.schedule(
            App.createRequest({
                url:     `${BASE_URL}/manhwa/${slug}/capitulo-${chapNum}/`,
                method:  'GET',
                headers: { Referer: BASE_URL },
            }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        const pages: string[] = []
        const seen = new Set<string>()

        $('#chapter-images img, .reading-content img').each((_: number, el: Element) => {
            // data-src is the raw HTML attr; src is set by JS lazy-loader (empty in raw HTML)
            const src = $(el).attr('data-src')
                     || $(el).attr('src')
                     || $(el).attr('data-lazy-src')
                     || $(el).attr('data-original')
                     || ''
            if (src.startsWith('http') && !seen.has(src)) {
                seen.add(src)
                pages.push(src)
            }
        })

        return App.createChapterDetails({ id: chapterId, mangaId, pages })
    }

    // ── getHomePageSections ────────────────────────────────────────────────

    async getHomePageSections(sectionCallback: (section: HomeSection) => void): Promise<void> {
        const latest  = App.createHomeSection({ id: 'latest',  title: '🕒 Últimas actualizaciones', type: HomeSectionType.singleRowNormal, containsMoreItems: true })
        const popular = App.createHomeSection({ id: 'library', title: '⭐️ Biblioteca completa',      type: HomeSectionType.singleRowLarge,  containsMoreItems: true })

        sectionCallback(latest)
        sectionCallback(popular)

        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)
        const tiles = this.parseTiles($)

        latest.items  = tiles.slice(0, 15)
        popular.items = tiles.slice(15, 30)
        sectionCallback(latest)
        sectionCallback(popular)
    }

    async getViewMoreItems(_: string, metadata: any): Promise<PagedResults> {
        const page = metadata?.page ?? 1
        const resp = await this.requestManager.schedule(
            App.createRequest({ url: `${BASE_URL}/biblioteca/page/${page}/`, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)

        // Detectar si hay siguiente página
        const hasNext = $('a.next, .pagination .next, [class*="paginat"] .next').length > 0
            || $('a[href*="/page/"]').toArray().some((el: Element) => {
                const n = parseInt($(el).attr('href')?.match(/\/page\/(\d+)/)?.[1] ?? '0')
                return n > page
            })

        return App.createPagedResults({
            results:  this.parseTiles($),
            metadata: hasNext ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchResults ───────────────────────────────────────────────────
    // URL: /search/?s={query}  — devuelve todos los resultados en una página
    // Por género: /genero/{id}/page/{N}/

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const term   = (query.title ?? '').trim()
        const genres = query.includedTags?.map((t: any) => t.id) ?? []
        const page   = metadata?.page ?? 1

        let url: string
        if (term) {
            url = `${BASE_URL}/search/?s=${encodeURIComponent(term)}`
        } else if (genres[0]) {
            url = page === 1
                ? `${BASE_URL}/genero/${genres[0]}/`
                : `${BASE_URL}/genero/${genres[0]}/page/${page}/`
        } else {
            url = page === 1
                ? `${BASE_URL}/biblioteca/`
                : `${BASE_URL}/biblioteca/page/${page}/`
        }

        const resp = await this.requestManager.schedule(
            App.createRequest({ url, method: 'GET' }), this.RETRIES
        )
        const $ = this.cheerio.load(resp.data)
        const manga = this.parseTiles($)

        // Búsqueda por texto no está paginada — devolver sin metadata
        const hasNext = !term && $('a.next, .pagination .next').length > 0

        return App.createPagedResults({
            results:  manga,
            metadata: hasNext ? { page: page + 1 } : undefined,
        })
    }

    // ── getSearchTags ──────────────────────────────────────────────────────

    async getSearchTags(): Promise<TagSection[]> {
        const genres: [string, string][] = [
            ['accion','Acción'], ['aventura','Aventura'], ['comedia','Comedia'],
            ['drama','Drama'], ['ecchi','Ecchi'], ['fantasia','Fantasía'],
            ['harem','Harem'], ['horror','Horror'], ['isekai','Isekai'],
            ['magia','Magia'], ['misterio','Misterio'], ['romance','Romance'],
            ['seinen','Seinen'], ['shoujo','Shoujo'], ['shounen','Shounen'],
            ['sobrenatural','Sobrenatural'], ['tragedia','Tragedia'],
            ['vida-escolar','Vida Escolar'], ['boys-love','Boys Love'],
            ['girls-love','Girls Love'], ['gore','Gore'],
        ]
        return [App.createTagSection({
            id:    'genres',
            label: 'Géneros',
            tags:  genres.map(([id, label]) => App.createTag({ id, label })),
        })]
    }

    // ── parseTiles ─────────────────────────────────────────────────────────
    // Items del listado: a[href*="/manhwa/"] con img dentro
    // - Cover: uploads/{slug}-thumbnail.jpg
    // - mangaId: "{slug}_" — sin numId (se obtiene al abrir el detalle)

    parseTiles($: CheerioAPI): PartialSourceManga[] {
        const tiles: PartialSourceManga[] = []
        const seen  = new Set<string>()

        $('a[href*="/manhwa/"]').each((_: number, el: Element) => {
            const href = $(el).attr('href') ?? ''
            const m    = href.match(/\/manhwa\/([^/?#]+)/)
            if (!m) return

            const slug    = m[1]!.replace(/\/$/, '')
            const mangaId = slug   // sin numId aún — se completa en getMangaDetails
            if (seen.has(slug) || slug.includes('capitulo')) return
            seen.add(slug)

            const img = $(el).find('img').first()
            const image = img.attr('src')
                       ?? img.attr('data-src')
                       ?? `${BASE_URL}/uploads/${slug}-thumbnail.jpg`

            if (!image.startsWith('http')) return

            let title = (img.attr('alt') ?? '').trim()
            if (!title) title = $(el).find('h3, h4, [class*="title"]').first().text().trim()
            if (!title) title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

            tiles.push(App.createPartialSourceManga({ mangaId, image, title }))
        })

        return tiles
    }
}
