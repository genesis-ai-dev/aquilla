// App-help routes (AQU-2581) — the REST half of the MCP get_help tool.
//
//   GET /api/v1/external/help          — index of help pages
//   GET /api/v1/external/help/:page    — one page as Markdown (e.g. help/export/)
//
// Deliberately UNAUTHENTICATED, like /skills: public help text from the help
// site, no project data, the same bytes for every caller. Reads go through
// help-site.ts, which fetches only pages listed in the site's index.
//
// Mounted in index.ts just after handleExternalSkillsRequest.

import { helpIndex, helpPage, type HelpSiteEnv } from './help-site'
import { errorResponse } from './errors'

const HELP_INDEX_RE = /^\/api\/v1\/external\/help\/?$/
const HELP_PAGE_RE = /^\/api\/v1\/external\/help\/(.+)$/

function decodePage(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export async function handleExternalHelpRequest(request: Request, env: HelpSiteEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname

  const isIndex = HELP_INDEX_RE.test(path)
  const pageMatch = path.match(HELP_PAGE_RE)
  if (!isIndex && !pageMatch) return null

  if (request.method !== 'GET') {
    return Response.json(
      { error: { code: 'validation_failed', message: `use GET ${path} — help pages are read-only` } },
      { status: 405, headers: { Allow: 'GET' } },
    )
  }

  const result = isIndex
    ? await helpIndex(env)
    : await helpPage(env, decodePage((pageMatch as RegExpMatchArray)[1]))
  if (!result.ok) return errorResponse(result.code, result.message, result.details)
  return Response.json(result.body)
}
