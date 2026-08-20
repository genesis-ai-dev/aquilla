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
