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

function key(projectId: string, fileId: string): string {
  return `${projectId}:${fileId}`
}

function resourceFor(projectId: string, fileId: string): ResourceRecord {
  const cacheKey = key(projectId, fileId)
  let record = resources.get(cacheKey)
  if (!record) {
    record = {
      ...EMPTY_STATE,
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

async function readCache(projectId: string, fileId: string): Promise<ProgressCacheEntry | null> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key(projectId, fileId))
      request.onsuccess = () => resolve((request.result as ProgressCacheEntry | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('IDB read failed'))
    })
  } catch {
    return null
  }
}

async function writeCache(projectId: string, fileId: string, record: ResourceRecord): Promise<void> {
  if (!record.server || !record.progress) return
  try {
    const db = await openDb()
    const entry: ProgressCacheEntry = {
      key: key(projectId, fileId),
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

async function reconcilePendingOverlay(
  projectId: string,
  fileId: string,
  record: ResourceRecord,
): Promise<void> {
  if (record.pendingEventIds.length === 0) return
  const pendingEventIds = await livePendingEventIds(record.pendingEventIds)
  if (
    pendingEventIds.length === record.pendingEventIds.length
    && pendingEventIds.every((id, index) => id === record.pendingEventIds[index])
  ) return

  record.pendingEventIds = pendingEventIds
  // Persist the shrunken id set too. Otherwise a restart would revive events
  // already accepted while another local event is still pending for this file.
  void writeCache(projectId, fileId, record)
  if (pendingEventIds.length === 0) {
    // The accepted record is gone from the durable outbox. Never let a
    // persisted optimistic display keep masking the authoritative snapshot.
    record.local = null
    record.progress = record.server
    if (record.getToken) void loadResource(projectId, fileId, record.getToken, true)
  }
  emit(record)
}

async function fetchProgress(
  projectId: string,
  fileId: string,
  token: string,
  etag: string | null,
): Promise<{ kind: 'not-modified' } | { kind: 'progress'; progress: FileProgressResponse; etag: string | null }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (etag) headers['If-None-Match'] = etag
  const response = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/progress`,
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
): Promise<void> {
  const record = resourceFor(projectId, fileId)
  record.getToken = getToken
  if (record.inFlight) {
    if (force) record.refreshAfterFlight = true
    return record.inFlight
  }
  record.inFlight = (async () => {
    if (!record.hydrated) {
      record.hydrated = true
      const cached = await readCache(projectId, fileId)
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
      const result = await fetchProgress(projectId, fileId, token, force ? null : record.etag)
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
      void writeCache(projectId, fileId, record)
    } catch {
      record.error = true
    } finally {
      record.loading = false
      record.inFlight = null
      emit(record)
      const refreshAfterFlight = record.refreshAfterFlight
      record.refreshAfterFlight = false
      if (refreshAfterFlight && record.getToken) {
        void loadResource(projectId, fileId, record.getToken, true)
      }
    }
  })()
  return record.inFlight
}

export function useFileProgressResource(
  projectId: string | null,
  fileId: string | null,
  getTokenForFile: ((fileId: string) => Promise<string | null>) | undefined,
): FileProgressResourceState & { retry: () => void } {
  const record = projectId && fileId ? resourceFor(projectId, fileId) : null
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
    void loadResource(projectId, fileId, () => getTokenForFile(fileId))
  }, [fileId, getTokenForFile, projectId])
  useEffect(() => {
    if (!projectId || !fileId) return
    const record = resourceFor(projectId, fileId)
    return subscribeToOutbox(() => {
      void reconcilePendingOverlay(projectId, fileId, record)
    })
  }, [fileId, projectId])
  return {
    ...state,
    retry: () => {
      if (projectId && fileId && getTokenForFile) {
        void loadResource(projectId, fileId, () => getTokenForFile(fileId), true)
      }
    },
  }
}

export function setLocalFileProgress(
  projectId: string,
  fileId: string,
  progress: FileProgressResponse,
  pendingEventIds: readonly string[],
): void {
  const record = resourceFor(projectId, fileId)
  const hadPendingEvents = record.pendingEventIds.length > 0
  record.local = progress
  record.pendingEventIds = [...new Set(pendingEventIds)]
  record.progress = record.pendingEventIds.length > 0
    || hadPendingEvents
    || record.server?.source === 'file-counter-fallback'
    ? progress
    : (record.server ?? progress)
  emit(record)
  void writeCache(projectId, fileId, record)
  if (hadPendingEvents && record.pendingEventIds.length === 0 && record.getToken) {
    void loadResource(projectId, fileId, record.getToken, true)
  }
}

export function invalidateFileProgress(projectId: string, fileId: string): void {
  const record = resourceFor(projectId, fileId)
  if (record.getToken) void loadResource(projectId, fileId, record.getToken, true)
}

/** Revalidate every mounted/prefetched file resource in a project. */
export function invalidateProjectFileProgress(projectId: string): void {
  const prefix = `${projectId}:`
  for (const [cacheKey, record] of resources) {
    if (!cacheKey.startsWith(prefix) || !record.getToken) continue
    void loadResource(projectId, cacheKey.slice(prefix.length), record.getToken, true)
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
): void {
  const record = resourceFor(projectId, fileId)
  const cacheKey = key(projectId, fileId)
  if (
    record.inFlight ||
    queuedOrActivePrefetches.has(cacheKey) ||
    (record.progress != null && Date.now() - record.fetchedAt < PREFETCH_FRESH_MS)
  ) return
  queuedOrActivePrefetches.add(cacheKey)
  prefetchQueue.push({
    key: cacheKey,
    run: () => loadResource(projectId, fileId, () => getTokenForFile(fileId)),
  })
  drainPrefetchQueue()
}

export async function getFileProgress(
  projectId: string,
  fileId: string,
  getTokenForFile: (fileId: string) => Promise<string | null>,
): Promise<FileProgressResponse> {
  await loadResource(projectId, fileId, () => getTokenForFile(fileId))
  const progress = resourceFor(projectId, fileId).progress
  if (!progress) throw new Error('progress unavailable')
  return progress
}

export async function getFileSectionProgress(
  projectId: string,
  fileId: string,
  sectionKey: string,
  getTokenForFile: (fileId: string) => Promise<string | null>,
): Promise<SectionProgressDetailResponse> {
  const token = await getTokenForFile(fileId)
  if (!token) throw new Error('progress token unavailable')
  const response = await fetch(
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/progress/sections/${encodeURIComponent(sectionKey)}`,
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
