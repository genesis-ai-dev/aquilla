import { syncWorkerHttpOrigin } from "./sync-worker-url"
import {
  MAX_SOURCE_ARTIFACT_BYTES,
  type SourceArtifactFormat,
} from "../../../shared/import-contract"

export interface UploadSourceArgs {
  projectId: string
  fileId: string
  /** Client-minted id makes retries converge on one immutable artifact row. */
  artifactId: string
  bytes: ArrayBuffer
  /** Stable import format label persisted beside the immutable original. */
  format: SourceArtifactFormat
  artifactName?: string
  bindingRole?: "source" | "target" | "support"
  targetLang?: string
  memberPath?: string
  profileId?: string
  profileVersion?: string
  fidelity?: "native" | "verified-recipe" | "content-only" | "preserved-only"
  /** Support/package artifacts must not replace the file's native export sidecar. */
  updateSourceSidecar?: boolean
  getToken: (fileId: string) => Promise<string | null>
  fetchFn?: typeof fetch
  /** Cancels both the active PUT and any pending retry backoff. */
  signal?: AbortSignal
  /** Override the base URL (for tests). Defaults to syncWorkerHttpOrigin(). */
  baseUrl?: string
  /** Retry backoff between attempts, in ms (test override). Defaults to the
   *  same schedule bulk-import uses for chunk uploads. */
  retryDelaysMs?: readonly number[]
}

export interface UploadSourceResult {
  artifactId: string
  key: string
  sha256: string
}

// Same attempts/backoff as the bulk-import chunk uploads: a transient network
// blip or 5xx on the R2 PUT shouldn't abort a whole import mid-way.
const IMPORT_ATTEMPTS = 3
const IMPORT_RETRY_DELAYS_MS = [200, 800] as const

export function assertSourceUploadByteLength(byteLength: number): void {
  if (byteLength === 0) throw new Error("Source upload failed: the original file is empty.")
  if (byteLength > MAX_SOURCE_ARTIFACT_BYTES) {
    const maxMb = MAX_SOURCE_ARTIFACT_BYTES / 1024 / 1024
    throw new Error(`Source upload failed: the original file exceeds the ${maxMb} MB limit.`)
  }
}

export function assertSourceUploadSize(bytes: ArrayBuffer): void {
  assertSourceUploadByteLength(bytes.byteLength)
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
}

function isRetryableImportStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function throwIfSourceUploadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Import cancelled")
}

async function waitForSourceRetry(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfSourceUploadAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new Error("Import cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export async function uploadSourceOriginal(args: UploadSourceArgs): Promise<UploadSourceResult> {
  throwIfSourceUploadAborted(args.signal)
  assertSourceUploadSize(args.bytes)
  // Supplying the checksum lets the worker stream the request directly into
  // R2 while R2 verifies integrity. It also avoids hashing/buffering a 95 MB
  // Paratext package inside the worker isolate.
  const sha256 = await sha256Hex(args.bytes)
  let token = await args.getToken(args.fileId)
  if (!token) throw new Error("Couldn't get an upload token — sign in and try again.")
  const origin = args.baseUrl ?? syncWorkerHttpOrigin()
  const url = `${origin}/api/v1/projects/${encodeURIComponent(args.projectId)}/files/${encodeURIComponent(args.fileId)}/source`
  const fetchFn = args.fetchFn ?? fetch
  const delays = args.retryDelaysMs ?? IMPORT_RETRY_DELAYS_MS

  let lastError: Error | null = null
  for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt++) {
    throwIfSourceUploadAborted(args.signal)
    let res: Response | null = null
    try {
      res = await fetchFn(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Source-Format": args.format,
          "X-Source-Size": String(args.bytes.byteLength),
          "X-Source-Sha256": sha256,
          "X-Artifact-Id": args.artifactId,
          ...(args.artifactName ? { "X-Artifact-Name": encodeURIComponent(args.artifactName) } : {}),
          ...(args.bindingRole ? { "X-Artifact-Binding-Role": args.bindingRole } : {}),
          ...(args.targetLang ? { "X-Artifact-Target-Lang": encodeURIComponent(args.targetLang) } : {}),
          ...(args.memberPath ? { "X-Artifact-Member-Path": encodeURIComponent(args.memberPath) } : {}),
          ...(args.profileId ? { "X-Artifact-Profile-Id": args.profileId } : {}),
          ...(args.profileVersion ? { "X-Artifact-Profile-Version": args.profileVersion } : {}),
          ...(args.fidelity ? { "X-Artifact-Fidelity": args.fidelity } : {}),
          ...(args.updateSourceSidecar !== undefined
            ? { "X-Update-Source-Sidecar": String(args.updateSourceSidecar) }
            : {}),
        },
        body: args.bytes,
        signal: args.signal,
      })
    } catch (err) {
      throwIfSourceUploadAborted(args.signal)
      lastError = new Error(`Source upload failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (res) {
      if (res.ok) return await res.json() as UploadSourceResult
      const detail = await res.text().catch(() => "")
      lastError = new Error(`Source upload failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`)

      // A long import can outlive its original file token — refresh once and
      // retry the same idempotent PUT before treating 401 as fatal.
      if (res.status === 401 && attempt < IMPORT_ATTEMPTS - 1) {
        const refreshed = await args.getToken(args.fileId)
        if (refreshed) {
          token = refreshed
          continue
        }
      }
      if (!isRetryableImportStatus(res.status)) throw lastError
    }

    if (attempt < IMPORT_ATTEMPTS - 1) {
      await waitForSourceRetry(delays[attempt], args.signal)
    }
  }

  throw lastError ?? new Error("Source upload failed")
}

export interface BindSourceArtifactArgs {
  projectId: string
  fileId: string
  artifactId: string
  memberPath?: string
  profileId: string
  profileVersion: string
  fidelity: "native" | "verified-recipe" | "content-only" | "preserved-only"
  bindingRole?: "support" | "target"
  targetLang?: string
  getToken: (fileId: string) => Promise<string | null>
  fetchFn?: typeof fetch
  baseUrl?: string
  /** Cancels both the active binding request and any pending retry backoff. */
  signal?: AbortSignal
  /** Test override; production uses the standard import retry schedule. */
  retryDelaysMs?: readonly number[]
}

/** Bind an already-uploaded package artifact to another file without
 * re-uploading its bytes. Used by Paratext, where one ZIP owns many books. */
export async function bindSourceArtifact(args: BindSourceArtifactArgs): Promise<void> {
  throwIfSourceUploadAborted(args.signal)
  let token = await args.getToken(args.fileId)
  if (!token) throw new Error("Couldn't get an upload token — sign in and try again.")
  const origin = args.baseUrl ?? syncWorkerHttpOrigin()
  const url = `${origin}/api/v1/projects/${encodeURIComponent(args.projectId)}/files/${encodeURIComponent(args.fileId)}/source-bindings`
  const fetchFn = args.fetchFn ?? fetch
  const delays = args.retryDelaysMs ?? IMPORT_RETRY_DELAYS_MS
  const body = JSON.stringify({
    artifactId: args.artifactId,
    bindingRole: args.bindingRole ?? "support",
    ...(args.targetLang ? { targetLang: args.targetLang } : {}),
    memberPath: args.memberPath ?? "",
    profileId: args.profileId,
    profileVersion: args.profileVersion,
    fidelity: args.fidelity,
  })

  let lastError: Error | null = null
  for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt++) {
    throwIfSourceUploadAborted(args.signal)
    let response: Response | null = null
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
        signal: args.signal,
      })
    } catch (error) {
      throwIfSourceUploadAborted(args.signal)
      lastError = new Error(`Artifact binding failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (response) {
      if (response.ok) return
      const detail = await response.text().catch(() => "")
      lastError = new Error(`Artifact binding failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`)
      if (response.status === 401 && attempt < IMPORT_ATTEMPTS - 1) {
        const refreshed = await args.getToken(args.fileId)
        if (refreshed) {
          token = refreshed
          continue
        }
      }
      if (!isRetryableImportStatus(response.status)) throw lastError
    }

    if (attempt < IMPORT_ATTEMPTS - 1) {
      await waitForSourceRetry(delays[attempt], args.signal)
    }
  }
  throw lastError ?? new Error("Artifact binding failed")
}
