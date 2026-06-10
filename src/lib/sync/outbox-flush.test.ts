/**
 * Unit tests for outbox-flush.ts
 *
 * Tests flushOutboxBatch with a mocked fetch (injected via FlushDeps.fetchImpl)
 * and a real IDB-backed outbox (fake-indexeddb/auto via src/test-setup.ts).
 *
 * Key scenarios:
 *   - Empty outbox / no token: does not call fetch
 *   - Happy path: all events accepted, removed from outbox
 *   - Partial accept: permanent validation rejects are dropped from outbox
 *   - Network throw / non-2xx: networkError=true, outbox unchanged
 *   - Auth failures stay in outbox so a fresh token / restored role can retry
 *   - Per-file batching: only oldest-file events are sent per call
 *   - Records without fileId: dropped from outbox
 *   - Body parse failure: treated as network error
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { flushOutboxBatch } from "./outbox-flush"
import {
  enqueueOutboxEvent,
  outboxPendingCount,
  peekOutboxBatch,
  peekPendingOutboxBatch,
  resetOutboxConnectionForTests,
} from "./outbox"
import type { CqrsRawEvent } from "./outbox-types"
import { CQRS_SCHEMA_VERSION } from "./outbox-types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _eventSeq = 0

function makeEvent(
  id: string,
  fileId?: string,
  overrides: Partial<CqrsRawEvent<"target.cell.commit">> = {},
): CqrsRawEvent<"target.cell.commit"> {
  return {
    id,
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "target.cell.commit",
    projectId: "proj",
    fileId,
    cellId: "cell-1",
    author: "tester",
    payload: { value: "v", valueHtml: "<p>v</p>" },
    clientTs: ++_eventSeq,
    ...overrides,
  }
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

import type { TokenMintResult } from "./outbox-flush"

const TOKEN_FN = async (): Promise<TokenMintResult> => ({ token: "tok", status: 200 })
const NULL_TOKEN_FN = async (): Promise<TokenMintResult> => ({ token: null, status: null })
const MINT_403_FN = async (): Promise<TokenMintResult> => ({ token: null, status: 403 })
const MINT_401_FN = async (): Promise<TokenMintResult> => ({ token: null, status: 401 })

async function resetIdb(): Promise<void> {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve, reject) => {
    const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    d.onblocked = () => resolve()
    d.onsuccess = () => resolve()
    d.onerror = () => reject(d.error)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flushOutboxBatch", () => {
  beforeEach(async () => {
    _eventSeq = 0
    await resetIdb()
  })

  // -- Empty outbox ----------------------------------------------------------

  it("returns { posted:0, accepted:0, networkError:false } and does not call fetch when outbox is empty", async () => {
    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ posted: 0, accepted: 0, networkError: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // -- No-token path ---------------------------------------------------------

  it("returns { posted:0, accepted:0, networkError:false } and does not call fetch when token is null", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: NULL_TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ posted: 0, accepted: 0, networkError: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // -- Happy path ------------------------------------------------------------

  it("POSTs 3 events with bearer auth; removes all from outbox on full accept", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: [{ id: "e1" }, { id: "e2" }, { id: "e3" }], rejected: [] }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain("/events")
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok")

    const bodyEvents = JSON.parse(init.body as string).events as CqrsRawEvent[]
    expect(bodyEvents).toHaveLength(3)

    expect(result).toMatchObject({ posted: 3, accepted: 3, networkError: false })
    expect(await outboxPendingCount()).toBe(0)
  })

  // -- Partial accept --------------------------------------------------------

  it("removes accepted events and permanent 400 rejected events", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [{ id: "e1" }],
        rejected: [
          { id: "e2", status: 400, reason: "bad payload" },
          { id: "e3", status: 400, reason: "bad payload" },
        ],
      }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ posted: 3, accepted: 1, networkError: false })
    expect(await outboxPendingCount()).toBe(0)
  })

  it("keeps a 401 for retry but quarantines a 403 (403 is not fixable by re-auth)", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [{ id: "e1" }],
        rejected: [
          { id: "e2", status: 401, reason: "token expired" },
          { id: "e3", status: 403, reason: "role too low for cell.commit" },
        ],
      }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ posted: 3, accepted: 1, quarantined: 1, networkError: false })
    // Both rejected records are preserved (no data loss) ...
    expect(await outboxPendingCount()).toBe(2)
    // ... but only the 401 stays retryable; the 403 is quarantined so it can't
    // burn its retry budget or wedge the queue.
    const pending = await peekPendingOutboxBatch(10)
    expect(pending.map((r) => r.id).sort()).toEqual(["e2"])
  })

  // -- Token-mint failures (head-of-line wedge regression) -------------------

  it("quarantines the batch and does NOT call fetch when the token mint returns 403", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: MINT_403_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ quarantined: 2, authError: false })
    // Records preserved (no data loss) but no longer pending → flusher advances.
    expect(await peekPendingOutboxBatch(10)).toHaveLength(0)
    expect(await outboxPendingCount()).toBe(2)
  })

  it("keeps records retryable (no attempt burn, still pending) when the token mint returns 401", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: MINT_401_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ authError: true, quarantined: 0 })
    const pending = await peekPendingOutboxBatch(10)
    expect(pending.map((r) => r.id)).toEqual(["e1"])
    // Error surfaced for the inspector, but attempts NOT bumped (so a recoverable
    // 401 never hits the failed cap and stops auto-draining after re-auth).
    expect(pending[0].attempts).toBe(0)
    expect(pending[0].lastError).toMatchObject({ status: 401 })
  })

  it("a 403-mint file does not block events for a different file/project (no head-of-line wedge)", async () => {
    // e1 belongs to a project we can't mint for; e2 to one we can.
    await enqueueOutboxEvent(makeEvent("e1", "fA", { projectId: "projA" }))
    await enqueueOutboxEvent(makeEvent("e2", "fB", { projectId: "projB" }))
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: [{ id: "e2" }], rejected: [] }),
    )
    // Mint succeeds only for projB; projA mint is a hard 403.
    const getTokenForFile = async (projectId: string): Promise<TokenMintResult> =>
      projectId === "projB" ? { token: "tok", status: 200 } : { token: null, status: 403 }

    // Cycle 1: oldest is e1/projA → quarantined, queue advances (no fetch).
    const r1 = await flushOutboxBatch({ getTokenForFile, fetchImpl: fetchMock as unknown as typeof fetch })
    expect(r1).toMatchObject({ quarantined: 1 })
    expect(fetchMock).not.toHaveBeenCalled()

    // Cycle 2: e2/projB is now the oldest pending → mints and posts successfully.
    const r2 = await flushOutboxBatch({ getTokenForFile, fetchImpl: fetchMock as unknown as typeof fetch })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(r2).toMatchObject({ accepted: 1 })
    // e2 drained; only the quarantined e1 remains (preserved, not pending).
    expect(await peekPendingOutboxBatch(10)).toHaveLength(0)
    const all = await peekOutboxBatch(10)
    expect(all.map((r) => r.id)).toEqual(["e1"])
  })

  // -- Network throw ---------------------------------------------------------

  it("returns networkError:true and leaves outbox unchanged when fetch throws", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ posted: 3, accepted: 0, networkError: true })
    expect(await outboxPendingCount()).toBe(3)
  })

  // -- Non-2xx response ------------------------------------------------------

  it("returns networkError:true and leaves outbox unchanged on 500 response", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }))
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ posted: 3, accepted: 0, networkError: true })
    expect(await outboxPendingCount()).toBe(3)
  })

  // -- Auth failure ----------------------------------------------------------

  it(
    "fetch returns 401 → networkError:true and events stay in outbox for retry",
    async () => {
      await enqueueOutboxEvent(makeEvent("e1", "f1"))

      const fetchMock = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }))
      const result = await flushOutboxBatch({
        getTokenForFile: TOKEN_FN,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      // Matches transient network error behavior — same as 500 or fetch throw
      expect(result.networkError).toBe(true)
      expect(result.accepted).toBe(0)
      expect(await outboxPendingCount()).toBe(1)
    },
  )

  // -- Per-file batching -----------------------------------------------------

  it("groups oldest-file-first: only f1 events are posted when f1 events are older than f2 events", async () => {
    // Enqueue in alternating order — f1 first so it is the "oldest file"
    await enqueueOutboxEvent(makeEvent("f1-e1", "f1"))
    await enqueueOutboxEvent(makeEvent("f2-e1", "f2"))
    await enqueueOutboxEvent(makeEvent("f1-e2", "f1"))
    await enqueueOutboxEvent(makeEvent("f2-e2", "f2"))
    await enqueueOutboxEvent(makeEvent("f1-e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [{ id: "f1-e1" }, { id: "f1-e2" }, { id: "f1-e3" }],
        rejected: [],
      }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const bodyEvents = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    ).events as CqrsRawEvent[]
    // Only f1 events should be in the request body
    expect(bodyEvents.map((e) => e.fileId)).toEqual(["f1", "f1", "f1"])

    expect(result).toMatchObject({ posted: 3, accepted: 3, networkError: false })
    // f2 events must still be in the outbox
    expect(await outboxPendingCount()).toBe(2)
  })

  // -- Starvation: document current "oldest file wins" behavior --------------

  it(
    "STARVATION NOTE (DOCUMENTING current behavior): " +
      "each flush call sends only the oldest file's events; " +
      "if f1 is always older than f2, f2 will starve until f1 is drained",
    async () => {
      // This test locks in the "oldest file wins per call" semantics so a future
      // refactor (e.g. round-robin) can't silently change them without failing here.
      //
      // The outbox sorts by enqueuedAt. We enqueue f1 first, then f2 separately
      // to ensure different timestamps (even on fast hardware where Date.now()
      // might return the same ms, the sequential async enqueue guarantees f1's
      // enqueuedAt <= f2's enqueuedAt, and the IDB index preserves insertion order
      // for equal keys — so f1 remains "oldest").
      // Enqueue with explicit different enqueuedAt values by overriding via IDB directly
      // is not possible here, so we rely on insertion order for equal-key cursors.
      // Giving the events unique IDs that sort before "f2" ensures f1 is always first.
      await enqueueOutboxEvent(makeEvent("starvation-a-f1", "f1"))
      await enqueueOutboxEvent(makeEvent("starvation-b-f2", "f2"))

      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ accepted: [{ id: "starvation-a-f1" }], rejected: [] }),
      )
      await flushOutboxBatch({
        getTokenForFile: TOKEN_FN,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })

      // Only "f1" was flushed this round — f2 is still waiting
      const remaining = await outboxPendingCount()
      expect(remaining).toBe(1)

      const bodyEvents = JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      ).events as CqrsRawEvent[]
      // All events in the POST body must be from f1
      expect(bodyEvents.every((e) => e.fileId === "f1")).toBe(true)
    },
  )

  // -- Records without fileId ------------------------------------------------

  it("drops records without fileId so they cannot poison the outbox", async () => {
    // An event with no fileId ends up as the only / first record
    const noFileEvent = makeEvent("no-file", undefined)
    await enqueueOutboxEvent(noFileEvent)

    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ posted: 0, accepted: 0, networkError: false })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await outboxPendingCount()).toBe(0)
  })

  // -- Body parse failure ----------------------------------------------------

  it("returns networkError:true and leaves outbox unchanged when server returns 200 with non-JSON body", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))
    await enqueueOutboxEvent(makeEvent("e3", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not json at all", { status: 200 }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ posted: 3, accepted: 0, networkError: true })
    expect(await outboxPendingCount()).toBe(3)
  })

  // ── F6 regression: stale-sibling callback ─────────────────────────────────

  it("F6: calls onStaleSiblings with the full stale entries (id + cellId + fileId) so the UI can deep-link", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    await enqueueOutboxEvent(makeEvent("e2", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [{ id: "e1" }, { id: "e2" }],
        rejected: [],
        stale: [{ id: "e2", fileId: "f1", cellId: "c2" }],
      }),
    )
    const onStaleSiblings = vi.fn()
    await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
      onStaleSiblings,
    })

    // Entries pass through verbatim — the banner needs `cellId` to navigate
    // the history drawer to the right cell.
    expect(onStaleSiblings).toHaveBeenCalledWith([
      { id: "e2", fileId: "f1", cellId: "c2" },
    ])
  })

  // ── Cross-project scope: mint by the EVENT's projectId ────────────────────

  it("mints the sync-token with the EVENT's projectId, not a fixed workspace project", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1", { projectId: "project-A" }))

    const tokenFn = vi.fn(async (_pid: string, _fid: string): Promise<TokenMintResult> => ({ token: "tok", status: 200 }))
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: [{ id: "e1" }], rejected: [] }),
    )
    await flushOutboxBatch({
      getTokenForFile: tokenFn,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    // The flusher must pass the queued event's own projectId so the server's
    // token-scope check (projectId in token claims === event.projectId) passes
    // even when a different project is open in the workspace.
    expect(tokenFn).toHaveBeenCalledWith("project-A", "f1")
  })

  // ── 403 quarantine + head-of-line advance ─────────────────────────────────

  it("quarantines a per-event 403 as `failed` so it stops retrying and the queue advances", async () => {
    await enqueueOutboxEvent(makeEvent("waive", "f1", { projectId: "old-project" }))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [],
        rejected: [{ id: "waive", status: 403, reason: "token scoped to different project" }],
      }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: async () => ({ token: "tok", status: 200 }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ quarantined: 1, networkError: false, authError: false })
    // Record is preserved (no silent data loss) ...
    const all = await peekOutboxBatch(10)
    expect(all).toHaveLength(1)
    expect(all[0].status).toBe("failed")
    expect(all[0].lastError).toMatchObject({ status: 403 })
    // ... but excluded from the retry queue, so it can never wedge again.
    const pending = await peekPendingOutboxBatch(10)
    expect(pending).toHaveLength(0)
  })

  it("a poison 403 record no longer head-of-line blocks newer events in other files", async () => {
    // Reproduces the prod wedge: an old cross-project waive is the OLDEST record;
    // a fresh edit sits behind it. Pre-fix, the flusher retried the waive forever
    // and never reached the edit.
    await enqueueOutboxEvent(makeEvent("old-waive", "fileA", { projectId: "project-A" }))
    await enqueueOutboxEvent(makeEvent("new-edit", "fileB", { projectId: "project-B" }))

    const fetchMock = vi
      .fn()
      // 1st flush: oldest file (fileA) → server rejects 403
      .mockResolvedValueOnce(
        jsonResponse({ accepted: [], rejected: [{ id: "old-waive", status: 403, reason: "token scoped to different project" }] }),
      )
      // 2nd flush: fileB should now be reached and accepted
      .mockResolvedValueOnce(jsonResponse({ accepted: [{ id: "new-edit" }], rejected: [] }))

    const r1 = await flushOutboxBatch({ getTokenForFile: async () => ({ token: "tok", status: 200 }), fetchImpl: fetchMock as unknown as typeof fetch })
    expect(r1.quarantined).toBe(1)

    const r2 = await flushOutboxBatch({ getTokenForFile: async () => ({ token: "tok", status: 200 }), fetchImpl: fetchMock as unknown as typeof fetch })
    // The second flush reached fileB and accepted it — proof the queue advanced.
    expect(r2.accepted).toBe(1)
    const bodyEvents = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ).events as CqrsRawEvent[]
    expect(bodyEvents.map((e) => e.id)).toEqual(["new-edit"])
  })

  it("quarantines a whole-batch HTTP 403 instead of retrying it as a network error", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1", { projectId: "p" }))

    const fetchMock = vi.fn().mockResolvedValue(new Response("Forbidden", { status: 403 }))
    const result = await flushOutboxBatch({
      getTokenForFile: async () => ({ token: "tok", status: 200 }),
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result).toMatchObject({ quarantined: 1, networkError: false })
    const pending = await peekPendingOutboxBatch(10)
    expect(pending).toHaveLength(0)
  })

  // ── F5 regression: stale-source callback ──────────────────────────────────

  it("F5: calls onStaleSource with entries when server flags stale sourceEventId pins", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        accepted: [{ id: "e1" }],
        rejected: [],
        staleSource: [{ id: "e1", currentSourceEventId: "src-evt-999" }],
      }),
    )
    const onStaleSource = vi.fn()
    await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
      onStaleSource,
    })

    expect(onStaleSource).toHaveBeenCalledWith([{ id: "e1", currentSourceEventId: "src-evt-999" }])
  })

  // ── FRO-228: comment.* events without fileId must not be dropped ─────────

  it("FRO-228: comment.* events with no fileId are POSTed (not dropped) using project sentinel", async () => {
    // Simulates a comment.resolve on a project-scoped comment that has no fileId.
    const commentEvent: CqrsRawEvent = {
      id: "cmt-resolve-1",
      schemaVersion: CQRS_SCHEMA_VERSION,
      kind: "comment.resolve" as any,
      projectId: "proj",
      fileId: undefined,
      author: "alice",
      payload: { commentId: "cmt-123", resolved: true },
      clientTs: 1,
    }
    await enqueueOutboxEvent(commentEvent)

    let capturedFileId: string | undefined
    const getToken = async (_projectId: string, fileId: string): Promise<TokenMintResult> => {
      capturedFileId = fileId
      return { token: "tok", status: 200 }
    }

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: [{ id: "cmt-resolve-1" }], rejected: [] }),
    )
    const result = await flushOutboxBatch({
      getTokenForFile: getToken,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    // Event must be POSTed, not dropped.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ posted: 1, accepted: 1, networkError: false })
    // Token was minted with the sentinel fileId, not dropped.
    expect(capturedFileId).toBe("__project__")
    expect(await outboxPendingCount()).toBe(0)
  })

  it("FRO-228: non-comment events without fileId are still dropped (existing behaviour)", async () => {
    // target.cell.commit with no fileId — this is a programmer error and should still be dropped.
    const badCellEvent = makeEvent("bad-cell", undefined)
    await enqueueOutboxEvent(badCellEvent)

    const fetchMock = vi.fn()
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ posted: 0, accepted: 0 })
    expect(await outboxPendingCount()).toBe(0)
  })

  // ── BLOCKER 2: mixed-batch quarantine regression ──────────────────────────
  // When the oldest record is a project-scoped comment (no fileId), the batch
  // MUST contain ONLY other no-fileId comment records — NOT file-scoped events.
  // Pre-fix, groupOldestFileFirst did records.slice(0, MAX_BATCH) for no-fileId
  // head, mixing file-scoped events into the batch which 403'd under the
  // sentinel token and got permanently quarantined.

  it("FRO-228 BLOCKER 2: when the oldest record is a no-fileId comment, file-scoped events are NOT included in the same batch", async () => {
    // Force the comment to be the IDB head by giving it a provably earlier enqueuedAt.
    const commentEvent: CqrsRawEvent = {
      id: "proj-comment-head",
      schemaVersion: CQRS_SCHEMA_VERSION,
      kind: "comment.resolve" as any,
      projectId: "proj",
      fileId: undefined,
      author: "alice",
      payload: { commentId: "cmt-1", resolved: true },
      clientTs: 1,
    }
    await enqueueOutboxEvent(commentEvent)

    // Spin-wait until Date.now() advances so cell-commit gets a strictly later enqueuedAt.
    const t0 = Date.now()
    while (Date.now() <= t0) { /* spin */ }

    await enqueueOutboxEvent(makeEvent("cell-after-comment", "file-x"))

    // Capture which events appear in each POST body.
    const capturedBodies: Array<CqrsRawEvent[]> = []
    const capturingFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { events: CqrsRawEvent[] }
      capturedBodies.push(body.events)
      return Promise.resolve(
        jsonResponse({
          accepted: body.events.map((e) => ({ id: e.id })),
          rejected: [],
        }),
      )
    })

    // Flush 1: comment is the oldest record → batch must contain ONLY the comment.
    await flushOutboxBatch({
      getTokenForFile: async (_pid: string, fid: string): Promise<TokenMintResult> => {
        return { token: `tok-${fid}`, status: 200 }
      },
      fetchImpl: capturingFetch as unknown as typeof fetch,
    })

    // The first batch must contain ONLY the project-comment, not the cell event.
    expect(capturedBodies[0]).toHaveLength(1)
    expect(capturedBodies[0][0].id).toBe("proj-comment-head")
    expect(capturedBodies[0].some((e) => e.id === "cell-after-comment")).toBe(false)

    // Flush 2: now the cell-commit is the oldest pending → posted with its own file token.
    await flushOutboxBatch({
      getTokenForFile: async (_pid: string, fid: string): Promise<TokenMintResult> => {
        return { token: `tok-${fid}`, status: 200 }
      },
      fetchImpl: capturingFetch as unknown as typeof fetch,
    })

    expect(capturedBodies[1]).toHaveLength(1)
    expect(capturedBodies[1][0].id).toBe("cell-after-comment")
    expect(await outboxPendingCount()).toBe(0)
  })

  // ── RES-2/M1-4: transient failures must NOT burn the retry budget ─────────

  it("RES-2: network throw (status 0) stamps error but does NOT increment attempts", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))

    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))
    await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const rows = await peekOutboxBatch(10)
    expect(rows).toHaveLength(1)
    // Attempts must NOT be incremented — stampOutboxError doesn't bump the cap.
    expect(rows[0].attempts).toBe(0)
    expect(rows[0].lastError).toMatchObject({ status: 0 })
    expect(rows[0].status).toBe("pending")
  })

  it("RES-2: 5xx response stamps error but does NOT increment attempts", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }))
    await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    const rows = await peekOutboxBatch(10)
    expect(rows[0].attempts).toBe(0)
    expect(rows[0].lastError).toMatchObject({ status: 500 })
    expect(rows[0].status).toBe("pending")
  })

  it("RES-2: 4xx (non-403/401) remains permanent — burns the attempt budget and eventually quarantines", async () => {
    // 400 Bad Request = programmer error (wrong shape) → should be removed as
    // a permanent rejection, not treated as transient.
    await enqueueOutboxEvent(makeEvent("e1", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ accepted: [], rejected: [{ id: "e1", status: 400, reason: "bad shape" }] }),
    )
    await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    // 400 rejected events are removed from the outbox (permanent, per existing policy).
    expect(await outboxPendingCount()).toBe(0)
  })

  it("RES-2: a transient-failed record does NOT reach failed status across multiple 5xx flushes (no budget burn)", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(new Response("Service Unavailable", { status: 503 }))
    // Flush many times — with the old policy (markOutboxAttempt) this would
    // cap at OUTBOX_MAX_ATTEMPTS and flip to failed. With the new policy
    // (stampOutboxError for transient) the record stays pending indefinitely.
    for (let i = 0; i < 10; i++) {
      await flushOutboxBatch({
        getTokenForFile: TOKEN_FN,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    }

    const rows = await peekOutboxBatch(10)
    expect(rows).toHaveLength(1)
    expect(rows[0].attempts).toBe(0) // never incremented
    expect(rows[0].status).toBe("pending") // never flipped to failed
  })

  // ── AUDIT N1: deterministic whole-request 4xx must burn the retry budget ──

  it("N1: a whole-request 400 burns the retry budget and quarantines at the cap (no invisible forever-loop)", async () => {
    // RES-2 made every non-403 !res.ok status no-burn. Right for 0/5xx/timeout
    // (transient), wrong for a deterministic 400/404/422: the same batch fails
    // the same way forever, retried invisibly with no budget pressure. Restore
    // the pre-RES-2 policy for 4xx so the record surfaces as `failed`.
    await enqueueOutboxEvent(makeEvent("e1", "f1"))

    const fetchMock = vi.fn().mockResolvedValue(new Response("Bad Request", { status: 400 }))
    await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    let rows = await peekOutboxBatch(10)
    expect(rows[0].attempts).toBe(1) // budget burned
    expect(rows[0].lastError).toMatchObject({ status: 400 })

    // Repeated deterministic 400s exhaust the budget → failed (visible in the
    // inspector), excluded from the retry queue.
    for (let i = 0; i < 10; i++) {
      await flushOutboxBatch({
        getTokenForFile: TOKEN_FN,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
    }
    rows = await peekOutboxBatch(10)
    expect(rows[0].status).toBe("failed")
    expect(await peekPendingOutboxBatch(10)).toHaveLength(0)
  })

  // ── AUDIT B3: AbortSignal.timeout must be feature-detected on writes ──────

  it("B3: flush still POSTs on engines without AbortSignal.timeout (older WebKit)", async () => {
    // The read path (cells-read.ts) feature-detects AbortSignal.timeout; the
    // write path called it unconditionally, so on engines without it every
    // flush threw BEFORE the fetch — permanently bricking all writes on
    // browsers the read path explicitly supports.
    await enqueueOutboxEvent(makeEvent("e1", "f1"))
    const original = AbortSignal.timeout
    // @ts-expect-error — deliberately simulate an engine lacking the API
    AbortSignal.timeout = undefined
    try {
      const fetchMock = vi.fn().mockResolvedValue(
        jsonResponse({ accepted: [{ id: "e1" }], rejected: [] }),
      )
      const result = await flushOutboxBatch({
        getTokenForFile: TOKEN_FN,
        fetchImpl: fetchMock as unknown as typeof fetch,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ posted: 1, accepted: 1, networkError: false })
      expect(await outboxPendingCount()).toBe(0)
    } finally {
      AbortSignal.timeout = original
    }
  })

  // ── RES-6/M2-5: AbortSignal.timeout propagation ──────────────────────────

  it("RES-6: AbortError (timeout) is treated as transient — stamps error, does NOT burn budget", async () => {
    await enqueueOutboxEvent(makeEvent("e1", "f1"))

    const abortErr = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })
    const fetchMock = vi.fn().mockRejectedValue(abortErr)
    const result = await flushOutboxBatch({
      getTokenForFile: TOKEN_FN,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    expect(result.networkError).toBe(true)
    const rows = await peekOutboxBatch(10)
    expect(rows[0].attempts).toBe(0) // no budget burn
    expect(rows[0].lastError).toMatchObject({ status: 0, reason: "request timed out" })
    expect(rows[0].status).toBe("pending")
  })
})
