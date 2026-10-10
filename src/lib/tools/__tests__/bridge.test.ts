/**
 * The bridge end to end, in process: the SHIPPED in-frame runtime
 * (runtime-source.ts) talking to the host (host-bridge.ts) through
 * postMessage, including the trust checks on both sides.
 */

import { describe, it, expect, vi } from "vitest"
import { BridgeError, createBridgeHost, type BridgeHandler } from "../host-bridge"
import { buildToolSrcdoc } from "../srcdoc"
import { createFakeFramePair, type FakeFramePair } from "./fake-frame"

interface AquillaLike {
  files: { list: () => Promise<unknown> }
  cells: { commit: (edits: unknown) => Promise<unknown> }
  context: { project: { name: string } }
  on: (type: string, cb: (e: { type: string; fileId?: string }) => void) => () => void
}

function boot(pair: FakeFramePair, toolScript = "") {
  pair.run(
    buildToolSrcdoc(`<div id="x"></div><script>${toolScript}</script>`, {
      tool: { id: "t1", name: "T", version: 1 },
      project: { id: "p1", name: "Proj </script> & co" },
      user: { username: "alice", roleLevel: 400 },
      mount: "page",
      theme: { "--primary": "red" },
    }),
  )
  return pair.frame.aquilla as AquillaLike
}

function setup(handlers: Record<string, BridgeHandler>, authorize: (m: string) => Promise<void> = async () => {}) {
  const pair = createFakeFramePair()
  const onReady = vi.fn()
  const onToolError = vi.fn()
  const host = createBridgeHost({
    getFrameWindow: () => pair.frame as unknown as Window,
    handlers,
    authorize,
    onReady,
    onToolError,
  })
  const stop = host.listen(pair.host as unknown as Window)
  return { pair, host, stop, onReady, onToolError }
}

describe("tool bridge", () => {
  it("round-trips a call and exposes boot context (escaped safely)", async () => {
    const { pair, onReady } = setup({ "files.list": async () => [{ fileId: "f1", name: "MAT", cellCount: 3 }] })
    const aquilla = boot(pair)
    expect(aquilla.context.project.name).toBe("Proj </script> & co")
    await expect(aquilla.files.list()).resolves.toEqual([{ fileId: "f1", name: "MAT", cellCount: 3 }])
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled())
    expect(pair.doc.documentElement.style.getPropertyValue("--primary")).toBe("red")
  })

  it("rejects a denied call with code permission_denied and never runs the handler", async () => {
    const commit = vi.fn(async () => ({ committed: [] }))
    const { pair } = setup({ "cells.commit": commit }, async () => {
      throw new BridgeError("permission_denied", "write:target was not allowed")
    })
    const aquilla = boot(pair)
    await expect(aquilla.cells.commit([])).rejects.toMatchObject({ code: "permission_denied" })
    expect(commit).not.toHaveBeenCalled()
  })

  it("rejects unknown methods", async () => {
    const { pair } = setup({})
    const aquilla = boot(pair)
    await expect(aquilla.files.list()).rejects.toMatchObject({ code: "unknown_method" })
  })

  it("ignores calls from a foreign source or a non-opaque origin", async () => {
    const handler = vi.fn(async () => [])
    const { pair } = setup({ "files.list": handler })
    boot(pair)
    const call = { channel: "aquilla-tool", type: "call", requestId: "r1", method: "files.list", params: null }
    pair.host.deliverFrom({ not: "the frame" }, call)
    pair.host.deliverFrom(pair.frame, call, "https://evil.example")
    await new Promise((r) => setTimeout(r, 20))
    expect(handler).not.toHaveBeenCalled()
  })

  it("runtime ignores host messages that do not come from its parent", async () => {
    const { pair } = setup({ "files.list": () => new Promise(() => {}) })
    const aquilla = boot(pair)
    const got = vi.fn()
    aquilla.on("cells.changed", got)
    pair.frame.deliverFrom({ fake: "parent" }, { channel: "aquilla-host", type: "event", event: { type: "cells.changed" } })
    await new Promise((r) => setTimeout(r, 10))
    expect(got).not.toHaveBeenCalled()
  })

  it("pushes live events to aquilla.on listeners", async () => {
    const { pair, host } = setup({})
    const aquilla = boot(pair)
    const got = vi.fn()
    aquilla.on("cells.changed", got)
    host.push({ type: "cells.changed", fileId: "f1", cellIds: ["c1"] })
    await vi.waitFor(() => expect(got).toHaveBeenCalledWith({ type: "cells.changed", fileId: "f1", cellIds: ["c1"] }))
  })

  it("reports a tool's uncaught error to the host", async () => {
    const { pair, onToolError } = setup({})
    boot(pair, `throw new Error("boom from tool")`)
    await vi.waitFor(() => expect(onToolError).toHaveBeenCalledWith(expect.objectContaining({ message: "boom from tool" })))
  })

  it("stops listening after dispose", async () => {
    const handler = vi.fn(async () => [])
    const { pair, stop } = setup({ "files.list": handler })
    boot(pair)
    stop()
    pair.host.deliverFrom(pair.frame, { channel: "aquilla-tool", type: "call", requestId: "r9", method: "files.list", params: null })
    await new Promise((r) => setTimeout(r, 10))
    expect(handler).not.toHaveBeenCalled()
  })
})
