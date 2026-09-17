// Agent skill routes (AQU-1294 §2.3) — the REST half of the MCP get_skill tool.
//
//   GET /api/v1/external/skills        — index of every skill
//   GET /api/v1/external/skills/:name  — one skill's full Markdown body
//
// Serves the SHARED skill set (db/shared/agent-skills.ts) that the MCP
// get_skill tool and auth-worker's in-app harness (docs topic skills/<name>)
// also serve, so the three surfaces cannot disagree. Deliberately
// UNAUTHENTICATED, for the same reason as commands-doc-route.ts: static
// prose, no project data, the same bytes for every caller.
//
// Mounted in index.ts just before handleExternalCommandsDocRequest.

import { AGENT_SKILLS, getSkill } from '../../../db/shared/agent-skills'

const SKILLS_RE = /^\/api\/v1\/external\/skills$/
const SKILL_DETAIL_RE = /^\/api\/v1\/external\/skills\/([^/]+)$/

export function handleExternalSkillsRequest(request: Request): Response | null {
  const path = new URL(request.url).pathname

  const isIndex = SKILLS_RE.test(path)
  const detailMatch = path.match(SKILL_DETAIL_RE)
  if (!isIndex && !detailMatch) return null

  if (request.method !== 'GET') {
    return Response.json(
      { error: { code: 'validation_failed', message: `use GET ${path} — skills are read-only` } },
      { status: 405, headers: { Allow: 'GET' } },
    )
  }

  if (isIndex) {
    return Response.json({
      data: AGENT_SKILLS.map((s) => ({ name: s.name, title: s.title, oneLiner: s.oneLiner })),
      nextCursor: null,
      note: 'GET /api/v1/external/skills/:name for one skill’s full body. Over MCP, the same data is the get_skill tool.',
    })
  }

  const name = decodeURIComponent((detailMatch as RegExpMatchArray)[1])
  const skill = getSkill(name)
  if (!skill) {
    return Response.json(
      {
        error: {
          code: 'not_found',
          message: `unknown skill "${name}"`,
          details: { availableSkills: AGENT_SKILLS.map((s) => s.name) },
        },
      },
      { status: 404 },
    )
  }
  return Response.json({ name: skill.name, title: skill.title, oneLiner: skill.oneLiner, body: skill.body })
}
