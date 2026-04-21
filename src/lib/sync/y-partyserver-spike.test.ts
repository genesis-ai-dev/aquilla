// @vitest-environment node
// Spike: does our Y.Doc shape round-trip cleanly through y-partyserver?
// Requires the codex-sync-worker running locally:
//   cd sync-worker && npx wrangler dev
// If not reachable, the whole suite skips so `npm test` stays green.
// Runs in Node env (not happy-dom) because WebSocket + fetch semantics are cleanest there.

import { describe, it, expect, beforeAll, afterEach, type TestContext } from "vitest"
import * as Y from "yjs"
import YProvider from "y-partyserver/provider"
import { getFragmentHtml } from "@/lib/richtext/translated-xml"
import type { CellHistoryEntry } from "@/lib/parsers/types"

const HOST = "127.0.0.1:8787"

function uniqueDocId(): string {
  return `codex-spike-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function serverReachable(): Promise<boolean> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 500)
  try {
    const res = await fetch(`http://${HOST}/parties/file-sync/health-probe`, { signal: controller.signal })
    // Any HTTP response proves the server is up; wrangler-dev may return 400/404/426 for non-WS hits.
    return res.status >= 200 && res.status < 600
  } catch {
    return false
  } finally {
    clearTimeout(t)
  }
}

function waitForCondition(predicate: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function waitForSync(provider: YProvider, timeoutMs = 3000): Promise<void> {
  if (provider.wsconnected && (provider as unknown as { _synced: boolean })._synced) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for sync")), timeoutMs)
    provider.once("sync", (isSynced: boolean) => {
      if (isSynced) { clearTimeout(t); resolve() }
    })
  })
}

interface TwoClientHarness {
  docA: Y.Doc
  docB: Y.Doc
  providerA: YProvider
  providerB: YProvider
  cleanup: () => void
}

async function openTwoClients(docId: string): Promise<TwoClientHarness> {
  const docA = new Y.Doc()
  const docB = new Y.Doc()
  const providerA = new YProvider(HOST, docId, docA, { protocol: "ws", party: "file-sync" })
  const providerB = new YProvider(HOST, docId, docB, { protocol: "ws", party: "file-sync" })
  await Promise.all([waitForSync(providerA), waitForSync(providerB)])
  const cleanup = () => {
    providerA.destroy()
    providerB.destroy()
    docA.destroy()
    docB.destroy()
  }
  return { docA, docB, providerA, providerB, cleanup }
}

describe("y-partyserver spike: Y.Doc round-trip", () => {
  let canRun = false

  beforeAll(async () => {
    canRun = await serverReachable()
  })

  function skipIfNoServer(ctx: TestContext): boolean {
    if (!canRun) {
      ctx.skip(
        `no sync worker at ws://${HOST}. Start one with: cd sync-worker && npx wrangler dev`
      )
      return true
    }
    return false
  }

  let harness: TwoClientHarness | null = null
  afterEach(() => {
    if (harness) {
      harness.cleanup()
      harness = null
    }
  })

  it("round-trips a Y.XmlFragment holding rich-text HTML", async (ctx) => {
    if (skipIfNoServer(ctx)) return
    harness = await openTwoClients(uniqueDocId())
    const { docA, docB } = harness

    const expectedHtml = "<p>hello <b>world</b></p>"
    const cellsA = docA.getMap("cells")
    docA.transact(() => {
      const cell = new Y.Map()
      const frag = new Y.XmlFragment()
      cell.set("translatedXml", frag)
      const paragraph = new Y.XmlElement("paragraph")
      const text = new Y.XmlText()
      text.insert(0, "hello ")
      text.insert(6, "world", { bold: true })
      paragraph.insert(0, [text])
      frag.insert(0, [paragraph])
      cellsA.set("cell-1", cell)
    })

    const cellsB = docB.getMap("cells")
    await waitForCondition(() => {
      const cell = cellsB.get("cell-1") as Y.Map<unknown> | undefined
      const frag = cell?.get("translatedXml") as Y.XmlFragment | undefined
      return !!frag && getFragmentHtml(frag).length > 0
    }, 3000, "XmlFragment propagation to doc B")

    const cellB = cellsB.get("cell-1") as Y.Map<unknown>
    const fragB = cellB.get("translatedXml") as Y.XmlFragment
    expect(getFragmentHtml(fragB)).toBe(expectedHtml)
  })

  it("round-trips a history Y.Array of plain-object CellHistoryEntry records", async (ctx) => {
    if (skipIfNoServer(ctx)) return
    harness = await openTwoClients(uniqueDocId())
    const { docA, docB } = harness

    const entry: CellHistoryEntry = {
      timestamp: "2026-04-20T12:00:00.000Z",
      value: "hola",
      source: "human",
      author: "alice",
      validated: false,
    }

    const cellsA = docA.getMap("cells")
    docA.transact(() => {
      const cell = new Y.Map()
      const history = new Y.Array<CellHistoryEntry>()
      history.push([entry])
      cell.set("history", history)
      cellsA.set("cell-1", cell)
    })

    const cellsB = docB.getMap("cells")
    await waitForCondition(() => {
      const cell = cellsB.get("cell-1") as Y.Map<unknown> | undefined
      const hist = cell?.get("history") as Y.Array<CellHistoryEntry> | undefined
      return !!hist && hist.length === 1
    }, 3000, "history array propagation to doc B")

    const cellB = cellsB.get("cell-1") as Y.Map<unknown>
    const histB = cellB.get("history") as Y.Array<CellHistoryEntry>
    expect(histB.toArray()).toEqual([entry])
  })

  it("round-trips __source stash as a plain JS object inside a Y.Map", async (ctx) => {
    if (skipIfNoServer(ctx)) return
    harness = await openTwoClients(uniqueDocId())
    const { docA, docB } = harness

    const source = {
      kind: 2,
      languageId: "scripture",
      value: "<p>hello</p>",
      metadata: { id: "cell-1", type: "text", edits: [] },
    }

    const cellsA = docA.getMap("cells")
    docA.transact(() => {
      const cell = new Y.Map()
      cell.set("__source", source)
      cell.set("__lastSyncedHistoryAt", 1_700_000_000_000)
      cellsA.set("cell-1", cell)
    })

    const cellsB = docB.getMap("cells")
    await waitForCondition(() => {
      const cell = cellsB.get("cell-1") as Y.Map<unknown> | undefined
      return !!cell && !!cell.get("__source")
    }, 3000, "__source propagation to doc B")

    const cellB = cellsB.get("cell-1") as Y.Map<unknown>
    expect(cellB.get("__source")).toEqual(source)
    expect(cellB.get("__lastSyncedHistoryAt")).toBe(1_700_000_000_000)
  })

  it("awareness states propagate between clients", async (ctx) => {
    if (skipIfNoServer(ctx)) return
    harness = await openTwoClients(uniqueDocId())
    const { providerA, providerB } = harness

    providerA.awareness.setLocalState({ username: "alice", color: "#3b82f6" })

    await waitForCondition(() => {
      for (const [clientId, state] of providerB.awareness.getStates()) {
        if (clientId === providerB.awareness.clientID) continue
        if (state && state.username === "alice") return true
      }
      return false
    }, 3000, "awareness propagation to provider B")

    let sawAlice = false
    for (const [clientId, state] of providerB.awareness.getStates()) {
      if (clientId === providerB.awareness.clientID) continue
      if (state?.username === "alice") sawAlice = true
    }
    expect(sawAlice).toBe(true)
  })
})
