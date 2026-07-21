import { describe, it, expect, vi, afterEach } from "vitest"
import {
  bulkUploadSource,
  publishStagedImport,
  reconcileSourceImport,
  type BulkImportCell,
} from "./bulk-import"
import * as sourceUpload from "./source-upload"

// Stub syncWorkerHttpOrigin so no VITE env lookup is needed.
vi.mock("./sync-worker-url", () => ({
  syncWorkerHttpOrigin: () => "https://sync.example",
}))

// Stub source-upload so rawBytes tests don't need a real worker.
vi.mock("./source-upload", () => ({
  assertSourceUploadSize: vi.fn(),
  uploadSourceOriginal: vi.fn().mockResolvedValue({ artifactId: "artifact-1", key: "key", sha256: "digest" }),
}))

function makeCell(i: number): BulkImportCell {
  return {
    id: `evt-${i}`,
    cellId: `cell-${i}`,
    anchorCellId: i === 0 ? null : `cell-${i - 1}`,
    value: `verse ${i}`,
  }
}

describe("bulkUploadSource", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it("throws if getToken returns null", async () => {
    await expect(
      bulkUploadSource({
        projectId: "p1",
        fileId: "f1",
        file: { id: "file-evt", name: "test.txt" },
        cells: [makeCell(0)],
        getToken: async () => null,
      }),
    ).rejects.toThrow(/signed out/)
  })

  it("sends one request for a small batch (< 1500 cells)", async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return new Response(JSON.stringify({ accepted: 3, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "gen.txt" },
      cells: [makeCell(0), makeCell(1), makeCell(2)],
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = bodies[0] as Record<string, unknown>
    expect(body.projectId).toBe("p1")
    expect(body.fileId).toBe("f1")
    expect((body.cells as unknown[]).length).toBe(3)
    // file meta included on first (only) chunk
    expect(body.file).toBeDefined()
    expect(body.stageEventId).toEqual(expect.any(String))
    expect((bodies[1] as Record<string, unknown>).complete).toBe(true)
    expect((bodies[1] as Record<string, unknown>).publishEventId).toEqual(expect.any(String))
  })

  it("sends multiple chunks for > 1500 cells", async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    const cells = Array.from({ length: 3200 }, (_, i) => makeCell(i))
    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "big.txt" },
      cells,
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    // 3200 cells / 1500 per chunk → 3 data requests, then one completion hint.
    expect(fetchMock).toHaveBeenCalledTimes(4)
    // file meta only on first chunk
    expect((bodies[0] as Record<string, unknown>).file).toBeDefined()
    expect((bodies[1] as Record<string, unknown>).file).toBeUndefined()
  })

  it("calls onProgress with cumulative count", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 }),
    ) as typeof fetch

    const progress: Array<[number, number]> = []
    const cells = Array.from({ length: 3000 }, (_, i) => makeCell(i))
    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "big.txt" },
      cells,
      getToken: async () => "tok",
      onProgress: (u, t) => progress.push([u, t]),
      fetchImpl: fetchMock,
    })

    expect(progress.length).toBe(2)
    expect(progress[0]).toEqual([1500, 3000])
    expect(progress[1]).toEqual([3000, 3000])
  })

  it("sends the file.create chunk alone, then uploads the rest concurrently", async () => {
    // ~30k-cell imports POST ~20 chunks. Sending them sequentially serializes
    // ~20 network round trips. The first chunk carries file.create and must
    // land first (the file row has to exist), but the remaining genesis-cell
    // chunks are independent — idempotent inserts, atomically-allocated seq
    // ranges, arrival-independent cell order — so they can overlap.
    let inFlight = 0
    let maxInFlight = 0
    let firstChunkResolved = false
    let nonFirstStartedBeforeFirstResolved = false
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      const isFirst = body.file !== undefined
      if (!isFirst && !firstChunkResolved) nonFirstStartedBeforeFirstResolved = true
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      if (isFirst) firstChunkResolved = true
      return new Response(
        JSON.stringify({ accepted: (body.cells as unknown[]).length, fileId: "f1" }),
        { status: 200 },
      )
    }) as typeof fetch

    // 6500 cells / 1500 per chunk → 5 chunks (1 first + 4 that can overlap),
    // followed by one completion hint after they have all settled.
    const cells = Array.from({ length: 6500 }, (_, i) => makeCell(i))
    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "big.txt" },
      cells,
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    expect(fetchMock).toHaveBeenCalledTimes(6)
    // Ordering invariant: the file.create chunk completes before any other starts.
    expect(nonFirstStartedBeforeFirstResolved).toBe(false)
    // Concurrency: the 4 trailing chunks overlap instead of running one-at-a-time.
    expect(maxInFlight).toBeGreaterThan(1)
  })

  it("throws a readable error on non-OK response", async () => {
    const fetchMock = vi.fn(
      async () => new Response("role too low", { status: 403 }),
    ) as typeof fetch

    await expect(
      bulkUploadSource({
        projectId: "p1",
        fileId: "f1",
        file: { id: "file-evt", name: "test.txt" },
        cells: [makeCell(0)],
        getToken: async () => "tok",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/403/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("retries a data chunk after a transient network failure", async () => {
    vi.useFakeTimers()
    let dataAttempts = 0
    const progress = vi.fn()
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      if (body.complete) {
        return new Response(JSON.stringify({ accepted: 0, fileId: "f1" }), { status: 200 })
      }
      dataAttempts++
      if (dataAttempts === 1) throw new TypeError("Failed to fetch")
      return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    const upload = bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "test.txt" },
      cells: [makeCell(0)],
      getToken: async () => "tok",
      onProgress: progress,
      fetchImpl: fetchMock,
    })
    await vi.runAllTimersAsync()
    await expect(upload).resolves.toBeUndefined()

    expect(dataAttempts).toBe(2)
    expect(progress).toHaveBeenCalledTimes(1)
    expect(progress).toHaveBeenCalledWith(1, 1)
  })

  it("retries a data chunk after a retryable HTTP response", async () => {
    vi.useFakeTimers()
    let dataAttempts = 0
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      if (body.complete) {
        return new Response(JSON.stringify({ accepted: 0, fileId: "f1" }), { status: 200 })
      }
      dataAttempts++
      if (dataAttempts === 1) return new Response("temporary", { status: 503 })
      return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    const upload = bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "test.txt" },
      cells: [makeCell(0)],
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })
    await vi.runAllTimersAsync()
    await expect(upload).resolves.toBeUndefined()
    expect(dataAttempts).toBe(2)
  })

  it("retries transient finalization failures without re-uploading data", async () => {
    vi.useFakeTimers()
    let finalizeAttempts = 0
    let dataAttempts = 0
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      if (body.complete) {
        finalizeAttempts++
        if (finalizeAttempts < 3) return new Response("temporary", { status: 503 })
        return new Response(JSON.stringify({ accepted: 0, fileId: "f1" }), { status: 200 })
      }
      dataAttempts++
      return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    const upload = bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "test.txt" },
      cells: [makeCell(0)],
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })
    await vi.runAllTimersAsync()
    await expect(upload).resolves.toBeUndefined()

    expect(dataAttempts).toBe(1)
    expect(finalizeAttempts).toBe(3)
  })

  it("does not retry a terminal finalization rejection", async () => {
    let finalizeAttempts = 0
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      if (body.complete) {
        finalizeAttempts++
        return new Response("invalid completion", { status: 400 })
      }
      return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    await expect(
      bulkUploadSource({
        projectId: "p1",
        fileId: "f1",
        file: { id: "file-evt", name: "test.txt" },
        cells: [makeCell(0)],
        getToken: async () => "tok",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/HTTP 400/)
    expect(finalizeAttempts).toBe(1)
  })

  it("waits for concurrent chunks and finalizes partial state after a chunk fails", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      bodies.push(body)
      if (body.complete) {
        return new Response(JSON.stringify({ accepted: 0, fileId: "f1" }), { status: 200 })
      }
      const cells = body.cells as BulkImportCell[]
      if (cells[0]?.cellId === "cell-1500") {
        return new Response("chunk failed", { status: 500 })
      }
      return new Response(JSON.stringify({ accepted: cells.length, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    const cells = Array.from({ length: 3200 }, (_, i) => makeCell(i))
    await expect(
      bulkUploadSource({
        projectId: "p1",
        fileId: "f1",
        file: { id: "file-evt", name: "big.txt" },
        cells,
        getToken: async () => "tok",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow(/HTTP 500/)

    expect(bodies.at(-1)?.complete).toBe(true)
    expect(bodies.filter((body) => body.complete)).toHaveLength(1)
  })

  it("calls uploadSourceOriginal once with correct args when rawBytes is provided", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 }),
    ) as typeof fetch

    const rawBytes = new ArrayBuffer(4)
    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "test.docx" },
      cells: [makeCell(0)],
      rawBytes,
      rawSourceFormat: "docx",
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    const uploadMock = vi.mocked(sourceUpload.uploadSourceOriginal)
    expect(uploadMock).toHaveBeenCalledTimes(1)
    expect(uploadMock).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      fileId: "f1",
      artifactId: expect.any(String),
      bytes: rawBytes,
      format: "docx",
      getToken: expect.any(Function),
      artifactName: "test.docx",
      bindingRole: "source",
      fidelity: "native",
    }))
  })

  it("preserves text originals as first-class artifacts too", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string))
        return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
      },
    ) as typeof fetch

    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "test.usfm" },
      cells: [makeCell(0)],
      rawSource: "\\id GEN",
      rawSourceFormat: "usfm",
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    expect(vi.mocked(sourceUpload.uploadSourceOriginal)).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      fileId: "f1",
      artifactId: expect.any(String),
      format: "usfm",
    }))
    expect(bodies[0]).not.toHaveProperty("rawSource")
    expect(bodies[0]).not.toHaveProperty("rawSourceFormat")
  })

  it("keeps a staged file hidden when artifact preservation fails", async () => {
    vi.mocked(sourceUpload.uploadSourceOriginal).mockRejectedValueOnce(new Error("R2 unavailable"))
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>
      bodies.push(body)
      return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
    }) as typeof fetch

    await expect(bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "test.docx" },
      cells: [makeCell(0)],
      rawBytes: new ArrayBuffer(4),
      rawSourceFormat: "docx",
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })).rejects.toThrow(/R2 unavailable/)

    expect(bodies.at(-1)).toMatchObject({ complete: true })
    expect(bodies.at(-1)).not.toHaveProperty("publishEventId")
  })

  it("batches target commits with their source parents before publication", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return new Response(JSON.stringify({ accepted: 1, fileId: "f1" }), { status: 200 })
    }) as typeof fetch
    const cells = [makeCell(0), makeCell(1)]
    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "pairs.xlf" },
      cells,
      targets: cells.map((cell, index) => ({
        id: `target-${index}`,
        cellId: cell.cellId,
        parentId: cell.id,
        value: `translation ${index}`,
      })),
      targetLang: "fr-CA",
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    expect(bodies[0].targets).toEqual([
      expect.objectContaining({ id: "target-0", targetLang: "fr-CA" }),
      expect.objectContaining({ id: "target-1", targetLang: "fr-CA" }),
    ])
  })

  it("can finalize a file without publishing it for post-processing", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      return Response.json({ accepted: 1, fileId: "f1" })
    }) as typeof fetch

    await bulkUploadSource({
      projectId: "p1",
      fileId: "f1",
      file: { id: "file-evt", name: "recording.wav" },
      cells: [makeCell(0)],
      deferPublication: true,
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    expect(bodies.at(-1)).toMatchObject({ complete: true })
    expect(bodies.at(-1)).not.toHaveProperty("publishEventId")
  })

  it("publishes a staged file with stable attachment event ids", async () => {
    vi.useFakeTimers()
    const bodies: Array<Record<string, unknown>> = []
    let attempts = 0
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string))
      attempts++
      if (attempts === 1) return new Response("temporary", { status: 503 })
      return Response.json({ accepted: 1, fileId: "f1" })
    }) as typeof fetch

    const publishing = publishStagedImport({
      projectId: "p1",
      fileId: "f1",
      attachments: [{
        cellId: "cell-0",
        audioId: "audio-1.wav",
        url: "frontier-audio://audio-1.wav",
        slot: "recording",
        mimeType: "audio/wav",
      }],
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })
    await vi.runAllTimersAsync()
    await publishing

    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[0]).toMatchObject({
      complete: true,
      publishEventId: expect.any(String),
      attachments: [{
        id: expect.any(String),
        cellId: "cell-0",
        audioId: "audio-1.wav",
      }],
    })
  })
})

describe("reconcileSourceImport", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it("uploads an immutable original without switching the sidecar before reconciliation", async () => {
    const responseBody = {
      fileId: "existing-file",
      replayed: false,
      matched: 1,
      added: 0,
      changed: 1,
      unchanged: 0,
      retainedMissing: 2,
      importedTargets: 0,
    }
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(responseBody))
    const fetchMock = fetchSpy as typeof fetch
    const result = await reconcileSourceImport({
      projectId: "p1",
      fileId: "existing-file",
      file: { id: "reimport-event", name: "GEN.usfm", fileType: "usfm" },
      cells: [{
        ...makeCell(0),
        metadata: { aquillaImport: { unitKey: "scripture:GEN 1:1" } },
      }],
      rawSource: "\\id GEN\n\\c 1\n\\v 1 Updated",
      rawSourceFormat: "usfm",
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })

    expect(result).toEqual(responseBody)
    expect(vi.mocked(sourceUpload.uploadSourceOriginal)).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1",
      fileId: "existing-file",
      bindingRole: "source",
      updateSourceSidecar: false,
    }))
    expect(fetchSpy).toHaveBeenCalledOnce()
    expect(fetchSpy.mock.calls[0][0]).toBe("https://sync.example/import/reconcile")
    const payload = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
    expect(payload).toMatchObject({
      projectId: "p1",
      fileId: "existing-file",
      artifactId: "artifact-1",
      rawSourceFormat: "usfm",
    })
  })

  it("does not upload a source artifact when the parsed format has no original bytes", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      fileId: "existing-file", replayed: false, matched: 0, added: 1,
      changed: 1, unchanged: 0, retainedMissing: 0, importedTargets: 0,
    }))
    const fetchMock = fetchSpy as typeof fetch
    await reconcileSourceImport({
      projectId: "p1",
      fileId: "existing-file",
      file: { id: "reimport-event", name: "generated.txt", fileType: "txt" },
      cells: [makeCell(0)],
      getToken: async () => "tok",
      fetchImpl: fetchMock,
    })
    expect(vi.mocked(sourceUpload.uploadSourceOriginal)).not.toHaveBeenCalled()
    const payload = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string)
    expect(payload.artifactId).toBeUndefined()
  })
})
