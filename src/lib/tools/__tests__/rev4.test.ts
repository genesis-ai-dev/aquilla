/**
 * apiRev 4 — the last built-in editor surfaces, through the SHIPPED runtime,
 * SDK and first-party editor in the fake frame against a stub bridge: per-take
 * audio validation, the source cell menu, translation-memory examples,
 * autopilot drafts, the source selection toolbar and IDML slot editing. Plus
 * the handlers' param validation and scopes.
 */

import { describe, it, expect, vi } from "vitest"
import { DEFAULT_EDITOR_MANIFEST, DEFAULT_EDITOR_SOURCE } from "../../../../shared/tools/first-party/default-editor"
import { TOOL_SCOPES } from "../../../../shared/tools/manifest"
import { createBridgeHost } from "../host-bridge"
import { createToolHandlers, type ToolHostData } from "../host-handlers"
import { METHOD_SCOPES } from "../permissions"
import { defaultSmokeFixtures } from "../smoke"
import { buildToolSrcdoc } from "../srcdoc"
import { createFakeFramePair } from "./fake-frame"

function data(): ToolHostData {
  return defaultSmokeFixtures({ ...DEFAULT_EDITOR_MANIFEST, scopes: [...TOOL_SCOPES] })[1].data
}

function mount(d: ToolHostData) {
  const pair = createFakeFramePair()
  const host = createBridgeHost({ getFrameWindow: () => pair.frame as unknown as Window, handlers: createToolHandlers(d), authorize: async () => {} })
  const stop = host.listen(pair.host as unknown as Window)
  pair.run(buildToolSrcdoc(DEFAULT_EDITOR_SOURCE, {
    tool: { id: "fp", name: "Aquilla Editor", version: 1 },
    project: { id: "p", name: "P" },
    user: { username: "alice", roleLevel: 400 },
    mount: "editor",
    file: { fileId: "f1", name: "MAT" },
    theme: {},
  }, { sdk: 1 }))
  const q = (sel: string) => pair.doc.querySelector(sel) as HTMLElement | null
  const row = (cellId: string) => q(`.cell[data-cell-id="${cellId}"]`)
  return { pair, host, stop, q, row }
}

describe("apiRev 4 handlers", () => {
  it("validate params and gate writes behind the right scopes", async () => {
    const handlers = createToolHandlers(data())
    await expect(handlers["audio.trim"]({ fileId: "f1", cellId: "c1", audioId: "a", startMs: 500, endMs: 100 })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(handlers["source.insert"]({ fileId: "f1", cellId: "c1", side: "left" })).rejects.toMatchObject({ code: "invalid_params" })
    await expect(handlers["terms.add"]({ fileId: "f1", cellId: "c1", text: "  ", rect: {} })).rejects.toMatchObject({ code: "invalid_params" })
    expect(await handlers["terms.selection"]({ fileId: "f1", cellId: "c1", text: "Jesus" })).toMatchObject({ match: true })
    expect(METHOD_SCOPES["source.commit"]).toBe("write:source")
    expect(METHOD_SCOPES["source.remove"]).toBe("write:source")
    expect(METHOD_SCOPES["audio.validate"]).toBe("write:validation")
    expect(METHOD_SCOPES["audio.trim"]).toBe("write:audio")
    expect(METHOD_SCOPES["ai.reviewContextual"]).toBe("write:target")
    expect(DEFAULT_EDITOR_MANIFEST.scopes).toContain("write:source")
  })
})

describe("the default editor on apiRev 4", () => {
  it("draws the audio column and votes per take", async () => {
    const d = data()
    const validate = vi.spyOn(d, "validateAudio")
    const { row, q, stop } = mount(d)
    await vi.waitFor(() => expect(row("c1")?.querySelector("[data-testid=audio-validation-button]")).toBeTruthy())
    expect(row("c2")?.querySelector("[data-testid=audio-validation-unavailable]")).not.toBeNull()
    await vi.waitFor(() => expect(q("[data-testid=table-check-marks]")?.querySelectorAll("svg").length).toBe(2))
    ;(row("c1")!.querySelector("[data-testid=audio-validation-button]") as HTMLButtonElement).click()
    await vi.waitFor(() => expect(validate).toHaveBeenCalledWith("f1", "c1", "a1", true))
    stop()
  })

  it("offers the source cell menu and runs its items through source.*", async () => {
    const d = data()
    const setHidden = vi.spyOn(d, "setCellHidden")
    const insert = vi.spyOn(d, "insertCell")
    const commitSource = vi.spyOn(d, "commitSource")
    const { row, pair, stop } = mount(d)
    await vi.waitFor(() => expect(row("c2")).not.toBeNull())
    const src = row("c2")!.querySelector("[data-editor-cell-surface=source]") as HTMLElement
    src.dispatchEvent(new MouseEvent("mouseenter"))
    const btn = row("c2")!.querySelector("[data-testid='cell-menu-c2']") as HTMLButtonElement
    await vi.waitFor(() => expect(btn.hidden).toBe(false))
    btn.click()
    const item = (tid: string) => pair.doc.querySelector(`[data-testid=${tid}]`) as HTMLButtonElement | null
    await vi.waitFor(() => expect(item("cell-menu-insert-below")).not.toBeNull())
    item("cell-menu-insert-below")!.click()
    await vi.waitFor(() => expect(insert).toHaveBeenCalledWith("f1", "c2", "below"))
    btn.click()
    await vi.waitFor(() => expect(item("cell-menu-toggle-hidden")).not.toBeNull())
    item("cell-menu-toggle-hidden")!.click()
    await vi.waitFor(() => expect(setHidden).toHaveBeenCalledWith("f1", "c2", true))
    // Edit text: the source becomes editable in place; Enter saves through source.commit.
    btn.click()
    await vi.waitFor(() => expect(item("cell-menu-edit-source")).not.toBeNull())
    item("cell-menu-edit-source")!.click()
    const txt = src.querySelector(".txt") as HTMLElement
    await vi.waitFor(() => expect(txt.getAttribute("contenteditable")).toBe("true"))
    txt.textContent = "Abraham fathered Isaac"
    txt.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await vi.waitFor(() => expect(commitSource).toHaveBeenCalledWith("f1", "c2", "Abraham fathered Isaac", null))
    stop()
  })

  it("shows translation-memory examples (Insert on exact) and an autopilot draft to accept", async () => {
    const d = data()
    d.contextualDrafts = async () => ({ c3: { draftId: "d1", text: "Jesús nació en Belén", spanLabel: "MAT 2:1" } })
    const signals = d.signals
    d.signals = async (f) => ({ ...(await signals(f)), ai: {} })
    const review = vi.spyOn(d, "reviewContextual")
    const commit = vi.spyOn(d, "commit")
    const { row, pair, host, stop } = mount(d)
    await vi.waitFor(() => expect(row("c2")?.querySelector(".ex-trig")).toBeTruthy())
    host.push({ type: "presence.changed", fileId: "f1", holders: {} })
    ;(row("c2")!.querySelector(".ex-trig") as HTMLButtonElement).click()
    const ins = await vi.waitFor(() => {
      const b = pair.doc.querySelector("[data-testid=example-insert]") as HTMLButtonElement | null
      expect(b).not.toBeNull()
      return b!
    })
    expect(pair.doc.querySelector("[data-testid=example-match-badge]")?.textContent).toBeTruthy()
    ins.click()
    await vi.waitFor(() => expect(commit).toHaveBeenCalled())
    expect(commit.mock.calls.at(-1)![0][0]).toMatchObject({ cellId: "c2", value: "Abraham fue padre de Isaac" })
    await vi.waitFor(() => expect(row("c3")?.querySelector("[data-testid=contextual-draft-card]")).toBeTruthy())
    await vi.waitFor(() => expect(row("c3")?.querySelector(".ctx-acts button")).toBeTruthy())
    ;(row("c3")!.querySelector(".ctx-acts button") as HTMLButtonElement).click()
    await vi.waitFor(() => expect(review).toHaveBeenCalledWith("f1", "c3", "d1", true))
    stop()
  })

  it("routes the source selection toolbar's actions to the host (Ask AI, view and add term)", async () => {
    // (happy-dom keeps no text selection in a detached document; the toolbar
    // itself is covered end to end in e2e/specs/tools/default-editor-parity.)
    const d = data()
    const ask = vi.spyOn(d, "askAi")
    const add = vi.spyOn(d, "addTerm")
    const { row, pair, stop } = mount(d)
    await vi.waitFor(() => expect(row("c1")).toBeTruthy())
    const aq = pair.frame.aquilla as { agent: { ask: (...a: unknown[]) => Promise<unknown> }; terms: { add: (...a: unknown[]) => Promise<unknown>; selection: (...a: unknown[]) => Promise<unknown> } }
    expect(await aq.terms.selection("f1", "c1", "Jesus")).toMatchObject({ match: true, canAdd: true })
    await aq.agent.ask("f1", "c1", "genealogy")
    await aq.terms.add("f1", "c1", "genealogy", { left: 1, top: 2, width: 3, height: 4 })
    expect(ask).toHaveBeenCalledWith("f1", "c1", "genealogy")
    expect(add).toHaveBeenCalledWith("f1", "c1", "genealogy", { left: 1, top: 2, width: 3, height: 4 })
    stop()
  })

  it("edits an IDML cell only inside its editable slots and commits the slot markup", async () => {
    const d = data()
    const idmlHtml = '<p data-idml-version="2"><span data-idml-protected="slot" data-idml-slot="0" data-idml-character-style="CS">Abraham</span><span data-idml-protected="token" data-idml-token="0" data-idml-token-kind="tab" contenteditable="false"></span><span data-idml-protected="slot" data-idml-slot="1" data-idml-character-style="CS" contenteditable="false">LOCKED</span></p>'
    const page = d.pageCells
    d.pageCells = async (...a) => {
      const p = await page(...a)
      return { ...p, cells: p.cells.map((c) => (c.cellId === "c2" ? { ...c, idml: { html: idmlHtml, error: null } } : c)) }
    }
    const commit = vi.spyOn(d, "commit")
    const { row, pair, stop } = mount(d)
    await vi.waitFor(() => expect(row("c2")?.querySelector("[data-idml-slot='0']")).toBeTruthy())
    const box = row("c2")!.querySelector("[data-target-read-view]") as HTMLElement
    box.click()
    await vi.waitFor(() => expect(box.getAttribute("contenteditable")).toBe("true"))
    // Typing in a locked slot is refused.
    const locked = box.querySelector("[data-idml-slot='1']") as HTMLElement
    const sel = pair.doc.getSelection()!
    const r = pair.doc.createRange()
    r.setStart(locked.firstChild!, 2)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
    const refused = new Event("beforeinput", { cancelable: true }) as Event & { inputType?: string }
    Object.defineProperty(refused, "inputType", { value: "insertText" })
    box.dispatchEvent(refused)
    expect(refused.defaultPrevented).toBe(true)
    // Inside the editable slot it goes through; the commit keeps the anchors.
    const slot = box.querySelector("[data-idml-slot='0']") as HTMLElement
    slot.textContent = "Abrahamu"
    box.dispatchEvent(new Event("input"))
    box.blur()
    await vi.waitFor(() => expect(commit).toHaveBeenCalled())
    const edit = commit.mock.calls.at(-1)![0][0]
    expect(edit.html).toContain('data-idml-slot="0"')
    expect(edit.html).toContain("Abrahamu")
    expect(edit.html).toContain('data-idml-token="0"')
    stop()
  })
})
