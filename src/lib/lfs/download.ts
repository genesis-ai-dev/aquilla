// src/lib/lfs/download.ts
// Two-call LFS download flow, routed through the existing GIT_CORS_PROXY.
// Ported from frontier-authentication/src/git/GitService.ts:648-728.

import { GIT_CORS_PROXY } from "@/lib/git/clone"

export interface DownloadArgs {
  cloneUrl: string
  gitlabToken: string
  oid: string
  size: number
  signal?: AbortSignal
}

export type LfsDownloadError =
  | { kind: "batch-failed"; message: string }
  | { kind: "download-failed"; message: string }

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("")
}

function proxied(url: string): string {
  // codex-git-proxy forwards {proxy}/<hostnameAndPath> to the real URL and
  // adds permissive CORS. Strip the scheme since the worker expects the
  // hostname-first form.
  const stripped = url.replace(/^https?:\/\//, "")
  return `${GIT_CORS_PROXY}/${stripped}`
}

export async function downloadLfsBlob({
  cloneUrl, gitlabToken, oid, size, signal,
}: DownloadArgs): Promise<Uint8Array> {
  const authHeader = `Basic ${btoa(`oauth2:${gitlabToken}`)}`
  const batchUrl = `${cloneUrl}/info/lfs/objects/batch`

  let batchResp: Response
  try {
    batchResp = await fetch(proxied(batchUrl), {
      method: "POST",
      signal,
      headers: {
        Authorization: authHeader,
        Accept: "application/vnd.git-lfs+json",
        "Content-Type": "application/vnd.git-lfs+json",
      },
      body: JSON.stringify({
        operation: "download",
        transfers: ["basic"],
        objects: [{ oid, size }],
      }),
    })
  } catch (e) {
    const err: LfsDownloadError = {
      kind: "batch-failed",
      message: e instanceof Error ? e.message : String(e),
    }
    throw err
  }

  if (!batchResp.ok) {
    const err: LfsDownloadError = {
      kind: "batch-failed",
      message: `LFS batch HTTP ${batchResp.status}`,
    }
    throw err
  }

  let batchJson: { objects?: Array<{
    actions?: { download?: { href: string; header?: Record<string, string> } }
    error?: { code: number; message: string }
  }> }
  try {
    batchJson = await batchResp.json()
  } catch (e) {
    const err: LfsDownloadError = {
      kind: "batch-failed",
      message: `LFS batch returned non-JSON: ${e instanceof Error ? e.message : String(e)}`,
    }
    throw err
  }

  const obj = batchJson.objects?.[0]
  if (!obj) {
    const err: LfsDownloadError = { kind: "batch-failed", message: "LFS batch returned no objects" }
    throw err
  }
  if (obj.error) {
    const err: LfsDownloadError = {
      kind: "batch-failed",
      message: `LFS server: ${obj.error.code} ${obj.error.message}`,
    }
    throw err
  }
  if (!obj.actions?.download?.href) {
    const err: LfsDownloadError = { kind: "batch-failed", message: "LFS batch missing download action" }
    throw err
  }

  const { href, header = {} } = obj.actions.download
  let blobResp: Response
  try {
    blobResp = await fetch(proxied(href), {
      method: "GET",
      signal,
      headers: header,
    })
  } catch (e) {
    const err: LfsDownloadError = {
      kind: "download-failed",
      message: e instanceof Error ? e.message : String(e),
    }
    throw err
  }
  if (!blobResp.ok) {
    const err: LfsDownloadError = {
      kind: "download-failed",
      message: `LFS blob HTTP ${blobResp.status}`,
    }
    throw err
  }

  const bytes = new Uint8Array(await blobResp.arrayBuffer())

  const actualOid = await sha256Hex(bytes)
  if (actualOid !== oid.toLowerCase()) {
    const err: LfsDownloadError = {
      kind: "download-failed",
      message: `sha256 mismatch: expected ${oid.slice(0, 12)}..., got ${actualOid.slice(0, 12)}...`,
    }
    throw err
  }

  return bytes
}
