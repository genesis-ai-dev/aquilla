import { syncWorkerHttpOrigin } from "./sync-worker-url"

export interface UploadSourceArgs {
  projectId: string
  fileId: string
  bytes: ArrayBuffer
  format: "docx" | "pptx"
  getToken: (fileId: string) => Promise<string | null>
  fetchFn?: typeof fetch
  /** Override the base URL (for tests). Defaults to syncWorkerHttpOrigin(). */
  baseUrl?: string
}

export async function uploadSourceOriginal(args: UploadSourceArgs): Promise<void> {
  const token = await args.getToken(args.fileId)
  if (!token) throw new Error("Couldn't get an upload token — sign in and try again.")
  const origin = args.baseUrl ?? syncWorkerHttpOrigin()
  const url = `${origin}/api/v1/projects/${encodeURIComponent(args.projectId)}/files/${encodeURIComponent(args.fileId)}/source`
  const fetchFn = args.fetchFn ?? fetch
  const res = await fetchFn(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "X-Source-Format": args.format },
    body: args.bytes,
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`Source upload failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`)
  }
}
