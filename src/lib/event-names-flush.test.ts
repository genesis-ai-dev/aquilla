/**
 * AQU-267: Unit tests for outbox-flush quarantine instrumentation.
 *
 * Kept separate from event-names.test.ts because that file mocks
 * "./sync/outbox" (needed for events-emit tests) which conflicts with the
 * real IDB-backed outbox needed here.
 *
 * Uses the same fake-indexeddb setup as outbox-flush.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ── Mock posthog BEFORE importing modules that use it ─────────────────────
// Use vi.hoisted so the factory can safely reference the fn across the hoist boundary.
const { mockCapture } = vi.hoisted(() => ({ mockCapture: vi.fn() }))

vi.mock("@/lib/posthog", () => ({
  default: {
    capture: mockCapture,
    opt_in_capturing: vi.fn(),
    opt_out_capturing: vi.fn(),
  },
}))

// NOTE: do NOT mock "./sync/outbox" here — we need the real IDB for flush tests.

vi.mock("./sync/sync-worker-url", () => ({
  syncWorkerHttpOrigin: vi.fn().mockReturnValue("http://localhost:8787"),
}))

// ── Imports ────────────────────────────────────────────────────────────────
import { OUTBOX_QUARANTINED } from "./event-names"
import { flushOutboxBatch } from "./sync/outbox-flush"
import {
  enqueueOutboxEvent,
  resetOutboxConnectionForTests,
} from "./sync/outbox"
import { CQRS_SCHEMA_VERSION } from "./sync/outbox-types"
import type { TokenMintResult } from "./sync/outbox-flush"

// ── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(id: string, projectId = "proj", fileId = "file-1") {
  return {
    id,
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "target.cell.commit" as const,
    projectId,
    fileId,
    cellId: "cell-1",
    author: "tester",
    payload: { value: "v" },
    clientTs: Date.now(),
  }
}

const TOKEN_OK: () => Promise<TokenMintResult> = async () => ({ token: "tok", status: 200 })
const TOKEN_403: () => Promise<TokenMintResult> = async () => ({ token: null, status: 403 })

async function resetIdb(): Promise<void> {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve, reject) => {
    const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    d.onblocked = () => resolve()
    d.onsuccess = () => resolve()
    d.onerror = () => reject(d.error)
  })
}

beforeEach(async () => {
  mockCapture.mockClear()
  await resetIdb()
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe("flushOutboxBatch — OUTBOX_QUARANTINED instrumentation", () => {
  it("emits OUTBOX_QUARANTINED with reason=token-mint-403 when token mint returns 403", async () => {
    await enqueueOutboxEvent(makeEvent("q-evt-1", "proj-mint403", "file-m"))

    await flushOutboxBatch({
      getTokenForFile: TOKEN_403,
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })

    expect(mockCapture).toHaveBeenCalledWith(
      OUTBOX_QUARANTINED,
      expect.objectContaining({
        reason: "token-mint-403",
        project_id: "proj-mint403",
        count: 1,
      }),
    )
  })

  it("emits OUTBOX_QUARANTINED with reason=post-403 when server responds 403 to whole batch", async () => {
    await enqueueOutboxEvent(makeEvent("q-evt-2", "proj-post403", "file-p"))

    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))

    await flushOutboxBatch({
      getTokenForFile: TOKEN_OK,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    expect(mockCapture).toHaveBeenCalledWith(
      OUTBOX_QUARANTINED,
      expect.objectContaining({
        reason: "post-403",
        project_id: "proj-post403",
        count: 1,
      }),
    )
  })

  it("emits OUTBOX_QUARANTINED with reason=server-rejected-403 when server rejects individual events", async () => {
    await enqueueOutboxEvent(makeEvent("q-evt-3", "proj-rej403", "file-r"))

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: [],
          rejected: [{ id: "q-evt-3", status: 403, reason: "forbidden" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    await flushOutboxBatch({
      getTokenForFile: TOKEN_OK,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    expect(mockCapture).toHaveBeenCalledWith(
      OUTBOX_QUARANTINED,
      expect.objectContaining({
        reason: "server-rejected-403",
        project_id: "proj-rej403",
        count: 1,
      }),
    )
  })

  it("does NOT emit OUTBOX_QUARANTINED on a successful flush", async () => {
    await enqueueOutboxEvent(makeEvent("q-evt-ok", "proj-ok", "file-ok"))

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ accepted: [{ id: "q-evt-ok" }], rejected: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    await flushOutboxBatch({
      getTokenForFile: TOKEN_OK,
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    const quarantineCalls = mockCapture.mock.calls.filter(
      (args) => args[0] === OUTBOX_QUARANTINED,
    )
    expect(quarantineCalls).toHaveLength(0)
  })
})
