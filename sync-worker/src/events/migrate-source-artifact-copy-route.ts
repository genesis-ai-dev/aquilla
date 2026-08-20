// POST /migrate/source-artifact-copy — trusted GitLab LFS → source artifact.
//
// Copies an immutable Codex original from the read-only LFS bucket into the
// live snapshots bucket, then atomically writes artifacts, artifact_bindings,
// and file_source_blobs through the same persistence helper as browser import.

import { sourceArtifactDescriptor } from "../../../shared/import-contract"
import { isAuthorizedAdminBearer } from "../lib/admin-auth"
import { gitlabLfsKey } from "./migrate-audio-copy-route"
import { buildSourceArtifactPersistenceStatements } from "./source-artifact-persistence"
import { sourceObjectKey } from "./source-upload-route"

const PATH = /^\/migrate\/source-artifact-copy\/?$/
const OID_RE = /^[0-9a-f]{64}$/
const UUID_NAMESPACE = "7f3c8a91-2b4d-4e6f-9a8c-1d3e5f2b4a6c"

export interface MigrateSourceArtifactCopyEnv {
  SNAPSHOTS: R2Bucket
  LFS_SRC?: R2Bucket
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

interface CopyBody {
  projectId?: unknown
  fileId?: unknown
  oid?: unknown
  size?: unknown
  name?: unknown
  artifactId?: unknown
  bindingId?: unknown
}

function uuidBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "")
  return Uint8Array.from({ length: 16 }, (_, index) => (
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  ))
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function uuidV5(seed: string): Promise<string> {
  const namespace = uuidBytes(UUID_NAMESPACE)
  const value = new TextEncoder().encode(seed)
  const input = new Uint8Array(namespace.byteLength + value.byteLength)
  input.set(namespace)
  input.set(value, namespace.byteLength)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input))
  const bytes = digest.slice(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  return formatUuid(bytes)
}

export async function deterministicSourceArtifactIds(
  projectId: string,
  fileId: string,
  sha256: string,
): Promise<{ artifactId: string; bindingId: string }> {
  const normalized = sha256.toLowerCase()
  return {
    artifactId: await uuidV5(`source-artifact:${projectId}:${fileId}:${normalized}`),
    bindingId: await uuidV5(`source-artifact-binding:${projectId}:${fileId}:${normalized}`),
  }
}

function dbShaHex(value: unknown): string {
  if (typeof value === "string") return value.replace(/^\\x/, "").toLowerCase()
  if (value instanceof Uint8Array) {
    return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }
  if (value instanceof ArrayBuffer) return dbShaHex(new Uint8Array(value))
  return ""
}

export async function handleMigrateSourceArtifactCopyRequest(
  request: Request,
  env: MigrateSourceArtifactCopyEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  if (!PATH.test(url.pathname)) return null
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  if (!isAuthorizedAdminBearer(request.headers.get("Authorization") ?? "", env)) {
    return new Response("unauthorized", { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response("AQUILLA_PG binding not configured", { status: 500 })
  if (!env.SNAPSHOTS) return new Response("SNAPSHOTS bucket not bound", { status: 500 })
  if (!env.LFS_SRC) return new Response("LFS_SRC bucket not bound", { status: 500 })

  let body: CopyBody
  try {
    body = await request.json() as CopyBody
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 })
  }
  const projectId = typeof body.projectId === "string" ? body.projectId : ""
  const fileId = typeof body.fileId === "string" ? body.fileId : ""
  const oid = typeof body.oid === "string" ? body.oid.toLowerCase() : ""
  const size = typeof body.size === "number" ? body.size : -1
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "original.idml"
  if (!projectId || !fileId || !OID_RE.test(oid) || !Number.isSafeInteger(size) || size <= 0) {
    return Response.json(
      { error: "projectId, fileId, a 64-hex oid, and positive integer size are required" },
      { status: 400 },
    )
  }

  const ids = await deterministicSourceArtifactIds(projectId, fileId, oid)
  if (
    (typeof body.artifactId === "string" && body.artifactId !== ids.artifactId)
    || (typeof body.bindingId === "string" && body.bindingId !== ids.bindingId)
  ) {
    return Response.json({ error: "artifact ids do not match deterministic source identity" }, { status: 409 })
  }

  const file = await env.AQUILLA_PG.prepare(
    `SELECT name, created_by FROM files WHERE id = ? AND project_id = ?`,
  ).bind(fileId, projectId).first<{ name: string; created_by: string }>()
  if (!file) return Response.json({ error: "file not found" }, { status: 404 })

  const key = sourceObjectKey(env, projectId, fileId, "idml", ids.artifactId)
  const existing = await env.AQUILLA_PG.prepare(
    `SELECT project_id, kind, sha256, r2_key, size_bytes
       FROM artifacts WHERE id::text = ?`,
  ).bind(ids.artifactId).first<{
    project_id: string
    kind: string
    sha256: unknown
    r2_key: string
    size_bytes: number
  }>()
  if (existing && (
    existing.project_id !== projectId
    || existing.kind !== "source"
    || dbShaHex(existing.sha256) !== oid
    || existing.r2_key !== key
    || Number(existing.size_bytes) !== size
  )) {
    return Response.json({ error: "artifact id already refers to different bytes" }, { status: 409 })
  }

  let copied = false
  const destination = await env.SNAPSHOTS.head(key)
  if (!destination) {
    const sourceKey = gitlabLfsKey(oid)
    const source = await env.LFS_SRC.get(sourceKey)
    if (!source) {
      return Response.json({ copied: false, reason: "lfs-miss", oid, sourceKey }, { status: 404 })
    }
    if (source.size !== undefined && Number(source.size) !== size) {
      return Response.json({ copied: false, reason: "source-size-mismatch", oid }, { status: 409 })
    }
    const stored = await env.SNAPSHOTS.put(key, source.body, {
      httpMetadata: { contentType: sourceArtifactDescriptor("idml").contentType },
      customMetadata: { sha256: oid, origin: "codex-gitlab-lfs-migration" },
    })
    if (stored.size !== size) {
      await env.SNAPSHOTS.delete(key)
      return Response.json({ copied: false, reason: "destination-size-mismatch" }, { status: 409 })
    }
    copied = true
  } else if (destination.size !== size || (!existing && destination.customMetadata?.sha256 !== oid)) {
    return Response.json({ error: "destination key contains unverified different bytes" }, { status: 409 })
  }

  const manifest = {
    version: 1,
    profileId: "builtin:idml-roundtrip",
    profileVersion: "2",
    deterministic: true,
    fidelity: "content-only",
    warningCounts: {},
  }
  const statements = buildSourceArtifactPersistenceStatements(env.AQUILLA_PG, {
    projectId,
    fileId,
    artifactId: ids.artifactId,
    bindingId: ids.bindingId,
    uploadedByUserId: String(file.created_by),
    artifactName: name || file.name,
    contentType: sourceArtifactDescriptor("idml").contentType,
    byteLength: size,
    sha256: oid,
    r2Key: key,
    format: "idml",
    bindingRole: "source",
    targetLang: "",
    memberPath: "",
    profileId: "builtin:idml-roundtrip",
    profileVersion: "2",
    fidelity: "content-only",
    manifest,
    recipe: null,
    origin: "codex-gitlab-lfs-migration",
    updateSourceSidecar: true,
    createdAt: Date.now(),
  })
  try {
    await env.AQUILLA_PG.batch(statements)
  } catch (error) {
    if (copied && !existing) await env.SNAPSHOTS.delete(key)
    return Response.json({ error: `source metadata write failed: ${String(error)}` }, { status: 500 })
  }

  return Response.json({
    ok: true,
    copied,
    artifactId: ids.artifactId,
    bindingId: ids.bindingId,
    key,
    sha256: oid,
  })
}
