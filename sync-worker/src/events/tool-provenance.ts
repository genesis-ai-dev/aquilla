// Aquilla Tools (prototype) — server-stamped provenance for tool writes.
//
// A tool's writes are ordinary in-app events (same outbox, same authorize(),
// same head CAS). The host tags each with `payload.tool_origin =
// {origin:'tool', toolId, version, codeHash}`. That tag is caller-declared, so
// after the events commit this module checks it against project_tool_versions
// (the tool, version and hash must exist IN THIS PROJECT) and stamps the
// trusted envelope into events.provenance — the column the Agent API path
// already uses (AQU-533), so "what touched this cell" has one place to look.
//
// `verified:false` keeps the claim on record without vouching for it (an old
// version, a forged hash). Stamping is best-effort: a failure here never fails
// the write, it only leaves provenance NULL, same as any in-app edit.

import { isToolOrigin, type ToolOrigin } from '../../../shared/tools/manifest'

export interface ToolProvenanceCandidate {
  id: string
  projectId: string
  /** Verified author (from the sync token), not the client's claim. */
  author: string
  payload: unknown
}

export interface ToolProvenanceEnvelope {
  origin: 'tool'
  toolId: string
  version: number
  codeHash: string
  verified: boolean
  human_authority: { user_id: string }
  channel: 'in-app'
}

export function toolOriginOf(payload: unknown): ToolOrigin | null {
  if (!payload || typeof payload !== 'object') return null
  const tag = (payload as Record<string, unknown>).tool_origin
  return isToolOrigin(tag) ? tag : null
}

export async function stampToolProvenance(
  db: AquillaDb,
  candidates: readonly ToolProvenanceCandidate[],
): Promise<number> {
  const tagged = candidates
    .map((c) => ({ c, origin: toolOriginOf(c.payload) }))
    .filter((x): x is { c: ToolProvenanceCandidate; origin: ToolOrigin } => x.origin !== null)
  if (tagged.length === 0) return 0

  // One lookup for every (project, tool, version, hash) claimed in the batch.
  const claims = [...new Map(tagged.map(({ c, origin }) => [
    `${c.projectId}|${origin.toolId}|${origin.version}|${origin.codeHash}`,
    { projectId: c.projectId, origin },
  ])).values()]
  const where = claims.map(() => '(project_id = ? AND tool_id = ? AND version = ? AND code_hash = ?)').join(' OR ')
  const binds = claims.flatMap(({ projectId, origin }) => [projectId, origin.toolId, origin.version, origin.codeHash])
  const { results } = await db
    .prepare(`SELECT project_id, tool_id, version, code_hash FROM project_tool_versions WHERE ${where}`)
    .bind(...binds)
    .all<{ project_id: string; tool_id: string; version: number; code_hash: string }>()
  const known = new Set(results.map((r) => `${r.project_id}|${r.tool_id}|${Number(r.version)}|${r.code_hash}`))

  for (const { c, origin } of tagged) {
    const envelope: ToolProvenanceEnvelope = {
      origin: 'tool',
      toolId: origin.toolId,
      version: origin.version,
      codeHash: origin.codeHash,
      verified: known.has(`${c.projectId}|${origin.toolId}|${origin.version}|${origin.codeHash}`),
      human_authority: { user_id: c.author },
      channel: 'in-app',
    }
    await db
      .prepare(`UPDATE events SET provenance = ?::text::jsonb WHERE id = ? AND provenance IS NULL`)
      .bind(JSON.stringify(envelope), c.id)
      .run()
  }
  return tagged.length
}
