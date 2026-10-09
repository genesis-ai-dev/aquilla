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
  const row = (cellId: string) => q(`.cell[data-cell-id="${cellId}"]`)
  const tgt = (cellId: string) => row(cellId)?.querySelector("[data-target-read-view]") as HTMLElement
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

  it("renders the built-in's row anatomy: rich text, key terms, issues, signals, comments, audio, locks, peers and chapters", async () => {
    const { row, tgt, q, stop } = mount(populated())
    await vi.waitFor(() => expect(row("c4")).not.toBeNull())
    expect(tgt("c1").innerHTML).toContain("<b>genealogía</b>")
    expect(row("c1")?.querySelector("[data-editor-cell-surface=source]")?.textContent).toContain("The book of the genealogy")
    // Key term from terms.matches, issue blot + stale badge + repetition from cells.signals.
    await vi.waitFor(() => expect(row("c1")?.querySelector(".term[data-concept-id='t1']")?.textContent).toBe("Jesus"))
    await vi.waitFor(() => expect(row("c2")?.querySelector("[data-testid=stale-source-indicator]")).not.toBeNull())
    expect(row("c2")?.querySelector(".blot.minor[data-rule-id='r1']")).not.toBeNull()
    expect(row("c1")?.querySelector("[data-testid=source-repetition-count]")).not.toBeNull()
    // AI drafting in progress on the empty c3: streaming preview overlay.
    expect(row("c3")?.querySelector(".ai-overlay")?.textContent).toContain("Jesús nació")
    await vi.waitFor(() => expect(row("c2")?.querySelector("[data-comments='1']")).not.toBeNull())
    await vi.waitFor(() => expect(tgt("c3").getAttribute("data-target-locked-by")).toBe("someone"))
    expect(tgt("c3").getAttribute("aria-readonly")).toBe("true")
    await vi.waitFor(() => expect(row("c3")?.querySelector("[data-cell-presence]")).not.toBeNull())
    await vi.waitFor(() => expect(q("#nav-slot nav")?.textContent).toContain("Matthew 1"))
    expect(q("[data-testid=lane-switcher]")?.textContent).toContain("Español")
    expect(q("#nav-slot")?.textContent).toContain("Suggested passages")
    stop()
  })

  it("edits like TranslatedEditor: activates on click, commits plain + html on blur, validates and removes its validation", async () => {
    const data = populated()
    const commit = vi.spyOn(data, "commit")
    const validate = vi.spyOn(data, "validate")
    const unvalidate = vi.spyOn(data, "unvalidate")
    const settle = vi.spyOn(data, "settle")
    const { row, tgt, pair, stop } = mount(data)
    await vi.waitFor(() => expect(row("c2")).not.toBeNull())
    const box = tgt("c2")
    box.click()
    await vi.waitFor(() => expect(box.getAttribute("contenteditable")).toBe("true"))
    box.innerHTML = "Abraham <i>engendró</i> a Isaac"
    box.dispatchEvent(new Event("input"))
    box.blur()
    await vi.waitFor(() => expect(commit).toHaveBeenCalled())
    expect(commit.mock.calls[0][0]).toEqual([{ fileId: "f1", cellId: "c2", value: "Abraham engendró a Isaac", html: "<p>Abraham <i>engendró</i> a Isaac</p>" }])
    await vi.waitFor(() => expect(settle).toHaveBeenCalledWith("f1", "c2"))
    const val = () => row("c2")!.querySelector("[data-testid=validation-gutter] button") as HTMLButtonElement
    await vi.waitFor(() => expect(val().getAttribute("aria-pressed")).toBe("false"))
    val().click()
    await vi.waitFor(() => expect(validate).toHaveBeenCalledWith([{ fileId: "f1", cellId: "c2" }]))
    await vi.waitFor(() => expect(val().getAttribute("aria-pressed")).toBe("true"))
    // Like the built-in: a second click opens the validators list, whose trash removes yours.
    val().click()
    const remove = await vi.waitFor(() => {
      const b = pair.doc.querySelector("[aria-label='Remove your validation']") as HTMLButtonElement | null
      expect(b).not.toBeNull()
      return b!
    })
    remove.click()
    await vi.waitFor(() => expect(unvalidate).toHaveBeenCalledWith([{ fileId: "f1", cellId: "c2" }]))
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

    // Unsaved typing in c1: the remote change offers "Discard and reload" instead.
    tgt("c1").click()
    await vi.waitFor(() => expect(tgt("c1").getAttribute("contenteditable")).toBe("true"))
    tgt("c1").textContent = "mi borrador"
    tgt("c1").dispatchEvent(new Event("input"))
    getCells.mockResolvedValueOnce([{ cellId: "c1", ref: "MAT 1:1", source: "x", target: "versión remota", validated: false, chapter: "MAT 1" }])
    host.push({ type: "cells.changed", fileId: "f1", cellIds: ["c1"] })
    await vi.waitFor(() => expect(row("c1")?.querySelector(".remote-bar")).not.toBeNull())
    expect(tgt("c1").textContent).toBe("mi borrador")
    stop()
  })

  it("follows live presence and reveal events", async () => {
    const { row, tgt, host, stop } = mount(populated())
    await vi.waitFor(() => expect(row("c2")).not.toBeNull())
    host.push({ type: "presence.changed", fileId: "f1", holders: { c2: { username: "bob" } } })
    await vi.waitFor(() => expect(tgt("c2").getAttribute("aria-readonly")).toBe("true"))
    expect(row("c2")?.textContent).toContain("bob is editing")
    host.push({ type: "presence.changed", fileId: "f1", holders: {} })
    await vi.waitFor(() => expect(tgt("c2").getAttribute("aria-readonly")).toBe("false"))
    host.push({ type: "editor.reveal", fileId: "f1", cellId: "c1" })
    await vi.waitFor(() => expect(row("c1")?.querySelector(".row")?.classList.contains("flash")).toBe(true))
    stop()
  })

  it("drafts with the host's AI (confirming before replacing text), selects for the host's bulk bar, and adds a footnote", async () => {
    const data = populated()
    const draft = vi.spyOn(data, "draft")
    const setSelection = vi.spyOn(data, "setSelection")
    const commit = vi.spyOn(data, "commit")
    const { row, pair, stop } = mount(data)
    await vi.waitFor(() => expect(row("c2")).not.toBeNull())
    ;(row("c2")!.querySelector("[aria-label='Translate with AI']") as HTMLButtonElement).click()
    const replace = await vi.waitFor(() => {
      const b = [...pair.doc.querySelectorAll(".dialog button")].find((x) => x.textContent === "Replace") as HTMLButtonElement | undefined
      expect(b).toBeDefined()
      return b!
    })
    replace.click()
    await vi.waitFor(() => expect(draft).toHaveBeenCalledWith("f1", ["c2"], { regenerate: false }))

    const sel = row("c1")!.querySelector("[role=checkbox]") as HTMLElement
    sel.dispatchEvent(new MouseEvent("pointerdown", { button: 0, bubbles: true }))
    pair.doc.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }))
    await vi.waitFor(() => expect(setSelection).toHaveBeenCalledWith("f1", ["c1"]))

    ;(row("c2")!.querySelector("[data-slot=cell-action-rail-overflow]") as HTMLButtonElement).click()
    ;(pair.doc.querySelector(".overflow [aria-label='Add footnote']") as HTMLButtonElement).click()
    const ta = pair.doc.querySelector(".dialog textarea") as HTMLTextAreaElement
    ta.value = "Hebreo: engendró"
    ;([...pair.doc.querySelectorAll(".dialog button")].find((x) => x.textContent === "Add footnote") as HTMLButtonElement).click()
    await vi.waitFor(() => expect(commit).toHaveBeenCalled())
    expect(commit.mock.calls.at(-1)![0][0].value).toMatch(/\\f \+ \\fr 1:2 \\ft Hebreo: engendró\\f\*$/)
    stop()
  })
})
