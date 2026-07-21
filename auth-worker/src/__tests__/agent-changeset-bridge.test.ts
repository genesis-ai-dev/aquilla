// AQU-AGENT §2 — changeset-bridge.
//
// WHY: this is the harness's ONLY write path to project data, and its safety
// rests on two invariants contracts §2 makes non-negotiable — the minted
// credential is ASK-mode + project-scoped (a human is always the write gate),
// and the plaintext token never escapes. These tests freeze both, plus the
// mint→revoke lifecycle and the cell-shape mapping the sync-worker expects.
import { env } from "cloudflare:test"
import { describe, it, expect, afterEach, vi } from "vitest"
import { seedUser } from "./helpers/db"
import {
  stageImportViaChangeset,
  revokeRunCredential,
} from "../lib/agent/changeset-bridge"

const PROJECT = "11111111-1111-4111-8111-111111111111"
const RUN = "run-abc"

function bridgeEnv() {
  return env as unknown as { AQUILLA_PG: typeof env.AQUILLA_PG; SYNC_WORKER_URL?: string }
}

afterEach(() => vi.restoreAllMocks())

describe("changeset-bridge — stageImportViaChangeset", () => {
  it("mints an ask-mode project-scoped credential, forwards a PlanImport, and returns the changeset", async () => {
    await seedUser(1, "alice")

    let captured: { url: string; auth: string; body: Record<string, unknown> } | null = null
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      captured = {
        url: String(url),
        auth: String((init?.headers as Record<string, string>).Authorization),
        body: JSON.parse(String(init?.body)),
      }
      return new Response(
        JSON.stringify({
          changeset: { id: "cs-123" },
          summary: { sourceCellsAdded: 2, warnings: [] },
          approvalUrl: "https://aquilla.app/approve/cs-123",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    })

    const { result, credential } = await stageImportViaChangeset(bridgeEnv(), {
      userId: 1,
      projectId: PROJECT,
      runId: RUN,
      request: {
        fileName: "genesis.usfm",
        fileType: "usfm",
        sourceLanguage: "en",
        cells: [
          { original: "In the beginning", group: "GEN 1", type: "verse" },
          { id: "c2", original: "And the earth", translated: "ignored", context: "ctx" },
        ],
      },
    })

    // Result surface.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.staged.changesetId).toBe("cs-123")
    expect(result.staged.approvalUrl).toBe("https://aquilla.app/approve/cs-123")
    expect(result.staged.cellCount).toBe(2)

    // The request: ask-mode, correct URL, aqk_ bearer, mapped cells.
    expect(captured).not.toBeNull()
    expect(captured!.url).toBe(
      `https://api.aquilla.app/sync/api/v1/external/projects/${PROJECT}/changesets`,
    )
    expect(captured!.auth.startsWith("Bearer aqk_")).toBe(true)
    expect(captured!.body.autonomyMode).toBe("ask")
    const commands = captured!.body.commands as Array<Record<string, unknown>>
    expect(commands).toHaveLength(1)
    expect(commands[0].kind).toBe("PlanImport")
    const cells = commands[0].cells as Array<Record<string, unknown>>
    // original→content, group→section, type kept; translated/context dropped.
    expect(cells[0]).toEqual({ content: "In the beginning", section: "GEN 1", type: "verse" })
    expect(cells[1]).toEqual({ content: "And the earth", id: "c2" })

    // The credential row: ask mode, project-scoped, named agent-run:<runId>.
    const row = await env.AQUILLA_PG.prepare(
      "SELECT mode, project_id, name, revoked_at FROM api_credentials WHERE id = ?",
    )
      .bind(credential!.credentialId)
      .first<{ mode: string; project_id: string; name: string; revoked_at: string | null }>()
    expect(row?.mode).toBe("ask")
    expect(row?.project_id).toBe(PROJECT)
    expect(row?.name).toBe(`agent-run:${RUN}`)
    expect(row?.revoked_at).toBeNull()

    // revoke closes the credential.
    await revokeRunCredential(bridgeEnv(), credential)
    const revoked = await env.AQUILLA_PG.prepare(
      "SELECT revoked_at FROM api_credentials WHERE id = ?",
    )
      .bind(credential!.credentialId)
      .first<{ revoked_at: string | null }>()
    expect(revoked?.revoked_at).not.toBeNull()
  })

  it("never returns act-mode even if somehow requested — the credential is ask", async () => {
    await seedUser(1, "alice")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ changeset: { id: "cs-x" }, summary: { sourceCellsAdded: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const { credential } = await stageImportViaChangeset(bridgeEnv(), {
      userId: 1,
      projectId: PROJECT,
      runId: RUN,
      request: { fileName: "f", fileType: "usfm", cells: [{ original: "x" }] },
    })
    const row = await env.AQUILLA_PG.prepare("SELECT mode FROM api_credentials WHERE id = ?")
      .bind(credential!.credentialId)
      .first<{ mode: string }>()
    expect(row?.mode).toBe("ask")
  })

  it("surfaces a sync-worker error but keeps the credential for run-end revoke", async () => {
    await seedUser(1, "alice")
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "validation_failed", message: "too big" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const { result, credential } = await stageImportViaChangeset(bridgeEnv(), {
      userId: 1,
      projectId: PROJECT,
      runId: RUN,
      request: { fileName: "f", fileType: "usfm", cells: [{ original: "x" }] },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("validation_failed")
    // The credential still exists (revoked later by the run), not orphaned live.
    expect(credential).not.toBeNull()
  })

  it("returns a clear error when SYNC_WORKER_URL is unset (no credential minted)", async () => {
    const noSync = { AQUILLA_PG: env.AQUILLA_PG, SYNC_WORKER_URL: undefined }
    const { result, credential } = await stageImportViaChangeset(noSync, {
      userId: 1,
      projectId: PROJECT,
      runId: RUN,
      request: { fileName: "f", fileType: "usfm", cells: [{ original: "x" }] },
    })
    expect(result.ok).toBe(false)
    expect(credential).toBeNull()
  })
})
