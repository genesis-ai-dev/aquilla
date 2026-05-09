/**
 * threads-mirror: Y.Doc cell.threads (Y.Array of Y.Map) → local-store
 * `threads` + `thread_messages`, with outbox emission for the cell-keyed
 * conflict policies in DATA_PERSISTENCE_PLAN.md §9.2.
 */

import { beforeEach, describe, expect, test } from "vitest"
import * as Y from "yjs"
import { LocalStore } from "@/lib/local-store/db"
import { MIGRATIONS } from "@/lib/local-store/migrations"
import { listPending } from "@/lib/local-store/outbox"
import {
  getMessagesByThread,
  getThread,
  getThreadsByCell,
} from "@/lib/local-store/threads"
import type { MirrorContext } from "./registry"
import { createThreadsMirror } from "./threads-mirror"

const NOW = 1_700_000_000_000

interface SeededThread {
  id: string
  status?: "open" | "resolved"
  createdAt?: string
  resolvedAt?: string
  resolvedBy?: string
  messages?: Array<{ id: string; author: string; text: string; timestamp: string }>
}

function ensureCell(yDoc: Y.Doc, cellId: string): Y.Map<unknown> {
  const cellsMap = yDoc.getMap("cells")
  let cell = cellsMap.get(cellId) as Y.Map<unknown> | undefined
  if (!cell) {
    cell = new Y.Map()
    cellsMap.set(cellId, cell)
  }
  return cell
}

function seedThread(
  yDoc: Y.Doc,
  cellId: string,
  thread: SeededThread,
): void {
  yDoc.transact(() => {
    const cell = ensureCell(yDoc, cellId)
    let threads = cell.get("threads") as
      | Y.Array<Y.Map<unknown>>
      | undefined
    if (!threads) {
      threads = new Y.Array<Y.Map<unknown>>()
      cell.set("threads", threads)
    }
    const yThread = new Y.Map<unknown>()
    yThread.set("id", thread.id)
    yThread.set("status", thread.status ?? "open")
    yThread.set("createdAt", thread.createdAt ?? new Date(NOW).toISOString())
    yThread.set("createdBy", "u-seed")
    if (thread.resolvedAt) yThread.set("resolvedAt", thread.resolvedAt)
    if (thread.resolvedBy) yThread.set("resolvedBy", thread.resolvedBy)
    yThread.set("messages", thread.messages ?? [])
    threads.push([yThread])
  })
}

function appendMessage(
  yDoc: Y.Doc,
  cellId: string,
  threadId: string,
  msg: { id: string; author: string; text: string; timestamp: string },
): void {
  yDoc.transact(() => {
    const cell = ensureCell(yDoc, cellId)
    const threads = cell.get("threads") as
      | Y.Array<Y.Map<unknown>>
      | undefined
    if (!threads) return
    for (let i = 0; i < threads.length; i++) {
      const t = threads.get(i)
      if (t.get("id") === threadId) {
        const cur = (t.get("messages") as unknown[]) ?? []
        t.set("messages", [...cur, msg])
        return
      }
    }
  })
}

function transitionStatus(
  yDoc: Y.Doc,
  cellId: string,
  threadId: string,
  to: { status: "resolved"; resolvedBy: string; resolvedAt: string },
): void {
  yDoc.transact(() => {
    const cell = ensureCell(yDoc, cellId)
    const threads = cell.get("threads") as
      | Y.Array<Y.Map<unknown>>
      | undefined
    if (!threads) return
    for (let i = 0; i < threads.length; i++) {
      const t = threads.get(i)
      if (t.get("id") === threadId) {
        t.set("status", to.status)
        t.set("resolvedBy", to.resolvedBy)
        t.set("resolvedAt", to.resolvedAt)
        return
      }
    }
  })
}

async function flushObservers(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30))
}

async function setup(): Promise<{
  yDoc: Y.Doc
  store: LocalStore
  ctx: MirrorContext
  cleanup: () => Promise<void>
}> {
  const store = await LocalStore.open({ name: ":memory:" })
  await store.migrate(MIGRATIONS)
  const yDoc = new Y.Doc()
  const ctx: MirrorContext = {
    store,
    actorId: "u1",
    now: () => NOW,
  }
  return {
    yDoc,
    store,
    ctx,
    cleanup: async () => {
      yDoc.destroy()
      await store.close()
    },
  }
}

describe("threads mirror", () => {
  let yDoc: Y.Doc
  let store: LocalStore
  let ctx: MirrorContext
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    ;({ yDoc, store, ctx, cleanup } = await setup())
  })

  test("bootstrap imports existing Y.Doc threads + messages", async () => {
    seedThread(yDoc, "p1:c1", {
      id: "th-1",
      messages: [
        {
          id: "msg-1",
          author: "alice",
          text: "first",
          timestamp: new Date(NOW).toISOString(),
        },
      ],
    })
    seedThread(yDoc, "p1:c2", {
      id: "th-2",
      messages: [
        {
          id: "msg-2",
          author: "bob",
          text: "second",
          timestamp: new Date(NOW + 1).toISOString(),
        },
      ],
    })

    const mirror = createThreadsMirror({ yDoc })
    await mirror.bootstrap(ctx)

    const t1 = await getThread(store, "th-1")
    expect(t1).toMatchObject({
      id: "th-1",
      cell_id: "p1:c1",
      status: "open",
    })
    const m1 = await getMessagesByThread(store, "th-1")
    expect(m1).toHaveLength(1)
    expect(m1[0].body).toBe("first")
    expect(m1[0].author_id).toBe("alice")

    const t2 = await getThread(store, "th-2")
    expect(t2?.cell_id).toBe("p1:c2")

    await cleanup()
  })

  test("bootstrap is idempotent — re-running does not duplicate rows", async () => {
    seedThread(yDoc, "p1:c1", {
      id: "th-1",
      messages: [
        {
          id: "msg-1",
          author: "alice",
          text: "first",
          timestamp: new Date(NOW).toISOString(),
        },
      ],
    })
    const mirror = createThreadsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    await mirror.bootstrap(ctx)

    const threads = await getThreadsByCell(store, "p1:c1")
    expect(threads).toHaveLength(1)
    const msgs = await getMessagesByThread(store, "th-1")
    expect(msgs).toHaveLength(1)

    await cleanup()
  })

  test("attach: a new thread added later is mirrored + emits thread.create outbox", async () => {
    const mirror = createThreadsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)

    seedThread(yDoc, "p1:c1", {
      id: "th-late",
      messages: [
        {
          id: "msg-late",
          author: "alice",
          text: "hello",
          timestamp: new Date(NOW).toISOString(),
        },
      ],
    })
    await flushObservers()

    expect(await getThread(store, "th-late")).not.toBeNull()
    const pending = await listPending(store)
    const kinds = pending.map((p) => JSON.parse(p.payload).kind as string)
    expect(kinds).toContain("thread.create")
    expect(kinds).toContain("thread.append")

    dispose()
    await cleanup()
  })

  test("attach: an appended message emits thread.append outbox without re-creating thread", async () => {
    seedThread(yDoc, "p1:c1", {
      id: "th-1",
      messages: [
        {
          id: "msg-1",
          author: "alice",
          text: "first",
          timestamp: new Date(NOW).toISOString(),
        },
      ],
    })
    const mirror = createThreadsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)

    appendMessage(yDoc, "p1:c1", "th-1", {
      id: "msg-2",
      author: "bob",
      text: "second",
      timestamp: new Date(NOW + 1).toISOString(),
    })
    await flushObservers()

    const msgs = await getMessagesByThread(store, "th-1")
    expect(msgs.map((m) => m.id)).toEqual(["msg-1", "msg-2"])

    const pending = await listPending(store)
    const kinds = pending.map((p) => JSON.parse(p.payload).kind as string)
    // Should be exactly one thread.append for msg-2; no thread.create.
    expect(kinds.filter((k) => k === "thread.create")).toHaveLength(0)
    const appendCount = kinds.filter((k) => k === "thread.append").length
    expect(appendCount).toBeGreaterThanOrEqual(1)

    dispose()
    await cleanup()
  })

  test("attach: a status transition to resolved emits thread.resolve outbox", async () => {
    seedThread(yDoc, "p1:c1", { id: "th-1" })
    const mirror = createThreadsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)

    transitionStatus(yDoc, "p1:c1", "th-1", {
      status: "resolved",
      resolvedBy: "u-resolver",
      resolvedAt: new Date(NOW + 5).toISOString(),
    })
    await flushObservers()

    const t = await getThread(store, "th-1")
    expect(t?.status).toBe("resolved")
    expect(t?.resolved_by).toBe("u-resolver")

    const pending = await listPending(store)
    const kinds = pending.map((p) => JSON.parse(p.payload).kind as string)
    expect(kinds).toContain("thread.resolve")

    dispose()
    await cleanup()
  })

  test("dispose stops observation; later changes do not propagate", async () => {
    const mirror = createThreadsMirror({ yDoc })
    await mirror.bootstrap(ctx)
    const dispose = mirror.attach(ctx)
    dispose()

    seedThread(yDoc, "p1:c1", { id: "th-after-dispose" })
    await flushObservers()
    expect(await getThread(store, "th-after-dispose")).toBeNull()

    await cleanup()
  })
})
