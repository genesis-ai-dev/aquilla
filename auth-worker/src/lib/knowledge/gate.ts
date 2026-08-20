// knowledgeBaseEnabled gate — derive-on-read from project_settings, default
// false. Gates DRAFTING injection only; agent KB tools are never gated.
import type { AquillaDb } from "../../../../db/shim/postgres"

export async function isKnowledgeBaseEnabled(db: AquillaDb, projectId: string): Promise<boolean> {
  const enabled = await db.prepare(
    `SELECT settings::jsonb ->> 'knowledgeBaseEnabled' AS enabled
     FROM project_settings WHERE project_id = ?`,
  ).bind(projectId).first<string>("enabled")
  return enabled === "true"
}
