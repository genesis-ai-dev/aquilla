/**
 * The first-party default editor extension, run through the SHIPPED runtime in
 * the in-process fake frame against a stub bridge: it passes the same gates as
 * any extension (lint, manifest, smoke), and it edits, validates, applies a
 * remote edit without clobbering unsaved typing, and shows presence, comment
 * and audio state — all via aquilla.* only.
 */

import { describe, it, expect, vi } from "vitest"
import { lintToolSource } from "../../../../shared/tools/lint"
import { TOOL_SCOPES, validateManifest } from "../../../../shared/tools/manifest"
import { DEFAULT_EDITOR_MANIFEST, DEFAULT_EDITOR_SOURCE, firstPartyToolId } from "../../../../shared/tools/first-party/default-editor"
import { createBridgeHost } from "../host-bridge"
import { createToolHandlers, type ToolHostData } from "../host-handlers"
import { HOST_SHORTCUTS } from "../host-keys"
import { defaultSmokeFixtures, runToolSmoke } from "../smoke"
import { buildToolSrcdoc } from "../srcdoc"
import { createFakeFramePair, fakeSmokeFrame } from "./fake-frame"

function mount(data: ToolHostData) {
  const pair = createFakeFramePair()
  const host = createBridgeHost({ getFrameWindow: () => pair.frame as unknown as Window, handlers: createToolHandlers(data), authorize: async () => {} })
  const stop = host.listen(pair.host as unknown as Window)
  pair.run(
    buildToolSrcdoc(DEFAULT_EDITOR_SOURCE, {
      tool: { id: "fp", name: "Aquilla Editor", version: 1 },
      project: { id: "p", name: "P" },
      user: { username: "alice", roleLevel: 400 },
      mount: "editor",
      file: { fileId: "f1", name: "MAT" },
      theme: {},
      hostShortcuts: HOST_SHORTCUTS,
    }),
  )
  const q = (sel: string) => pair.doc.querySelector(sel) as HTMLElement | null
  const row = (cellId: string) => q(`.row[data-cell-id="${cellId}"]`)
  const tgt = (cellId: string) => row(cellId)?.querySelector(".tgt") as HTMLElement
  return { pair, host, stop, q, row, tgt }
}

function populated(): ToolHostData {
  return defaultSmokeFixtures({ ...DEFAULT_EDITOR_MANIFEST, scopes: [...TOOL_SCOPES] })[1].data
}

describe("first-party default editor", () => {
  it("passes the same lint, manifest and smoke gates as any extension", async () => {
    expect(lintToolSource(DEFAULT_EDITOR_SOURCE).issues).toEqual([])
    const m = validateManifest(DEFAULT_EDITOR_MANIFEST)
    expect(m.errors).toEqual([])
    expect(m.manifest?.mounts).toContain("editor")
    const res = await runToolSmoke(DEFAULT_EDITOR_SOURCE, DEFAULT_EDITOR_MANIFEST, { createFrame: () => fakeSmokeFrame() })
    expect(res.errors).toEqual([])
    expect(res.calls["cells.page"]).toBeGreaterThanOrEqual(1)
  }, 30_000)

  it("has a deterministic, UUID-shaped id per project", async () => {
    const a = await firstPartyToolId("p1", "default-editor")
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(await firstPartyToolId("p1", "default-editor")).toBe(a)
    expect(await firstPartyToolId("p2", "default-editor")).not.toBe(a)
  })

  it("renders source and target (rich text) with comment, audio and presence badges", async () => {
    const { row, tgt, q, stop } = mount(populated())
    await vi.waitFor(() => expect(row("c4")).not.toBeNull())
    expect(row("c1")?.querySelector(".ref")?.textContent).toBe("MAT 1:1")
    expect(tgt("c1").innerHTML).toContain("<b>genealogía</b>")
    expect(row("c4")?.classList.contains("heading")).toBe(true)
    await vi.waitFor(() => expect(row("c2")?.querySelector("[data-comments='1']")).not.toBeNull())
    await vi.waitFor(() => expect(row("c1")?.querySelector("[aria-label='Play audio for MAT 1:1']")).not.toBeNull())
    await vi.waitFor(() => expect(row("c3")?.querySelector("[data-lock='someone']")).not.toBeNull())
    expect(tgt("c3").getAttribute("contenteditable")).toBe("false")
    expect(q("#progress")?.textContent).toContain("validated")
    stop()
  })

  it("commits on blur (plain + html) and toggles validation", async () => {
    const data = populated()
    const commit = vi.spyOn(data, "commit")
    const validate = vi.spyOn(data, "validate")
    const unvalidate = vi.spyOn(data, "unvalidate")
    const { row, tgt, stop } = mount(data)
    await vi.waitFor(() => expect(row("c3")).not.toBeNull())
    const box = tgt("c3")
    box.innerHTML = "Jesús nació en <i>Belén</i>"
    box.dispatchEvent(new Event("input"))
    box.dispatchEvent(new Event("blur"))
    await vi.waitFor(() => expect(commit).toHaveBeenCalled())
    expect(commit.mock.calls[0][0]).toEqual([{ fileId: "f1", cellId: "c3", value: "Jesús nació en Belén", html: "<p>Jesús nació en <i>Belén</i></p>" }])
    const val = row("c3")!.querySelector(".val") as HTMLButtonElement
    await vi.waitFor(() => expect(val.disabled).toBe(false))
    val.click()
    await vi.waitFor(() => expect(validate).toHaveBeenCalledWith([{ fileId: "f1", cellId: "c3" }]))
    await vi.waitFor(() => expect(val.getAttribute("aria-pressed")).toBe("true"))
    val.click()
    await vi.waitFor(() => expect(unvalidate).toHaveBeenCalledWith([{ fileId: "f1", cellId: "c3" }]))
    stop()
  })

  it("applies a remote edit live, but never over unsaved typing", async () => {
    const data = populated()
    const getCells = vi.spyOn(data, "getCells")
    const { row, tgt, host, stop } = mount(data)
    await vi.waitFor(() => expect(row("c2")).not.toBeNull())
    getCells.mockResolvedValueOnce([{ cellId: "c2", ref: "MAT 1:2", source: "Abraham was the father of Isaac", target: "Abraham fue padre de Isaac", validated: false, chapter: "MAT 1" }])
    host.push({ type: "cells.changed", fileId: "f1", cellIds: ["c2"] })
    await vi.waitFor(() => expect(tgt("c2").textContent).toBe("Abraham fue padre de Isaac"))
    expect(getCells).toHaveBeenCalledWith("f1", ["c2"], "")

    // Unsaved typing in c1: a remote change offers "Use theirs" instead.
    tgt("c1").textContent = "mi borrador"
    tgt("c1").dispatchEvent(new Event("input"))
    getCells.mockResolvedValueOnce([{ cellId: "c1", ref: "MAT 1:1", source: "x", target: "versión remota", validated: false, chapter: "MAT 1" }])
    host.push({ type: "cells.changed", fileId: "f1", cellIds: ["c1"] })
    await vi.waitFor(() => expect(row("c1")?.querySelector(".remote")).not.toBeNull())
    expect(tgt("c1").textContent).toBe("mi borrador")
    stop()
  })

  it("follows live presence and reveal events", async () => {
    const { row, tgt, host, stop } = mount(populated())
    await vi.waitFor(() => expect(row("c2")).not.toBeNull())
    host.push({ type: "presence.changed", fileId: "f1", holders: { c2: { username: "bob" } } })
    await vi.waitFor(() => expect(tgt("c2").getAttribute("contenteditable")).toBe("false"))
    expect(row("c2")?.textContent).toContain("bob is editing")
    host.push({ type: "presence.changed", fileId: "f1", holders: {} })
    await vi.waitFor(() => expect(tgt("c2").getAttribute("contenteditable")).toBe("true"))
    host.push({ type: "editor.reveal", fileId: "f1", cellId: "c3" })
    await vi.waitFor(() => expect(row("c3")?.classList.contains("flash")).toBe(true))
    stop()
  })
})
