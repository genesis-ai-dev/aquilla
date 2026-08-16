/**
 * Agent-API helpers for E2E specs: mint an `aqk_` API credential (the PATs the
 * external Agent API authenticates with) and drive the changeset lifecycle
 * (stage → commit) against the local sync-worker, exactly as an external agent
 * would over REST.
 *
 * Mirrors the split in production:
 *   - credentials are minted on auth-worker (`/api/v2/credentials`, browser JWT)
 *   - changesets are staged/committed on sync-worker
 *     (`/api/v1/external/projects/:id/changesets`, Bearer aqk_ token)
 *   - the one-time human approval happens in the SPA (`/approve/:changesetId`),
 *     which POSTs to auth-worker `/api/v2/changesets/:id/approve` — specs drive
 *     that part through the UI, never through this helper.
 */

const FRONTIER_BASE = process.env.VITE_FRONTIER_BASE ?? "http://127.0.0.1:8787"
const SYNC_BASE = `http://${process.env.VITE_SYNC_WORKER_HOST ?? "127.0.0.1:8788"}`

export interface MintedCredential {
  /** Plaintext `aqk_…` token — returned exactly once by the mint endpoint. */
  token: string
  credentialId: string
}

/** POST /api/v2/credentials — mint an API credential for the JWT's user.
 * `mode: "ask"` keeps every commit behind the human approval gate. */
export async function mintApiCredential(
  jwt: string,
  opts: { name?: string; mode?: "ask" | "act"; projectId?: string; orgId?: string } = {},
): Promise<MintedCredential> {
  const r = await fetch(`${FRONTIER_BASE}/api/v2/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      name: opts.name ?? "e2e agent credential",
      mode: opts.mode ?? "ask",
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.orgId ? { orgId: opts.orgId } : {}),
    }),
  })
  if (!r.ok) throw new Error(`mintApiCredential failed: HTTP ${r.status} — ${await r.text()}`)
  const body = (await r.json()) as { token: string; credential: { id: string } }
  return { token: body.token, credentialId: body.credential.id }
}

export interface SetTranslationSpec {
  fileId: string
  cellId: string
  value: string
  valueHtml?: string
  laneId?: string
}

export interface StagedChangesetResponse {
  changeset: {
    id: string
    status: string
    autonomyMode: string
    digest: string
  }
  summary: {
    translationsAdded?: number
    translationsModified?: number
    warnings: { code: string; message: string }[]
  }
  digest: string
  approvalUrl: string
}

/** POST /api/v1/external/projects/:id/changesets — stage a SetTranslation plan. */
export async function stageSetTranslationChangeset(
  apiToken: string,
  projectId: string,
  commands: SetTranslationSpec[],
): Promise<StagedChangesetResponse> {
  const r = await fetch(`${SYNC_BASE}/api/v1/external/projects/${projectId}/changesets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
    body: JSON.stringify({
      commands: commands.map((c) => ({ kind: "SetTranslation", ...c })),
    }),
  })
  if (!r.ok) {
    throw new Error(`stage changeset failed: HTTP ${r.status} — ${await r.text()}`)
  }
  return (await r.json()) as StagedChangesetResponse
}

export interface CommitResult {
  status: number
  receipt?: { eventIds: string[]; appliedCount: number; staleCount: number }
  error?: { code: string; message: string }
}

/** POST /api/v1/external/projects/:id/changesets/:csId/commit.
 * Never throws on an HTTP error — ask-mode specs assert on the
 * `confirmation_required` rejection as readily as on the success receipt. */
export async function commitChangeset(
  apiToken: string,
  projectId: string,
  changesetId: string,
): Promise<CommitResult> {
  const r = await fetch(
    `${SYNC_BASE}/api/v1/external/projects/${projectId}/changesets/${changesetId}/commit`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({}),
    },
  )
  const body = (await r.json()) as {
    receipt?: CommitResult["receipt"]
    error?: CommitResult["error"]
  }
  return { status: r.status, receipt: body.receipt, error: body.error }
}
