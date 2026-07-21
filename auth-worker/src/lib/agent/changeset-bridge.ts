// AQU-AGENT §2 — changeset-bridge.
//
// The harness stages writes through the EXISTING external changeset layer
// (sync-worker/src/external). To do that it mints an ephemeral, project-scoped,
// ASK-mode `aqk_` credential for the run's user, then POSTs a PlanImport
// changeset to sync-worker with the plaintext token. A human approves it at
// the existing /approve/:changesetId page.
//
// Invariants (contracts §2 — do NOT relax):
//   - mode is ALWAYS 'ask' (never act-mode; the human is the write gate).
//   - project-scoped, expires_at = now()+2h, name `agent-run:<runId>`.
//   - the plaintext token NEVER leaves this module — not in SSE frames, not in
//     persistence, not in logs.
//   - best-effort revoke at run end (revokeRunCredential).

import { mintApiToken } from "../../../../db/shared/api-credentials"

/** Ephemeral-credential lifetime: 2 hours (contracts §2). */
const CREDENTIAL_TTL_MS = 2 * 60 * 60 * 1000

/** The env surface the bridge needs. */
export interface ChangesetBridgeEnv {
  AQUILLA_PG: AquillaDb
  /** sync-worker base URL (exists in dev/staging/prod wrangler vars). */
  SYNC_WORKER_URL?: string
}

/** One source cell in a PlanImport request (harness tool `plan_import`). */
export interface PlanImportCellInput {
  id?: string
  original: string
  translated?: string
  context?: string
  group?: string
  type?: string
}

export interface PlanImportRequest {
  fileName: string
  fileType: string
  sourceLanguage?: string
  targetLanguage?: string
  cells: PlanImportCellInput[]
}

/** What the harness surfaces after a successful stage (→ changeset.staged frame). */
export interface StagedChangeset {
  changesetId: string
  approvalUrl: string
  summary: string
  cellCount: number
}

export type StageResult =
  | { ok: true; staged: StagedChangeset }
  | { ok: false; error: string }

/** Handle to the minted credential so the run can revoke it at the end. Holds
 *  only the row id — never the plaintext token. */
export interface RunCredential {
  credentialId: string
}

/**
 * Mint the ephemeral ask-mode, project-scoped credential for a run. Returns the
 * plaintext token (used ONLY for the immediate sync-worker call by the caller
 * in this module) plus the credential id for later revoke. Not exported: the
 * token must not escape stageImportViaChangeset.
 */
async function mintRunCredential(
  env: ChangesetBridgeEnv,
  opts: { userId: number; projectId: string; runId: string },
): Promise<{ token: string; credentialId: string }> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  const id = crypto.randomUUID()
  const expiresAt = new Date(Date.now() + CREDENTIAL_TTL_MS).toISOString()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO api_credentials
        (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id, expires_at)
     VALUES (?, ?, ?, ?, ?, 'ask', NULL, ?, ?)`,
  )
    .bind(
      id,
      String(opts.userId),
      `agent-run:${opts.runId}`,
      tokenPrefix,
      tokenHash,
      opts.projectId,
      expiresAt,
    )
    .run()
  return { token, credentialId: id }
}

/** Revoke a run's ephemeral credential (best-effort; never throws). */
export async function revokeRunCredential(
  env: ChangesetBridgeEnv,
  cred: RunCredential | null,
): Promise<void> {
  if (!cred) return
  try {
    await env.AQUILLA_PG.prepare(
      `UPDATE api_credentials SET revoked_at = now() WHERE id = ? AND revoked_at IS NULL`,
    )
      .bind(cred.credentialId)
      .run()
  } catch (err) {
    console.warn("[changeset-bridge] credential revoke failed (non-fatal):", err)
  }
}

/** Map the harness `plan_import` cells to sync-worker PlanImportCell shape.
 *  `original`→`content`, `group`→`section`, `type`→`type`. The `translated`
 *  and `context` fields have no home in a source-only PlanImport (it seeds
 *  source cells, not target commits) — they are intentionally dropped here.
 *  SWARM-TODO(aqu-agent): a follow-up SetTranslation changeset could carry the
 *  `translated` values once a create-then-translate flow exists (Wave-3 TRACE). */
function toCommandCells(cells: PlanImportCellInput[]): Array<Record<string, unknown>> {
  return cells.map((c) => {
    const cell: Record<string, unknown> = { content: c.original }
    if (c.id) cell.id = c.id
    if (c.group) cell.section = c.group
    if (c.type) cell.type = c.type
    return cell
  })
}

interface PrepareResponse {
  changeset?: { id?: string }
  summary?: { sourceCellsAdded?: number; warnings?: unknown[] }
  approvalUrl?: string
}

/** Build a one-line human summary from the prepare response. */
function summarize(req: PlanImportRequest, resp: PrepareResponse): string {
  const n = resp.summary?.sourceCellsAdded ?? req.cells.length
  const warnCount = Array.isArray(resp.summary?.warnings) ? resp.summary!.warnings!.length : 0
  const warnSuffix = warnCount > 0 ? ` (${warnCount} warning${warnCount === 1 ? "" : "s"})` : ""
  return `Import "${req.fileName}" (${req.fileType}) — ${n} source cell${n === 1 ? "" : "s"}${warnSuffix}`
}

/**
 * Stage a PlanImport changeset for the run's user. Mints the ephemeral
 * credential, POSTs to sync-worker external prepare, and returns the staged
 * changeset facts. The caller owns the returned RunCredential and must call
 * revokeRunCredential at run end.
 *
 * The mutation (credential row) is created only on the happy path up to the
 * POST; on ANY failure the credential is revoked before returning so a failed
 * stage never leaves a live token behind.
 */
export async function stageImportViaChangeset(
  env: ChangesetBridgeEnv,
  opts: { userId: number; projectId: string; runId: string; request: PlanImportRequest },
  signal?: AbortSignal,
): Promise<{ result: StageResult; credential: RunCredential | null }> {
  const base = env.SYNC_WORKER_URL?.trim()
  if (!base) {
    return {
      result: { ok: false, error: "changeset staging unavailable — SYNC_WORKER_URL is not configured" },
      credential: null,
    }
  }

  const { token, credentialId } = await mintRunCredential(env, {
    userId: opts.userId,
    projectId: opts.projectId,
    runId: opts.runId,
  })
  const credential: RunCredential = { credentialId }

  const command = {
    kind: "PlanImport",
    fileName: opts.request.fileName,
    fileType: opts.request.fileType,
    ...(opts.request.sourceLanguage ? { sourceLanguage: opts.request.sourceLanguage } : {}),
    ...(opts.request.targetLanguage ? { targetLanguage: opts.request.targetLanguage } : {}),
    cells: toCommandCells(opts.request.cells),
  }

  const url = `${base.replace(/\/$/, "")}/api/v1/external/projects/${encodeURIComponent(opts.projectId)}/changesets`

  let resp: PrepareResponse
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // autonomyMode is forced to 'ask'; the credential is ask-mode anyway so a
      // request can never upgrade it, but we pin it explicitly for clarity.
      body: JSON.stringify({ commands: [command], autonomyMode: "ask" }),
      signal,
    })
    if (!res.ok) {
      let msg = `changeset prepare failed (HTTP ${res.status})`
      try {
        const body = (await res.json()) as { error?: { code?: string; message?: string } }
        if (body?.error) msg = `${body.error.code ?? "error"}: ${body.error.message ?? msg}`
      } catch {
        /* non-JSON */
      }
      // Leave the credential live for the run (revoked at run end) — a
      // validation failure may be retried by the model with a smaller plan.
      return { result: { ok: false, error: msg }, credential }
    }
    resp = (await res.json()) as PrepareResponse
  } catch (err) {
    return {
      result: {
        ok: false,
        error: `changeset prepare unreachable — ${err instanceof Error ? err.message : String(err)}`,
      },
      credential,
    }
  }

  const changesetId = resp.changeset?.id
  if (!changesetId) {
    return { result: { ok: false, error: "changeset prepare returned no changeset id" }, credential }
  }

  return {
    result: {
      ok: true,
      staged: {
        changesetId,
        approvalUrl: resp.approvalUrl ?? "",
        summary: summarize(opts.request, resp),
        cellCount: resp.summary?.sourceCellsAdded ?? opts.request.cells.length,
      },
    },
    credential,
  }
}
