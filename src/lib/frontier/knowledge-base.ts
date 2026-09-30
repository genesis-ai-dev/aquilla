import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"

export type KnowledgeIndexStatus = "pending" | "ready" | "failed"

export interface KnowledgeDocument {
  id: string
  orgId: number | null
  projectId: string | null
  scope: "project" | "org"
  name: string
  contentType: string | null
  sizeBytes: number
  sha256: string
  r2Key: string
  docSummary: string | null
  indexStatus: KnowledgeIndexStatus
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface KnowledgeNode {
  id: string
  title: string
  summary?: string
  charStart: number
  charEnd: number
  children?: KnowledgeNode[]
}

export type KnowledgeScope =
  | { kind: "project"; id: string }
  | { kind: "org"; id: number }

/**
 * AQU-1376: how long a doc may sit at `pending` before we call it stalled.
 *
 * Indexing is a fire-and-forget `waitUntil` job in auth-worker; nothing revisits
 * the row afterwards. If the worker is evicted mid-job — or the compensating
 * `index_status = 'failed'` write is itself what failed — the row stays
 * `pending` forever, and "Indexing…" becomes a lie no reload will correct. Past
 * this window the job cannot still be running, so the read side says so and
 * offers a retry instead.
 *
 * Deliberately well above the worker's own enrichment ceiling
 * (`KB_INDEX_FETCH_TIMEOUT_MS`, 60s, in
 * auth-worker/src/lib/knowledge/index-doc.ts) so a job still inside its budget
 * is never flagged: a real run either finishes or self-aborts long before this.
 * Keep the two in step if either moves.
 */
export const KB_INDEX_STALE_MS = 5 * 60_000

/**
 * True when `doc` is pending but too old for its job to still be alive. Only
 * `pending` can stall — `ready` and `failed` are terminal, and `failed` already
 * has its own badge and retry.
 */
export function isKnowledgeIndexStalled(
  doc: Pick<KnowledgeDocument, "indexStatus" | "updatedAt">,
  now: number = Date.now(),
): boolean {
  if (doc.indexStatus !== "pending") return false
  const updatedAt = Date.parse(doc.updatedAt)
  // An unparseable timestamp is a server contract break, not evidence of a
  // stall — don't offer a retry on a guess.
  if (Number.isNaN(updatedAt)) return false
  return now - updatedAt > KB_INDEX_STALE_MS
}

export class KnowledgeBaseApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Knowledge Base request failed (${status})`)
    this.status = status
  }
}

function scopePath(scope: KnowledgeScope): string {
  return scope.kind === "project"
    ? `/api/v2/projects/${encodeURIComponent(scope.id)}/knowledge`
    : `/api/v2/orgs/${encodeURIComponent(String(scope.id))}/knowledge`
}

async function request(scope: KnowledgeScope, jwt: string, suffix = "", init: RequestInit = {}) {
  const response = await fetchWithTimeout(`${AUTH_BASE}${scopePath(scope)}${suffix}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      ...init.headers,
    },
  })
  if (!response.ok) throw new KnowledgeBaseApiError(response.status)
  return response
}

export async function listKnowledgeDocuments(
  scope: KnowledgeScope,
  jwt: string,
): Promise<KnowledgeDocument[]> {
  const response = await request(scope, jwt)
  const body = (await response.json()) as { docs: KnowledgeDocument[] }
  return body.docs
}

export async function getKnowledgeDocument(
  scope: KnowledgeScope,
  jwt: string,
  docId: string,
): Promise<{ doc: KnowledgeDocument; tree: KnowledgeNode[] | null }> {
  const response = await request(scope, jwt, `/${encodeURIComponent(docId)}`)
  return response.json() as Promise<{ doc: KnowledgeDocument; tree: KnowledgeNode[] | null }>
}

export async function getKnowledgeDocumentContent(
  scope: KnowledgeScope,
  jwt: string,
  docId: string,
  nodeId?: string,
): Promise<string> {
  const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ""
  const response = await request(
    scope,
    jwt,
    `/${encodeURIComponent(docId)}/content${query}`,
  )
  const body = (await response.json()) as { text: string }
  return body.text
}

export async function uploadKnowledgeDocument(
  scope: KnowledgeScope,
  jwt: string,
  file: File,
): Promise<KnowledgeDocument> {
  const response = await request(scope, jwt, "", {
    method: "POST",
    headers: { "x-doc-name": encodeURIComponent(file.name) },
    body: file,
  })
  const body = (await response.json()) as { doc: KnowledgeDocument }
  return body.doc
}

export async function deleteKnowledgeDocument(
  scope: KnowledgeScope,
  jwt: string,
  docId: string,
): Promise<void> {
  await request(scope, jwt, `/${encodeURIComponent(docId)}`, { method: "DELETE" })
}

export async function reindexKnowledgeDocument(
  scope: KnowledgeScope,
  jwt: string,
  docId: string,
): Promise<void> {
  await request(scope, jwt, `/${encodeURIComponent(docId)}/reindex`, { method: "POST" })
}

export async function getKnowledgeDocumentOriginal(
  scope: KnowledgeScope,
  jwt: string,
  docId: string,
): Promise<Blob> {
  const response = await request(scope, jwt, `/${encodeURIComponent(docId)}/original`)
  return response.blob()
}
