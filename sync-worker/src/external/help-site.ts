// Public app-help reader (AQU-2581): the data behind the get_help MCP tool and
// its REST mirror. It reads the aquilla-help site (help.aquilla.app), which
// publishes an index at /llms-index.json and each page as Markdown at the
// index's markdownUrl. No project data, no credential check beyond the caller's
// own gate.
//
// Only URLs that come from the index are fetched. Caller input is matched
// against the index's `path` values and never turned into a URL, so the tool
// cannot be pointed at another host. Neither function throws: every failure
// comes back as a result the MCP handler and the REST route can serialize.

export const DEFAULT_HELP_SITE_URL = 'https://help.aquilla.app'

export interface HelpSiteEnv {
  /** Optional override of the help site origin (staging, local). */
  HELP_SITE_URL?: string
}

export type HelpResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; code: 'not_found' | 'job_failed'; message: string; details?: Record<string, unknown> }

interface HelpPageEntry {
  path: string
  title: string
  description: string
  section: string
  url: string
  markdownUrl: string
}

interface HelpIndex {
  site: string
  pages: HelpPageEntry[]
}

class HelpUpstreamError extends Error {}

export function helpSiteBase(env: HelpSiteEnv): string {
  const raw = env.HELP_SITE_URL?.trim()
  return (raw && raw.length > 0 ? raw : DEFAULT_HELP_SITE_URL).replace(/\/+$/, '')
}

function unavailable(base: string): HelpResult {
  return {
    ok: false,
    code: 'job_failed',
    message: `help site unavailable, try again later; the pages are also readable at ${base}`,
  }
}

function notFound(input: string): HelpResult {
  return {
    ok: false,
    code: 'not_found',
    message: `unknown help page "${input}"`,
    details: { hint: 'call get_help with no page for the index of pages' },
  }
}

function sameHost(url: string, host: string): boolean {
  try {
    return new URL(url).host === host
  } catch {
    return false
  }
}

function toEntry(raw: unknown, host: string): HelpPageEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.path !== 'string' || typeof r.title !== 'string') return null
  if (typeof r.url !== 'string' || typeof r.markdownUrl !== 'string') return null
  if (!sameHost(r.url, host) || !sameHost(r.markdownUrl, host)) return null
  return {
    path: r.path,
    title: r.title,
    description: typeof r.description === 'string' ? r.description : '',
    section: typeof r.section === 'string' ? r.section : '',
    url: r.url,
    markdownUrl: r.markdownUrl,
  }
}

async function loadIndex(base: string, host: string): Promise<HelpIndex> {
  const res = await fetch(`${base}/llms-index.json`, { cf: { cacheTtl: 300, cacheEverything: true } })
  if (!res.ok) throw new HelpUpstreamError(`index HTTP ${res.status}`)
  let raw: unknown
  try {
    raw = await res.json()
  } catch {
    throw new HelpUpstreamError('index is not JSON')
  }
  const doc = (raw ?? {}) as { site?: unknown; pages?: unknown }
  if (!Array.isArray(doc.pages)) throw new HelpUpstreamError('index has no pages array')
  const pages = doc.pages.map((p) => toEntry(p, host)).filter((p): p is HelpPageEntry => p !== null)
  return { site: typeof doc.site === 'string' ? doc.site : base, pages }
}

/** Turns a caller's page input into the index's path form ("/export/").
 *  Accepts "export", "/export", "export/", "/export/", "/" and a URL on the
 *  help site. Returns null for a URL on any other host. */
export function normalizeHelpPath(input: string, host: string): string | null {
  let s = input.trim()
  if (/^https?:\/\//i.test(s)) {
    let url: URL
    try {
      url = new URL(s)
    } catch {
      return null
    }
    if (url.host !== host) return null
    s = url.pathname
  }
  s = s.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '')
  return s === '' ? '/' : `/${s}/`
}

/** The index: every page's path, title, description, section and url. */
export async function helpIndex(env: HelpSiteEnv): Promise<HelpResult> {
  const base = helpSiteBase(env)
  try {
    const index = await loadIndex(base, new URL(base).host)
    return {
      ok: true,
      body: {
        site: index.site,
        pages: index.pages.map(({ path, title, description, section, url }) => ({
          path, title, description, section, url,
        })),
        note: 'Call get_help({ page }) with a path from this list for its Markdown. The whole site is also at ' +
          `${base}/llms-full.txt.`,
      },
    }
  } catch {
    return unavailable(base)
  }
}

/** One page's Markdown. Only a page listed in the index is fetched. */
export async function helpPage(env: HelpSiteEnv, input: string): Promise<HelpResult> {
  const base = helpSiteBase(env)
  try {
    const host = new URL(base).host
    const index = await loadIndex(base, host)
    const path = normalizeHelpPath(input, host)
    const entry = path === null
      ? undefined
      : index.pages.find((p) => p.path.toLowerCase() === path.toLowerCase())
    if (!entry) return notFound(input)
    const res = await fetch(entry.markdownUrl, { cf: { cacheTtl: 300, cacheEverything: true } })
    if (!res.ok) throw new HelpUpstreamError(`page HTTP ${res.status}`)
    const markdown = await res.text()
    return { ok: true, body: { path: entry.path, title: entry.title, url: entry.url, markdown } }
  } catch {
    return unavailable(base)
  }
}
