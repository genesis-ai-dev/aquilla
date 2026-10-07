// Command documentation routes (AQU-1222) — the REST half of describe_command.
//
//   GET /api/v1/external/commands        — index of every agent-reachable command
//   GET /api/v1/external/commands/:kind  — one command's full parameter doc
//
// Both serve the SHARED catalog (db/shared/command-catalog.ts) that the MCP
// describe_command tool and auth-worker's in-app harness serve, so the three
// surfaces can never disagree about what a command takes.
//
// Deliberately UNAUTHENTICATED, for the same reason as the discovery root: this
// is static documentation — no project data, no credential-specific values, the
// same bytes for every caller. get_capabilities has always published the command
// index to any valid credential; withholding the params doc behind auth only
// taught cold-start agents to reverse-engineer command shapes from
// validation_failed messages, which is the failure this route removes.
//
// Mounted in index.ts BEFORE the discovery 404 fallback (which claims every
// otherwise-unmatched /api/v1/external/* path).

import { COMMAND_CATALOG, type CommandCatalogEntry } from '../../../db/shared/command-catalog'

const COMMANDS_RE = /^\/api\/v1\/external\/commands$/
const COMMAND_DETAIL_RE = /^\/api\/v1\/external\/commands\/([^/]+)$/

/** Governance-only kinds are never offered on an agent surface — they stay
 *  indistinguishable from unknown here, exactly as in the MCP tool. */
function agentReachable(): CommandCatalogEntry[] {
  return COMMAND_CATALOG.filter((c) => c.agentReachable)
}

function indexEntry(c: CommandCatalogEntry) {
  return {
    kind: c.kind,
    title: c.title,
    tier: c.tier,
    minRoleLevel: c.minRoleLevel,
    oneLiner: c.oneLiner,
  }
}

export function handleExternalCommandsDocRequest(request: Request): Response | null {
  const url = new URL(request.url)
  const path = url.pathname

  const isIndex = COMMANDS_RE.test(path)
  const detailMatch = path.match(COMMAND_DETAIL_RE)
  if (!isIndex && !detailMatch) return null

  if (request.method !== 'GET') {
    return Response.json(
      {
        error: {
          code: 'validation_failed',
          message: `use GET ${path} — command docs are read-only`,
        },
      },
      { status: 405, headers: { Allow: 'GET' } },
    )
  }

  const commands = agentReachable()

  if (isIndex) {
    return Response.json({
      data: commands.map(indexEntry),
      nextCursor: null,
      note: 'GET /api/v1/external/commands/:kind for one command’s full parameter doc. Over MCP, the same data is the describe_command tool.',
    })
  }

  const kind = decodeURIComponent((detailMatch as RegExpMatchArray)[1])
  const entry = commands.find((c) => c.kind === kind)
  if (!entry) {
    return Response.json(
      {
        error: {
          code: 'not_found',
          message: `unknown command "${kind}"`,
          details: { availableKinds: commands.map((c) => c.kind) },
        },
      },
      { status: 404 },
    )
  }

  return Response.json({ ...indexEntry(entry), paramsDoc: entry.paramsDoc })
}
