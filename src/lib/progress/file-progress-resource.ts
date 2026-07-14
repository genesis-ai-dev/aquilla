import { useEffect, useSyncExternalStore } from 'react'
import { syncWorkerHttpOrigin } from '@/lib/sync/sync-worker-url'
import { timeoutSignal } from '@/lib/sync/fetch-timeout'
import { getOutboxRecords, subscribeToOutbox } from '@/lib/sync/outbox'

export interface ProgressCounts {
  totalCount: number
  filledCount: number
  validatedCount: number
  /** Counts (not percentages) meeting >=1, >=2, ... validator levels. */
  validationLevels: number[]
}

export interface FileProgressResponse {
  fileId: string
  revision: number
  validationCount: number
  file: ProgressCounts
  sections: Array<{ key: string } & ProgressCounts>
  source?: 'projection' | 'file-counter-fallback'
}

export interface SectionProgressDetailResponse {
  fileId: string
  sectionKey: string
  revision: number
  validationCount: number
  verses: Array<{ ref: string; filled: boolean; validated: boolean }>
}

interface ProgressCacheEntry {
  key: string
  server: FileProgressResponse
  display: FileProgressResponse
  etag: string | null
  pendingEventIds: string[]
  cachedAt: number
}

export interface FileProgressResourceState {
  progress: FileProgressResponse | null
  loading: boolean
  error: boolean
  fromCache: boolean
}

const DB_NAME = 'aquilla-file-progress'
const DB_VERSION = 1
const STORE = 'progress'
const REQUEST_TIMEOUT_MS = 15_000
const PREFETCH_FRESH_MS = 30_000
const EMPTY_STATE: FileProgressResourceState = { progress: null, loading: false, error: false, fromCache: false }

interface ResourceRecord extends FileProgressResourceState {
  projectId: string
  fileId: string
  /** AQU-538 target-language lane; '' = default lane (byte-identical to pre-lane behavior). */
  lane: string
  view: FileProgressResourceState
  server: FileProgressResponse | null
  local: FileProgressResponse | null
  etag: string | null
  pendingEventIds: string[]
  fetchedAt: number
  hydrated: boolean
  inFlight: Promise<void> | null
  refreshAfterFlight: boolean
  getToken: (() => Promise<string | null>) | null
  listeners: Set<() => void>
}

let dbPromise: Promise<IDBDatabase> | null = null
const resources = new Map<string, ResourceRecord>()

// AQU-538: the default lane ('') keeps the legacy key byte-for-byte so existing
// IDB cache entries and in-memory resources are untouched; a non-default lane
// appends a NUL-delimited segment (NUL never appears in project/file ids or
// lane tags) so caches, ETags, and pending overlays never cross lanes.
const LANE_KEY_SEP = '\u0000'
function key(projectId: string, fileId: string, lane = ''): string {
  return lane ? `${projectId}:${fileId}${LANE_KEY_SEP}lane${LANE_KEY_SEP}${lane}` : `${projectId}:${fileId}`
}

function resourceFor(projectId: string, fileId: string, lane = ''): ResourceRecord {
  const cacheKey = key(projectId, fileId, lane)
  let record = resources.get(cacheKey)
  if (!record) {
    record = {
      ...EMPTY_STATE,
      projectId,
      fileId,
      lane,
      view: EMPTY_STATE,
      server: null,
      local: null,
      etag: null,
      pendingEventIds: [],
      fetchedAt: 0,
      hydrated: false,
      inFlight: null,
      refreshAfterFlight: false,
      getToken: null,
      listeners: new Set(),
    }
    resources.set(cacheKey, record)
  }
  return record
}

function emit(record: ResourceRecord): void {
  record.view = {
    progress: record.progress,
    loading: record.loading,
    error: record.error,
    fromCache: record.fromCache,
  }
  for (const listener of record.listeners) listener()
}

function snapshot(record: ResourceRecord): FileProgressResourceState {
  return record.view
}

async function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('indexedDB unavailable')
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => reject(request.error ?? new Error('IDB open failed'))
      request.onsuccess = () => resolve(request.result)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE, { keyPath: 'key' })
        }
      }
    })
  }
  return dbPromise
}

async function readCache(projectId: string, fileId: string, lane = ''): Promise<ProgressCacheEntry | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key(projectId, fileId, lane))
      request.onsuccess = () => resolve((request.result as ProgressCacheEntry | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('IDB read failed'))
    })
  } catch {
    return null
  }
}

async function writeCache(record: ResourceRecord): Promise<void> {
  if (!record.server || !record.progress) return
  try {
    const db = await openDb()
    const entry: ProgressCacheEntry = {
      key: key(record.projectId, record.fileId, record.lane),
      server: record.server,
      display: record.progress,
      etag: record.etag,
      pendingEventIds: record.pendingEventIds,
      cachedAt: Date.now(),
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IDB write failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IDB write aborted'))
    })
  } catch {
    // Private browsing and quota failures must not block editor navigation.
  }
}

async function livePendingEventIds(ids: readonly string[]): Promise<string[]> {
  const records = await getOutboxRecords(ids)
  return records
    .filter((record) => (record.status ?? 'pending') === 'pending')
    .map((record) => record.id)
}

async function reconcilePendingOverlay(record: ResourceRecord): Promise<void> {
  if (record.pendingEventIds.length === 0) return
  const pendingEventIds = await livePendingEventIds(record.pendingEventIds)
  if (
    pendingEventIds.length === record.pendingEventIds.length
    && pendingEventIds.every((id, index) => id === record.pendingEventIds[index])
  ) return

  record.pendingEventIds = pendingEventIds
  // Persist the shrunken id set too. Otherwise a restart would revive events
  // already accepted while another local event is still pending for this file.
  void writeCache(record)
  if (pendingEventIds.length === 0) {
    // The accepted record is gone from the durable outbox. Never let a
    // persisted optimistic display keep masking the authoritative snapshot.
    record.local = null
    record.progress = record.server
    if (record.getToken) void loadResource(record.projectId, record.fileId, record.getToken, true, record.lane)
  }
  emit(record)
}

async function fetchProgress(
  projectId: string,
  fileId: string,
  lane: string,
  token: string,
  etag: string | null,
): Promise<{ kind: 'not-modified' } | { kind: 'progress'; progress: FileProgressResponse; etag: string | null }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (etag) headers['If-None-Match'] = etag
  // AQU-538: only append ?lane= for a non-default lane, so the default request
  // URL (and thus the server ETag) stays byte-identical to pre-lane behavior.
  const laneQuery = lane ? `?lane=${encodeURIComponent(lane)}` : ''
  const response = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/progress${laneQuery}`,
    { headers, signal: timeoutSignal(REQUEST_TIMEOUT_MS) },
  )
  if (response.status === 304) return { kind: 'not-modified' }
  if (!response.ok) throw new Error(`progress read failed: HTTP ${response.status}`)
  return {
    kind: 'progress',
    progress: await response.json() as FileProgressResponse,
    etag: response.headers.get('ETag'),
  }
}

async function loadResource(
  projectId: string,
  fileId: string,
  getToken: () => Promise<string | null>,
  force = false,
  lane = '',
): Promise<void> {
  const record = resourceFor(projectId, fileId, lane)
  record.getToken = getToken
  if (record.inFlight) {
    if (force) record.refreshAfterFlight = true
    return record.inFlight
  }
  record.inFlight = (async () => {
    if (!record.hydrated) {
      record.hydrated = true
      const cached = await readCache(projectId, fileId, lane)
      if (cached) {
        const pendingEventIds = await livePendingEventIds(cached.pendingEventIds)
        record.server = cached.server
        record.local = pendingEventIds.length > 0 ? cached.display : null
        record.progress = pendingEventIds.length > 0 ? cached.display : cached.server
        record.etag = cached.etag
        record.pendingEventIds = pendingEventIds
        record.fetchedAt = cached.cachedAt
        record.fromCache = true
        emit(record)
      }
    }
    record.loading = record.progress == null
    record.error = false
    emit(record)
    try {
      const token = await getToken()
      if (!token) throw new Error('progress token unavailable')
      const result = await fetchProgress(projectId, fileId, lane, token, force ? null : record.etag)
      if (result.kind === 'progress') {
        record.server = result.progress
        record.etag = result.etag
        // An accepted local event can leave the outbox before the server read
        // catches up. Keep the local overlay until CellStore reports no pending
        // ids; then the next refresh replaces it with authoritative progress.
        if (record.pendingEventIds.length === 0) {
          record.progress = result.progress.source === 'file-counter-fallback' && record.local
            ? record.local
            : result.progress
        }
      }
      record.fetchedAt = Date.now()
      record.error = false
      record.fromCache = false
      void writeCache(record)
    } catch {
      record.error = true
    } finally {
      record.loading = false
      record.inFlight = null
      emit(record)
      const refreshAfterFlight = record.refreshAfterFlight
      record.refreshAfterFlight = false
      if (refreshAfterFlight && record.getToken) {
        void loadResource(projectId, fileId, record.getToken, true, lane)
      }
    }
  })()
  return record.inFlight
}

export function useFileProgressResource(
  projectId: string | null,
  fileId: string | null,
  getTokenForFile: ((fileId: string) => Promise<string | null>) | undefined,
  lane = '',
): FileProgressResourceState & { retry: () => void } {
  const record = projectId && fileId ? resourceFor(projectId, fileId, lane) : null
  const state = useSyncExternalStore(
    (listener) => {
      if (!record) return () => undefined
      record.listeners.add(listener)
      return () => record.listeners.delete(listener)
    },
    () => record ? snapshot(record) : EMPTY_STATE,
    () => EMPTY_STATE,
  )
  useEffect(() => {
    if (!projectId || !fileId || !getTokenForFile) return
    void loadResource(projectId, fileId, () => getTokenForFile(fileId), false, lane)
  }, [fileId, getTokenForFile, projectId, lane])
  useEffect(() => {
    if (!projectId || !fileId) return
    const record = resourceFor(projectId, fileId, lane)
    return subscribeToOutbox(() => {
      void reconcilePendingOverlay(record)
    })
  }, [fileId, projectId, lane])
  return {
    ...state,
    retry: () => {
      if (projectId && fileId && getTokenForFile) {
        void loadResource(projectId, fileId, () => getTokenForFile(fileId), true, lane)
      }
    },
  }
}

export function setLocalFileProgress(
  projectId: string,
  fileId: string,
  progress: FileProgressResponse,
  pendingEventIds: readonly string[],
  lane = '',
): void {
  const record = resourceFor(projectId, fileId, lane)
  const hadPendingEvents = record.pendingEventIds.length > 0
  record.local = progress
  record.pendingEventIds = [...new Set(pendingEventIds)]
  record.progress = record.pendingEventIds.length > 0
    || hadPendingEvents
    || record.server?.source === 'file-counter-fallback'
    ? progress
    : (record.server ?? progress)
  emit(record)
  void writeCache(record)
  if (hadPendingEvents && record.pendingEventIds.length === 0 && record.getToken) {
    void loadResource(projectId, fileId, record.getToken, true, lane)
  }
}

export function invalidateFileProgress(projectId: string, fileId: string, lane = ''): void {
  const record = resourceFor(projectId, fileId, lane)
  if (record.getToken) void loadResource(projectId, fileId, record.getToken, true, lane)
}

/** Revalidate every mounted/prefetched file resource in a project (all lanes). */
export function invalidateProjectFileProgress(projectId: string): void {
  for (const record of resources.values()) {
    if (record.projectId !== projectId || !record.getToken) continue
    void loadResource(record.projectId, record.fileId, record.getToken, true, record.lane)
  }
}

let activePrefetches = 0
const queuedOrActivePrefetches = new Set<string>()
const prefetchQueue: Array<{ key: string; run: () => Promise<void> }> = []

function drainPrefetchQueue(): void {
  while (activePrefetches < 2 && prefetchQueue.length > 0) {
    const job = prefetchQueue.shift()!
    activePrefetches++
    void job.run().finally(() => {
      activePrefetches--
      queuedOrActivePrefetches.delete(job.key)
      drainPrefetchQueue()
    })
  }
}

export function prefetchFileProgress(
  projectId: string,
  fileId: string,
  getTokenForFile: (fileId: string) => Promise<string | null>,
  lane = '',
): void {
  const record = resourceFor(projectId, fileId, lane)
  const cacheKey = key(projectId, fileId, lane)
  if (
    record.inFlight ||
    queuedOrActivePrefetches.has(cacheKey) ||
    (record.progress != null && Date.now() - record.fetchedAt < PREFETCH_FRESH_MS)
  ) return
  queuedOrActivePrefetches.add(cacheKey)
  prefetchQueue.push({
    key: cacheKey,
    run: () => loadResource(projectId, fileId, () => getTokenForFile(fileId), false, lane),
  })
  drainPrefetchQueue()
}

export async function getFileProgress(
  projectId: string,
  fileId: string,
  getTokenForFile: (fileId: string) => Promise<string | null>,
  lane = '',
): Promise<FileProgressResponse> {
  await loadResource(projectId, fileId, () => getTokenForFile(fileId), false, lane)
  const progress = resourceFor(projectId, fileId, lane).progress
  if (!progress) throw new Error('progress unavailable')
  return progress
}

export async function getFileSectionProgress(
  projectId: string,
  fileId: string,
  sectionKey: string,
  getTokenForFile: (fileId: string) => Promise<string | null>,
  lane = '',
): Promise<SectionProgressDetailResponse> {
  const token = await getTokenForFile(fileId)
  if (!token) throw new Error('progress token unavailable')
  // AQU-538: only append ?lane= for a non-default lane so the default URL/ETag
  // stays byte-identical.
  const laneQuery = lane ? `?lane=${encodeURIComponent(lane)}` : ''
  const response = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/progress/sections/${encodeURIComponent(sectionKey)}${laneQuery}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: timeoutSignal(REQUEST_TIMEOUT_MS) },
  )
  if (!response.ok) throw new Error(`section progress read failed: HTTP ${response.status}`)
  return await response.json() as SectionProgressDetailResponse
}

export async function resetFileProgressResourceForTests(): Promise<void> {
  resources.clear()
  prefetchQueue.length = 0
  queuedOrActivePrefetches.clear()
  activePrefetches = 0
  if (dbPromise) {
    try { (await dbPromise).close() } catch { /* ignore */ }
  }
  dbPromise = null
}
