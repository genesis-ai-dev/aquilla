// External style-rules read surface (AQU-2195).
//
//   GET /api/v1/external/projects/:projectId/style-rules?status=&limit=&cursor=
//
// The Style rules section of the Rules page (the `style_rules` table) was out
// of an agent's reach: "Extract from knowledge base" proposes rules by the
// hundred and only a person in the app could read them. This route returns the
// same rows the in-app list does (the project's own rules plus its org's shared
// ones) so an agent can decide which to approve, reject or edit with the
// ReviewStyleRules command (commands-style-rules.ts).
//
// It delegates to `db/shared/style-rules.ts`, the module auth-worker's
// /style-rules routes use, so the rows, the status filter and the ordering
// (newest first) cannot drift from the app's. Auth, scope and throttle are the
// read tier's shared gate (read-auth.ts): credential, project scope, live role
// of VIEWER. A read-only credential may call it.

import {
  STYLE_RULE_STATUSES,
  listRulesForProject,
  type StyleRule,
  type StyleRuleStatus,
} from '../../../db/shared/style-rules'
import { externalError } from './errors'
import { authenticateAndScope, checkReadRateLimit, type ExternalReadsEnv } from './read-auth'
import { paginate, parsePageParams } from './pagination'

const STYLE_RULES_RE = /^\/api\/v1\/external\/projects\/([^/]+)\/style-rules$/

/** A project's extraction run can propose a few hundred rules; the default page
 *  holds them all so an agent reads once, and the cap keeps a page bounded. */
const STYLE_RULES_DEFAULT_LIMIT = 100
const STYLE_RULES_MAX_LIMIT = 500

interface ExternalStyleRule {
  id: string
  instruction: string
  category: StyleRule['category']
  scope: StyleRule['scope']
  severity: StyleRule['severity']
  enabled: boolean
  status: StyleRuleStatus
  /** Send this back as `ifMatchVersion` in a ReviewStyleRules decision. */
  version: number
  humanEdited: boolean
  source: StyleRule['source']
  /** The cited knowledge document's name, when `source` is a knowledge-doc
   *  that still exists. */
  sourceDocTitle?: string
  /** True for a rule the project's org shares. It is shown and applied here,
   *  but cannot be reviewed or edited through the project. */
  inherited: boolean
}

async function docTitles(
  db: AquillaDb,
  projectId: string,
  docIds: string[],
): Promise<Map<string, string>> {
  if (docIds.length === 0) return new Map()
  const marks = docIds.map(() => '?').join(', ')
  const rows = await db
    .prepare(
      `SELECT id::text AS id, name FROM knowledge_docs
        WHERE id::text IN (${marks})
          AND (project_id = ? OR org_id = (SELECT org_id FROM projects WHERE id = ?))`,
    )
    .bind(...docIds, projectId, projectId)
    .all<{ id: string; name: string }>()
  return new Map(rows.results.map((r) => [r.id, r.name]))
}

async function handleList(
  request: Request,
  env: ExternalReadsEnv,
  projectId: string,
): Promise<Response> {
  const authed = await authenticateAndScope(request, env, projectId)
  if (!authed.ok) return authed.response
  const db = env.AQUILLA_PG as AquillaDb
  const limited = await checkReadRateLimit(db, authed.ctx.credential)
  if (limited) return limited

  const url = new URL(request.url)
  const qStatus = url.searchParams.get('status')
  if (qStatus !== null && !(STYLE_RULE_STATUSES as readonly string[]).includes(qStatus)) {
    return externalError(
      'validation_failed',
      `invalid status "${qStatus}" — one of ${STYLE_RULE_STATUSES.join('|')}`,
      400,
    )
  }
  const { limit, offset } = parsePageParams(url, {
    defaultLimit: STYLE_RULES_DEFAULT_LIMIT,
    maxLimit: STYLE_RULES_MAX_LIMIT,
  })

  const { rules } = await listRulesForProject(db, projectId, (qStatus as StyleRuleStatus | null) ?? undefined)
  const page = paginate(rules, offset, limit)

  const docIds = [
    ...new Set(
      page.data.flatMap((r) => (r.source?.kind === 'knowledge-doc' ? [r.source.docId] : [])),
    ),
  ]
  const titles = await docTitles(db, projectId, docIds)

  const data: ExternalStyleRule[] = page.data.map((r) => {
    const title = r.source?.kind === 'knowledge-doc' ? titles.get(r.source.docId) : undefined
    return {
      id: r.id,
      instruction: r.instruction,
      category: r.category,
      scope: r.scope,
      severity: r.severity,
      enabled: r.enabled,
      status: r.status,
      version: r.version,
      humanEdited: r.humanEdited,
      source: r.source,
      ...(title !== undefined ? { sourceDocTitle: title } : {}),
      inherited: r.projectId !== projectId,
    }
  })

  return Response.json({
    data,
    nextCursor: page.nextCursor,
    total: rules.length,
    hints: {
      review:
        'Approve, reject or edit rules with a ReviewStyleRules changeset (describe_command ReviewStyleRules). Send each rule\'s version back as ifMatchVersion. Only approved, enabled rules reach the copilot; rows with inherited: true belong to the org and are refused.',
    },
  })
}

export async function handleExternalStyleRulesReadRequest(
  request: Request,
  env: ExternalReadsEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const m = url.pathname.match(STYLE_RULES_RE)
  if (!m) return null

  // Claim the path on the wrong verb so a POST gets a 405 naming the right
  // method rather than discovery's "no route matches" 404.
  if (request.method !== 'GET') {
    return Response.json(
      {
        error: {
          code: 'validation_failed',
          message: `${url.pathname} is read-only — use GET. Style rules are changed through a ReviewStyleRules changeset (POST .../changesets), never by writing to this path.`,
        },
      },
      { status: 405, headers: { Allow: 'GET' } },
    )
  }
  return handleList(request, env, decodeURIComponent(m[1]))
}
