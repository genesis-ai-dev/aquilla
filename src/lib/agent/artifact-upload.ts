/**
 * artifact-upload.ts — SPA client for the composer attach-file affordance
 * (AQU-AGENT Wave-2). Uploads a chosen file as a project artifact via the
 * session-JWT route POST /api/v2/projects/:projectId/agent-artifacts
 * (auth-worker/src/routes/agent-artifacts.ts), returning the artifactId the
 * agent run request then carries so the harness can `load_artifact` it.
 *
 * Bytes go up raw (not multipart) with the file name in `x-artifact-name` and
 * the browser's detected MIME in `content-type` — mirroring the sync-worker
 * external artifacts route so the stored row is byte-identical in shape.
 */

import { AUTH_BASE } from "@/lib/frontier/auth"
import { fetchWithTimeout } from "@/lib/frontier/orgs"
import type { UploadedArtifact } from "./protocol"

/** Client-side ceiling mirroring the server's MAX_AGENT_ARTIFACT_BYTES (25MB),
 *  so an oversize file is rejected before the upload round-trip. */
export const MAX_AGENT_ARTIFACT_BYTES = 25 * 1024 * 1024

/** Upload times can dwarf the 15s API default for a large file; give it room. */
const UPLOAD_TIMEOUT_MS = 60_000

export class ArtifactUploadError extends Error {
  public status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = "ArtifactUploadError"
  }
}

/**
 * Upload a File to the project's agent-artifacts endpoint. Throws
 * ArtifactUploadError on an oversize file (client-side) or a non-OK response.
 */
export async function uploadAgentArtifact(
  jwt: string,
  projectId: string,
  file: File,
): Promise<UploadedArtifact> {
  if (file.size === 0) {
    throw new ArtifactUploadError("The selected file is empty.", 400)
  }
  if (file.size > MAX_AGENT_ARTIFACT_BYTES) {
    throw new ArtifactUploadError(
      `That file is ${(file.size / (1024 * 1024)).toFixed(1)}MB — the limit is 25MB.`,
      413,
    )
  }

  const res = await fetchWithTimeout(
    `${AUTH_BASE}/api/v2/projects/${encodeURIComponent(projectId)}/agent-artifacts`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "x-artifact-name": encodeURIComponent(file.name),
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    },
    UPLOAD_TIMEOUT_MS,
  )

  if (!res.ok) {
    let message = `Upload failed (HTTP ${res.status}).`
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ArtifactUploadError(message, res.status)
  }

  const out = (await res.json()) as UploadedArtifact
  // We percent-encoded the name in the header; use the File's own name for
  // display + the run request rather than round-tripping the server echo.
  return { ...out, fileName: file.name }
}
