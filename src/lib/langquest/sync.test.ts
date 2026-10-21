import { describe, expect, it, vi } from "vitest"
import { syncLangQuest, type LangQuestSyncDeps } from "./sync"
import { LangQuestLinkError } from "./api"
import type { CqrsRawEvent } from "../sync/outbox-types"
import type { KnownPassage, LangQuestChange, LangQuestPassage } from "./types"

function passage(unitId: string, cards = 1, takeId = `${unitId}-t1`): LangQuestPassage {
  return {
    unitId,
    label: `Passage ${unitId}`,
    path: ["Genesis"],
    kind: "passage",
    order: unitId,
    reference: null,
    status: "in_review",
    version: { n: 1, takeId, submittedAt: "x", durationMs: 1000 },
    approvedVersion: null,
    updatedAt: "x",
    audio: Array.from({ length: cards }, (_, i) => ({
      hash: `${unitId}h${i}`,
      format: "m4a" as const,
      durationMs: 500,
      url: `https://next.langquest.org/api/blobs/${unitId}-${i}`,
      expiresAt: "x",
    })),
  }
}

/** A project's server state plus a LangQuest language, wired as the sync's deps. */
function harness(opts: {
  passages: LangQuestPassage[]
  known?: KnownPassage[]
  cursor?: string | null
  changes?: LangQuestChange[]
  expiredCursor?: boolean
  rejectEvents?: boolean
}) {
  const store = { cursor: opts.cursor ?? null, map: new Map((opts.known ?? []).map((k) => [k.unitId, k])), outcome: undefined as string | null | undefined }
  const events: CqrsRawEvent[] = []
  const uploads: string[] = []
  const files: string[] = []
  const deps: LangQuestSyncDeps = {
    projectId: "proj-1",
    languageId: "lang-kal",
    author: "lee",
    targetLang: "kmh",
    fetchState: async () => ({ cursor: store.cursor, passages: [...store.map.values()] }),
    saveState: async (b) => {
      for (const u of b.upserts ?? []) store.map.set(u.unitId, u)
      for (const r of b.removed ?? []) store.map.delete(r)
      if (b.cursor !== undefined) store.cursor = b.cursor
      if (b.outcome) store.outcome = b.outcome.error
    },
    fetchChanges: async (after) => {
      if (after && opts.expiredCursor) throw new LangQuestLinkError("too old", 410, "cursor_expired", false)
      const changes = (opts.changes ?? []).filter((c) => after == null || Number(c.cursor) > Number(after))
      return { changes: after == null ? [] : changes, cursor: String(opts.changes?.at(-1)?.cursor ?? "100"), more: false }
    },
    fetchPassages: async ({ unitIds }) => ({
      passages: unitIds ? opts.passages.filter((p) => unitIds.includes(p.unitId)) : opts.passages,
      nextAfter: null,
    }),
    fetchAudio: async (url) => new Blob([url]),
    uploadSource: async (args) => {
      files.push(args.file.name)
    },
    postEvents: async ({ events: batch }) => {
      events.push(...batch)
      return opts.rejectEvents
        ? { posted: 0, rejected: batch.map((e) => ({ id: e.id, reason: "role" })), stale: [] }
        : { posted: batch.length, rejected: [], stale: [] }
    },
    uploadAudio: async (args) => {
      uploads.push(args.audioId)
    },
    getToken: async () => "sync-token",
  } as LangQuestSyncDeps
  return { deps, store, events, uploads, files }
}

describe("syncLangQuest", () => {
  it("first sync lists everything, imports each book, and starts the feed from before the listing", async () => {
    const h = harness({ passages: [passage("01"), passage("02")] })
    const result = await syncLangQuest(h.deps)
    expect(result).toMatchObject({ mode: "full", cellsCreated: 2, takesAttached: 2 })
    expect(h.files).toEqual(["Genesis"])
    expect(h.store.cursor).toBe("100")
    expect(h.store.map.size).toBe(2)
    expect(h.store.outcome).toBeNull()
  })

  it("plays a multi-card version as one take: the first card the take, the rest its pieces in order", async () => {
    const h = harness({ passages: [passage("01", 3)] })
    await syncLangQuest(h.deps)
    const attaches = h.events.filter((e) => e.kind === "cell.audio.attach")
    expect(attaches).toHaveLength(3)
    const payloads = attaches.map((e) => e.payload as { audioId: string; pieceOf?: string; role: string; targetLang: string })
    expect(payloads[0]!.pieceOf).toBeUndefined()
    expect(payloads[1]!.pieceOf).toBe(payloads[0]!.audioId)
    expect(payloads[2]!.pieceOf).toBe(payloads[0]!.audioId)
    // Recordings are the translation: dubs in the LangQuest language's lane, never source audio.
    expect(payloads.every((p) => p.role === "dub" && p.targetLang === "kmh")).toBe(true)
    expect(h.uploads).toEqual(payloads.map((p) => p.audioId))
  })

  it("a later sync reads only what the feed names, and attaches the new version", async () => {
    const first = harness({ passages: [passage("01"), passage("02")] })
    await syncLangQuest(first.deps)
    const h = harness({
      passages: [passage("01", 1, "01-t2"), passage("02")],
      known: [...first.store.map.values()],
      cursor: "100",
      changes: [{ cursor: "101", type: "passage.version.submitted", unitId: "01", at: "x" }],
    })
    const result = await syncLangQuest(h.deps)
    expect(result).toMatchObject({ mode: "changes", passagesRead: 1, cellsCreated: 0, takesAttached: 1 })
    expect(h.store.cursor).toBe("101")
    expect(h.store.map.get("01")!.takeId).toBe("01-t2")
  })

  it("a deleted unit removes its cell", async () => {
    const first = harness({ passages: [passage("01")] })
    await syncLangQuest(first.deps)
    const h = harness({
      passages: [],
      known: [...first.store.map.values()],
      cursor: "100",
      changes: [{ cursor: "101", type: "unit.deleted", unitId: "01", at: "x" }],
    })
    await syncLangQuest(h.deps)
    expect(h.events.map((e) => e.kind)).toEqual(["source.cell.delete"])
    expect(h.store.map.size).toBe(0)
  })

  it("an expired cursor falls back to a full listing that changes nothing already imported", async () => {
    const first = harness({ passages: [passage("01")] })
    await syncLangQuest(first.deps)
    const h = harness({ passages: [passage("01")], known: [...first.store.map.values()], cursor: "5", expiredCursor: true })
    const result = await syncLangQuest(h.deps)
    expect(result.mode).toBe("full")
    expect(h.events).toEqual([])
    expect(h.files).toEqual([])
  })

  it("does not advance the map or cursor past events the server refused, and records why", async () => {
    const first = harness({ passages: [passage("01")] })
    await syncLangQuest(first.deps)
    const h = harness({
      passages: [passage("01", 1, "01-t2")],
      known: [...first.store.map.values()],
      cursor: "100",
      changes: [{ cursor: "101", type: "passage.version.submitted", unitId: "01", at: "x" }],
      rejectEvents: true,
    })
    await expect(syncLangQuest(h.deps)).rejects.toThrow(/not applied/)
    expect(h.store.map.get("01")!.takeId).toBe("01-t1")
    expect(h.store.cursor).toBe("100")
    expect(h.store.outcome).toMatch(/not applied/)
  })

  it("stops between pages when cancelled", async () => {
    const h = harness({ passages: [passage("01")] })
    const controller = new AbortController()
    controller.abort()
    const spy = vi.spyOn(h.deps, "fetchPassages")
    await expect(syncLangQuest({ ...h.deps, signal: controller.signal })).rejects.toThrow(/cancelled/)
    expect(spy).not.toHaveBeenCalled()
  })
})
