// AQU-1901: a translation edit or validation the server refuses inside a 200
// must reach the reader — undone on screen and announced — instead of being
// dropped while the status chip goes back to "Synced". Drives the real
// flusher against a fake-indexeddb outbox and a mocked /events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { enqueueOutboxEvent, outboxPendingCount, resetOutboxConnectionForTests } from "./outbox"
import { flushOutboxBatch, subscribeRejected, type RejectedEntry, type TokenMintResult } from "./outbox-flush"
import { CQRS_SCHEMA_VERSION, type CqrsRawEvent } from "./outbox-types"
import { isLaneWriteKind, laneWriteRejections } from "./lane-write-rejections"
import { settleOwnEvent } from "./settle-own-event"

const TOKEN = async (): Promise<TokenMintResult> => ({ token: "tok", status: 200 })
// The AQU-1900 refusal of a write that names no lane on a tagged-only project.
const NO_LANE = { status: 422, reason: "no lane named: this project has no default lane" }

let seq = 0
function commit(id: string, cellId = "GEN 1:1"): CqrsRawEvent<"target.cell.commit"> {
  return {
    id,
    schemaVersion: CQRS_SCHEMA_VERSION,
    kind: "target.cell.commit",
    projectId: "proj",
    fileId: "f1",
    cellId,
    author: "adv-bot-1",
    payload: { value: "Hapo mwanzo Mungu", valueHtml: "<p>Hapo mwanzo Mungu</p>" },
    clientTs: ++seq,
  }
}

function respond(body: object) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch
}

async function resetIdb(): Promise<void> {
  await resetOutboxConnectionForTests()
  await new Promise<void>((resolve, reject) => {
    const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
    d.onblocked = () => resolve()
    d.onsuccess = () => resolve()
    d.onerror = () => reject(d.error)
  })
}

let heard: RejectedEntry[][]
let unsubscribe: () => void

beforeEach(async () => {
  seq = 0
  await resetIdb()
  heard = []
  unsubscribe = subscribeRejected((entries) => { heard.push(entries) })
})

afterEach(() => unsubscribe())

describe("a refused edit reaches the workspace (AQU-1901)", () => {
  it("tells the tab-wide listener about a hand-typed edit refused inside a 200, with its cell", async () => {
    // The app-shell drain posts it: no caller of its own is watching.
    await enqueueOutboxEvent(commit("e1"))
    await flushOutboxBatch({ getTokenForFile: TOKEN, fetchImpl: respond({ accepted: [], rejected: [{ id: "e1", ...NO_LANE }] }) })

    expect(heard).toEqual([[
      { id: "e1", kind: "target.cell.commit", fileId: "f1", cellId: "GEN 1:1", ...NO_LANE },
    ]])
    // It is gone from the outbox — retrying would fail the same way — which is
    // exactly why the chip alone would have read "Synced".
    expect(await outboxPendingCount()).toBe(0)
    expect(laneWriteRejections(heard[0])).toEqual([
      { id: "e1", kind: "target.cell.commit", fileId: "f1", cellId: "GEN 1:1", ...NO_LANE },
    ])
  })

  it("leaves to the caller what the caller claims, and passes on what shares its batch", async () => {
    await enqueueOutboxEvent(commit("mine", "GEN 1:1"))
    await enqueueOutboxEvent(commit("theirs", "GEN 1:2"))
    const onRejected = vi.fn((entries: RejectedEntry[]) => entries.filter((e) => e.id === "mine").map((e) => e.id))
    await flushOutboxBatch({
      getTokenForFile: TOKEN,
      fetchImpl: respond({ accepted: [], rejected: [{ id: "mine", ...NO_LANE }, { id: "theirs", ...NO_LANE }] }),
      onRejected,
    })

    expect(onRejected).toHaveBeenCalledOnce()
    expect(heard.flat().map((e) => e.id)).toEqual(["theirs"])
  })

  it("an AI draft that is refused settles as refused — never as accepted, which the row confirms as \"Saved\"", async () => {
    await enqueueOutboxEvent(commit("draft"))
    const outcome = await settleOwnEvent("draft", {
      getTokenForFile: TOKEN,
      fetchImpl: respond({ accepted: [], rejected: [{ id: "draft", ...NO_LANE }] }),
    })

    expect(outcome).toEqual({ kind: "refused", ...NO_LANE })
    // The draft flow reports it itself, so the workspace does not announce it twice.
    expect(heard).toEqual([])
  })

  it("an AI draft refused with a 403 settles as refused too", async () => {
    await enqueueOutboxEvent(commit("draft"))
    const outcome = await settleOwnEvent("draft", {
      getTokenForFile: TOKEN,
      fetchImpl: respond({ accepted: [], rejected: [{ id: "draft", status: 403, reason: "lane is archived" }] }),
    })
    expect(outcome).toEqual({ kind: "refused", status: 403, reason: "lane is archived" })
  })

  it("an accepted draft settles as accepted, and a dead-lettered one as dead-lettered", async () => {
    await enqueueOutboxEvent(commit("ok"))
    expect(await settleOwnEvent("ok", { getTokenForFile: TOKEN, fetchImpl: respond({ accepted: [{ id: "ok" }] }) }))
      .toEqual({ kind: "accepted" })

    await enqueueOutboxEvent(commit("lost"))
    expect(await settleOwnEvent("lost", {
      getTokenForFile: TOKEN,
      fetchImpl: respond({ accepted: [{ id: "lost" }], stale: [{ id: "lost", fileId: "f1", cellId: "GEN 1:1" }] }),
    })).toEqual({ kind: "dead-lettered" })
  })
})

describe("laneWriteRejections", () => {
  const entry = (kind: string, cellId: string | null = "c1"): RejectedEntry =>
    ({ id: kind, kind, fileId: "f1", cellId, status: 422, reason: "r" })

  it("takes a line's text and its validation, nothing else", () => {
    expect(isLaneWriteKind("target.cell.commit")).toBe(true)
    expect(isLaneWriteKind("target.cell.create")).toBe(true)
    expect(isLaneWriteKind("cell.validate")).toBe(true)
    expect(isLaneWriteKind("cell.unvalidate")).toBe(true)
    expect(isLaneWriteKind("source.cell.commit")).toBe(false)
    expect(isLaneWriteKind("file.track.set")).toBe(false)
    expect(laneWriteRejections([
      entry("target.cell.commit"),
      entry("cell.validate"),
      entry("source.cell.create"),
      entry("comment.create"),
      entry("target.cell.commit", null),
    ]).map((r) => r.kind)).toEqual(["target.cell.commit", "cell.validate"])
  })
})
