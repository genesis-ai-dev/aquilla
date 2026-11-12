// "Save audio for offline" (desktop): copy every R2-stored clip a project's
// cells point at into the on-device byte cache (src/lib/audio/bytes-cache.ts),
// the same cache useCellAudio reads before touching the network. The LiveStore
// offline copy holds cell text only, so without this a downloaded project's
// players showed nothing playable once the network went away.
//
// Pointers come from each file's audio-attachments read (takes, dubs, source
// clips, generated voice — every lane), found by scanning for
// `frontier-audio://` strings rather than knowing every shape, so a new slot
// is picked up without touching this file. Deleted takes are skipped. External http(s) media is skipped — we don't own it and can't cache
// it reliably. Like the Media-lens warmer it never evicts to make room.
import { fetchProjectFiles as fetchProjectFilesDefault } from "@/lib/sync/cells-read"
import { fetchFileAudioAttachments as fetchFileAudioAttachmentsDefault } from "@/lib/sync/cell-audio-read"
import { fetchSyncToken as fetchSyncTokenDefault } from "@/lib/sync/sync-token"
import { fetchCellAudio as fetchCellAudioDefault, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import {
  audioCacheAvailable,
  audioCacheBudget,
  audioCacheHas,
  audioCachePut,
  audioCacheUsage,
} from "@/lib/audio/bytes-cache"
import { OFFLINE_DOWNLOAD_TOKEN_FILE_ID } from "./download"
import type { FrontierSession } from "@/lib/frontier/types"

export interface MediaTarget {
  fileId: string
  audioId: string
  ext: string
}

/** Every distinct `frontier-audio://` pointer anywhere inside `value`. */
export function collectFrontierMedia(fileId: string, value: unknown, into = new Map<string, MediaTarget>()): Map<string, MediaTarget> {
  if (typeof value === "string") {
    const parsed = parseFrontierAudioUrl(value)
    if (parsed && !into.has(parsed.audioId)) into.set(parsed.audioId, { fileId, ...parsed })
  } else if (Array.isArray(value)) {
    for (const item of value) collectFrontierMedia(fileId, item, into)
  } else if (value && typeof value === "object") {
    if ((value as { isDeleted?: unknown }).isDeleted === true) return into
    for (const item of Object.values(value)) collectFrontierMedia(fileId, item, into)
  }
  return into
}

export interface CacheProjectMediaResult {
  total: number
  cached: number
  alreadyCached: number
  failed: number
  stopped: "done" | "budget" | "cache-unavailable" | "aborted"
}

export interface CacheProjectMediaDeps {
  fetchSyncToken: typeof fetchSyncTokenDefault
  fetchProjectFiles: typeof fetchProjectFilesDefault
  fetchFileAudioAttachments: typeof fetchFileAudioAttachmentsDefault
  fetchCellAudio: typeof fetchCellAudioDefault
  cache: {
    available: typeof audioCacheAvailable
    budget: typeof audioCacheBudget
    usage: typeof audioCacheUsage
    has: typeof audioCacheHas
    put: typeof audioCachePut
  }
}

const defaultDeps: CacheProjectMediaDeps = {
  fetchSyncToken: fetchSyncTokenDefault,
  fetchProjectFiles: fetchProjectFilesDefault,
  fetchFileAudioAttachments: fetchFileAudioAttachmentsDefault,
  fetchCellAudio: fetchCellAudioDefault,
  cache: {
    available: audioCacheAvailable,
    budget: audioCacheBudget,
    usage: audioCacheUsage,
    has: audioCacheHas,
    put: audioCachePut,
  },
}


export async function cacheProjectMediaOffline(
  projectId: string,
  session: FrontierSession,
  opts: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
  deps: CacheProjectMediaDeps = defaultDeps,
): Promise<CacheProjectMediaResult> {
  const result: CacheProjectMediaResult = { total: 0, cached: 0, alreadyCached: 0, failed: 0, stopped: "done" }
  if (!(await deps.cache.available())) return { ...result, stopped: "cache-unavailable" }

  const { token } = await deps.fetchSyncToken(session.jwt, projectId, OFFLINE_DOWNLOAD_TOKEN_FILE_ID)
  const targets = new Map<string, MediaTarget>()
  for (const file of await deps.fetchProjectFiles(projectId, token)) {
    collectFrontierMedia(file.fileId, await deps.fetchFileAudioAttachments(projectId, file.fileId, token), targets)
  }
  result.total = targets.size

  const budget = await deps.cache.budget()
  const getSyncToken = audioSyncTokenFetcherForSession(session)
  let done = 0
  for (const target of targets.values()) {
    if (opts.signal?.aborted) return { ...result, stopped: "aborted" }
    try {
      if (await deps.cache.has(target.audioId, target.ext)) {
        result.alreadyCached++
      } else {
        if ((await deps.cache.usage()) >= budget) return { ...result, stopped: "budget" }
        const bytes = await deps.fetchCellAudio({ projectId, ...target, getSyncToken })
        await deps.cache.put(target.audioId, target.ext, bytes)
        result.cached++
      }
    } catch {
      // A deleted clip (404) or a transient failure — count it, keep going.
      result.failed++
    }
    opts.onProgress?.(++done, result.total)
  }
  return result
}
