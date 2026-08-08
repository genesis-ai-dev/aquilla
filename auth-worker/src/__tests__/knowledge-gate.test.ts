import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { isKnowledgeBaseEnabled } from "../lib/knowledge/gate"

describe("isKnowledgeBaseEnabled", () => {
  it("false when no settings row / key absent; true only for explicit true", async () => {
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('pg1', 'P', 1)").run()
    expect(await isKnowledgeBaseEnabled(env.AQUILLA_PG, "pg1")).toBe(false)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES ('pg1', ?, 1, 1)",
    ).bind(JSON.stringify({ knowledgeBaseEnabled: true })).run()
    expect(await isKnowledgeBaseEnabled(env.AQUILLA_PG, "pg1")).toBe(true)
  })
})
