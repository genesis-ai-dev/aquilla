/**
 * apiRev 2 bridge surfaces (additive): paged/targeted reads, unvalidate,
 * presence, comments, audio, host shortcuts — param validation in the host
 * handlers, round trips through the SHIPPED runtime, the host-shortcut
 * allowlist, and the scope each new method is gated by.
 */

import { describe, it, expect, vi } from "vitest"
import { BridgeError, createBridgeHost } from "../host-bridge"
import { MAX_GET_CELLS, MAX_PAGE_LIMIT, createToolHandlers, type ToolHostData } from "../host-handlers"
import { HOST_SHORTCUTS, dispatchHostKey, isHostShortcut } from "../host-keys"
import { METHOD_SCOPES, decideScope } from "../permissions"
import { defaultSmokeFixtures } from "../smoke"
import { buildToolSrcdoc } from "../srcdoc"
import { TOOLS_API_REV, TOOL_SCOPES } from "../../../../shared/tools/manifest"
import { API_REV_ADDITIONS, isToolStale } from "../../../../shared/tools/api-rev"
import { createFakeFramePair } from "./fake-frame"

function stub(): ToolHostData {
  const data = defaultSmokeFixtures({ name: "x", description: "", scopes: [...TOOL_SCOPES], mounts: ["page"], apiRev: TOOLS_API_REV })[1].data
  return data
}

interface Aq {
  apiRev: number
  cells: {
    page: (f: string, o?: unknown) => Promise<{ cells: { cellId: string }[]; nextCursor: string | null }>
    get: (f: string, ids: string[]) => Promise<{ cellId: string }[]>
    unvalidate: (items: unknown) => Promise<{ validated: string[] }>
    commit: (edits: unknown) => Promise<unknown>
  }
  presence: { claim: (f: string, c: string) => Promise<boolean>; list: (f: string) => Promise<unknown> }
  comments: { counts: (f: string) => Promise<unknown>; open: (f: string, c: string) => Promise<boolean> }
  audio: { list: (f: string) => Promise<unknown>; play: (f: string, c: string) => Promise<boolean> }
  ui: { hostKey: (k: unknown) => Promise<boolean> }
  on: (type: string, cb: (e: Record<string, unknown>) => void) => () => void
  context: { file: { revealCellId?: string | null } | null }
}

function boot(handlers: ReturnType<typeof createToolHandlers>, extraBoot: Record<string, unknown> = {}) {
  const pair = createFakeFramePair()
  const host = createBridgeHost({
    getFrameWindow: () => pair.frame as unknown as Window,
    handlers,
    authorize: async () => {},
  })
  const stop = host.listen(pair.host as unknown as Window)
  pair.run(
    buildToolSrcdoc("<script></script>", {
      tool: { id: "t", name: "T", version: 1 },
      project: { id: "p", name: "P" },
      user: { username: "u", roleLevel: 400 },
      mount: "editor",
      file: { fileId: "f1", name: "MAT", revealCellId: "c2" },
      theme: {},
      hostShortcuts: HOST_SHORTCUTS,
      ...extraBoot,
    }),
  )
  return { pair, host, stop, aquilla: pair.frame.aquilla as Aq }
}

describe("apiRev 2 surfaces", () => {
  it("is an additive revision: rev 1 and 2 extensions are not stale, the runtime reports the current rev", () => {
    expect(TOOLS_API_REV).toBe(3)
    expect(isToolStale(1)).toBe(false)
    expect(isToolStale(2)).toBe(false)
    expect(API_REV_ADDITIONS[2].length).toBeGreaterThan(0)
    const { aquilla, stop } = boot(createToolHandlers(stub()))
    expect(aquilla.apiRev).toBe(3)
    expect(aquilla.context.file?.revealCellId).toBe("c2")
    stop()
  })

  it("pages a file and re-reads specific cells through the runtime", async () => {
    const { aquilla, stop } = boot(createToolHandlers(stub()))
    const first = await aquilla.cells.page("f1", { limit: 3 })
    expect(first.cells.map((c) => c.cellId)).toEqual(["c1", "c2", "c3"])
    expect(first.nextCursor).toBe("3")
    const rest = await aquilla.cells.page("f1", { cursor: first.nextCursor, limit: 3 })
    expect(rest.cells.map((c) => c.cellId)).toEqual(["c4"])
    expect(rest.nextCursor).toBeNull()
    await expect(aquilla.cells.get("f1", ["c2"])).resolves.toEqual([expect.objectContaining({ cellId: "c2" })])
    stop()
  })

  it("validates params: page limit clamped, get capped, commit html typed", async () => {
    const data = stub()
    const pageCells = vi.spyOn(data, "pageCells")
    const h = createToolHandlers(data)
    await h["cells.page"]({ fileId: "f1", limit: 999_999 })
    expect(pageCells).toHaveBeenLastCalledWith("f1", "", null, MAX_PAGE_LIMIT)
    await h["cells.page"]({ fileId: "f1", limit: -5 })
    expect(pageCells).toHaveBeenLastCalledWith("f1", "", null, 1)
    await expect(h["cells.get"]({ fileId: "f1", cellIds: Array.from({ length: MAX_GET_CELLS + 1 }, (_, i) => `c${i}`) })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["cells.get"]({ fileId: "f1", cellIds: "c1" })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["cells.commit"]({ edits: [{ fileId: "f1", cellId: "c1", value: "v", html: 42 }] })).rejects.toMatchObject({ code: "invalid_params" })
    const commit = vi.spyOn(data, "commit")
    await h["cells.commit"]({ edits: [{ fileId: "f1", cellId: "c1", value: "v", html: "<p><b>v</b></p>" }] })
    expect(commit).toHaveBeenLastCalledWith([{ fileId: "f1", cellId: "c1", value: "v", html: "<p><b>v</b></p>" }])
    await expect(h["presence.claim"]({ fileId: "f1" })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(h["ui.hostKey"]({ key: "x".repeat(50) })).rejects.toMatchObject({ code: "invalid_params" })
  })

  it("round-trips unvalidate, presence, comments and audio through the shipped runtime", async () => {
    const data = stub()
    const claim = vi.spyOn(data, "claimCell")
    const open = vi.spyOn(data, "openComments")
    const play = vi.spyOn(data, "playAudio")
    const { aquilla, stop } = boot(createToolHandlers(data))
    await expect(aquilla.cells.unvalidate([{ fileId: "f1", cellId: "c1" }])).resolves.toEqual({ validated: ["c1"], failed: [] })
    await expect(aquilla.presence.claim("f1", "c2")).resolves.toBe(true)
    expect(claim).toHaveBeenCalledWith("f1", "c2")
    await expect(aquilla.presence.list("f1")).resolves.toEqual({ c3: { username: "someone" } })
    await expect(aquilla.comments.counts("f1")).resolves.toEqual({ c2: 1 })
    await expect(aquilla.comments.open("f1", "c2")).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith("f1", "c2")
    await expect(aquilla.audio.list("f1")).resolves.toEqual({ c1: { hasAudio: true, durationMs: 1200 } })
    await expect(aquilla.audio.play("f1", "c1")).resolves.toBe(true)
    expect(play).toHaveBeenCalledWith("f1", "c1")
    stop()
  })

  it("pushes presence, comments and reveal events to listeners", async () => {
    const { aquilla, host, stop } = boot(createToolHandlers(stub()))
    const got: Record<string, unknown>[] = []
    aquilla.on("presence.changed", (e) => got.push(e))
    aquilla.on("editor.reveal", (e) => got.push(e))
    host.push({ type: "presence.changed", fileId: "f1", holders: { c1: { username: "bob" } } })
    host.push({ type: "editor.reveal", fileId: "f1", cellId: "c3" })
    await vi.waitFor(() => expect(got).toHaveLength(2))
    expect(got[0]).toMatchObject({ holders: { c1: { username: "bob" } } })
    expect(got[1]).toMatchObject({ cellId: "c3" })
    stop()
  })

  it("the runtime forwards only the host's own shortcuts", async () => {
    const data = stub()
    const hostKey = vi.spyOn(data, "hostKey")
    const { pair, stop } = boot(createToolHandlers(data))
    const press = (init: Record<string, unknown>) => {
      const ev = new Event("keydown", { cancelable: true })
      Object.assign(ev, init)
      pair.frame.dispatchEvent(ev)
      return ev
    }
    const forwarded = press({ key: "k", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })
    press({ key: "b", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false })
    press({ key: "k", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })
    await vi.waitFor(() => expect(hostKey).toHaveBeenCalledTimes(1))
    expect(hostKey).toHaveBeenCalledWith({ key: "k", mod: true, shift: false, alt: false })
    expect(forwarded.defaultPrevented).toBe(true)
    stop()
  })

  it("the host replays allowlisted chords on its document and refuses the rest", () => {
    expect(isHostShortcut({ key: "E", mod: true, shift: true, alt: false })).toBe(true)
    expect(isHostShortcut({ key: "c", mod: true, shift: false, alt: false })).toBe(false)
    const seen: KeyboardEvent[] = []
    const onKey = (e: Event) => seen.push(e as KeyboardEvent)
    document.addEventListener("keydown", onKey)
    expect(dispatchHostKey({ key: "k", mod: true, shift: false, alt: false })).toBe(true)
    expect(dispatchHostKey({ key: "w", mod: true, shift: false, alt: false })).toBe(false)
    document.removeEventListener("keydown", onKey)
    expect(seen).toHaveLength(1)
    expect(seen[0].key).toBe("k")
    expect(seen[0].ctrlKey || seen[0].metaKey).toBe(true)
  })

  it("gates every new method by the right scope (and comments by the new read:comments)", () => {
    expect(METHOD_SCOPES["cells.page"]).toBe("read:cells")
    expect(METHOD_SCOPES["cells.get"]).toBe("read:cells")
    expect(METHOD_SCOPES["cells.unvalidate"]).toBe("write:validation")
    expect(METHOD_SCOPES["presence.claim"]).toBe("write:target")
    expect(METHOD_SCOPES["comments.counts"]).toBe("read:comments")
    expect(METHOD_SCOPES["comments.open"]).toBe("read:comments")
    expect(METHOD_SCOPES["ui.hostKey"]).toBeUndefined()
    // A viewer may read comments but not claim a cell for editing.
    const viewer = { standing: new Set<never>(), deniedThisSession: new Set<never>(), roleLevel: 100 }
    expect(decideScope("read:comments", viewer).kind).toBe("prompt")
    expect(decideScope("write:target", viewer)).toEqual({ kind: "deny", reason: "role" })
  })

  it("a denied new method never reaches its handler", async () => {
    const data = stub()
    const unvalidate = vi.spyOn(data, "unvalidate")
    const pair = createFakeFramePair()
    const host = createBridgeHost({
      getFrameWindow: () => pair.frame as unknown as Window,
      handlers: createToolHandlers(data),
      authorize: async (m) => {
        if (METHOD_SCOPES[m] === "write:validation") throw new BridgeError("permission_denied", "no")
      },
    })
    const stop = host.listen(pair.host as unknown as Window)
    pair.run(buildToolSrcdoc("<script></script>", { tool: { id: "t", name: "T", version: 1 }, project: { id: "p", name: "P" }, user: { username: "u", roleLevel: 400 }, mount: "page", theme: {} }))
    const aquilla = pair.frame.aquilla as Aq
    await expect(aquilla.cells.unvalidate([{ fileId: "f1", cellId: "c1" }])).rejects.toMatchObject({ code: "permission_denied" })
    expect(unvalidate).not.toHaveBeenCalled()
    stop()
  })
})
