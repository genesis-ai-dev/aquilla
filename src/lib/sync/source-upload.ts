import { syncWorkerHttpOrigin } from "./sync-worker-url"

export interface UploadSourceArgs {
  projectId: string
  fileId: string
  /** Client-minted id makes retries converge on one immutable artifact row. */
  artifactId: string
  bytes: ArrayBuffer
  /** Stable import format label persisted beside the immutable original. */
  format: string
  getToken: (fileId: string) => Promise<string | null>
  fetchFn?: typeof fetch
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

function isRetryableImportStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export async function uploadSourceOriginal(args: UploadSourceArgs): Promise<UploadSourceResult> {
  let token = await args.getToken(args.fileId)
  if (!token) throw new Error("Couldn't get an upload token — sign in and try again.")
  const origin = args.baseUrl ?? syncWorkerHttpOrigin()
  const url = `${origin}/api/v1/projects/${encodeURIComponent(args.projectId)}/files/${encodeURIComponent(args.fileId)}/source`
  const fetchFn = args.fetchFn ?? fetch
  const delays = args.retryDelaysMs ?? IMPORT_RETRY_DELAYS_MS

  let lastError: Error | null = null
  for (let attempt = 0; attempt < IMPORT_ATTEMPTS; attempt++) {
    let res: Response | null = null
    try {
      res = await fetchFn(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Source-Format": args.format,
          "X-Artifact-Id": args.artifactId,
        },
        body: args.bytes,
      })
    } catch (err) {
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
      await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]))
    }
  }

  throw lastError ?? new Error("Source upload failed")
}
