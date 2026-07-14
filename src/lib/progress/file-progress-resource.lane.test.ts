import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// AQU-538: lane threading — the default lane ('') stays byte-identical (no
// ?lane= query, legacy cache key) while a non-default lane gets its own query
// param, ETag, and IDB cache key so caches never cross lanes.

vi.mock('@/lib/sync/sync-worker-url', () => ({ syncWorkerHttpOrigin: () => 'https://sync.test' }))
vi.mock('@/lib/sync/fetch-timeout', () => ({ timeoutSignal: () => undefined }))
vi.mock('@/lib/sync/outbox', () => ({
  getOutboxRecords: async () => [],
  subscribeToOutbox: () => () => undefined,
}))

import {
  getFileProgress,
  resetFileProgressResourceForTests,
  type FileProgressResponse,
} from './file-progress-resource'

function progressFor(fileId: string, revision: number): FileProgressResponse {
  return {
    fileId,
    revision,
    validationCount: 1,
    file: { totalCount: 100, filledCount: revision * 10, validatedCount: 0, validationLevels: [0] },
    sections: [],
    source: 'projection',
  }
}

const calledUrls: string[] = []

beforeEach(async () => {
  calledUrls.length = 0
  await resetFileProgressResourceForTests()
  // Default lane → revision 1; es lane → revision 2. ETag is lane-suffixed
  // server-side, which we mirror so 304 handling stays lane-scoped.
  global.fetch = vi.fn(async (input: unknown) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    calledUrls.push(url)
    const isEs = url.includes('lane=es')
    const revision = isEs ? 2 : 1
    return new Response(JSON.stringify(progressFor('f1', revision)), {
      status: 200,
      headers: { ETag: `"progress:f1:${revision}${isEs ? ':lane:es' : ''}"` },
    })
  }) as unknown as typeof fetch
})

afterEach(async () => {
  await resetFileProgressResourceForTests()
  vi.restoreAllMocks()
})

const token = async () => 'jwt'

describe('file-progress-resource lane threading', () => {
  it('omits ?lane= for the default lane (byte-identical URL)', async () => {
    await getFileProgress('p1', 'f1', token)
    expect(calledUrls).toHaveLength(1)
    expect(calledUrls[0]).toBe('https://sync.test/api/v1/projects/p1/files/f1/progress')
    expect(calledUrls[0]).not.toMatch(/lane=/)
  })

  it('appends ?lane=<tag> for a non-default lane', async () => {
    await getFileProgress('p1', 'f1', token, 'es')
    expect(calledUrls).toHaveLength(1)
    expect(calledUrls[0]).toBe('https://sync.test/api/v1/projects/p1/files/f1/progress?lane=es')
  })

  it('keeps default and non-default lanes in separate cache entries', async () => {
    const def = await getFileProgress('p1', 'f1', token)
    const es = await getFileProgress('p1', 'f1', token, 'es')
    expect(def.revision).toBe(1)
    expect(es.revision).toBe(2)
    // Re-reading the default lane must still see its own resource (revision 1),
    // proving the 'es' fetch did not clobber the default cache key.
    const defAgain = await getFileProgress('p1', 'f1', token)
    expect(defAgain.revision).toBe(1)
    expect(calledUrls.filter((u) => u.includes('lane=es'))).toHaveLength(1)
    expect(calledUrls.filter((u) => !u.includes('lane='))).toHaveLength(2)
  })
})
