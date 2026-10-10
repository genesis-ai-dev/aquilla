/**
 * The extension SDK (window.aq, manifest sdk: 1), run through the SHIPPED
 * runtime + SDK in the in-process fake frame against a stub bridge: its
 * public surface is exactly AQ_SDK_EXPORTS and the builder prompt documents
 * all of it; a tiny side panel and a "verse cards" view built only from SDK
 * parts render, stay live, edit and validate through the bridge; optional
 * reads stay inside the declared scopes; and SDK tools pass the smoke gate.
 */

import { describe, it, expect, vi } from "vitest"
import { TOOLS_BUILDER_SYSTEM_PROMPT } from "../../../../auth-worker/src/lib/tools/build-prompt"
import { API_REV_ADDITIONS } from "../../../../shared/tools/api-rev"
import { TOOLS_API_REV, TOOL_SCOPES, toolCodeHash, validateManifest, type ToolManifest, type ToolScope } from "../../../../shared/tools/manifest"
import { AQ_SDK_EXPORTS, AQ_SDK_VERSION } from "../../../../shared/tools/sdk/sdk"
import { createBridgeHost } from "../host-bridge"
import { createToolHandlers, type ToolHostData } from "../host-handlers"
import { defaultSmokeFixtures, runToolSmoke } from "../smoke"
import { buildToolSrcdoc, type ToolBoot } from "../srcdoc"
import { createFakeFramePair, fakeSmokeFrame } from "./fake-frame"

const ALL: ToolManifest = { name: "x", description: "", scopes: [...TOOL_SCOPES], mounts: ["page", "panel"], apiRev: TOOLS_API_REV, sdk: 1 }

function data(scopes: readonly ToolScope[] = TOOL_SCOPES): ToolHostData {
  return defaultSmokeFixtures({ ...ALL, scopes: [...scopes] })[1].data
}

function run(source: string, d: ToolHostData, boot: Partial<ToolBoot> = {}) {
  const pair = createFakeFramePair()
  const host = createBridgeHost({ getFrameWindow: () => pair.frame as unknown as Window, handlers: createToolHandlers(d), authorize: async () => {} })
  const stop = host.listen(pair.host as unknown as Window)
  pair.run(buildToolSrcdoc(source, {
    tool: { id: "t", name: "T", version: 1 },
    project: { id: "p", name: "P" },
    user: { username: "alice", roleLevel: 400 },
    mount: "page",
    theme: {},
    ...boot,
  }, { sdk: 1 }))
  const q = (sel: string) => pair.doc.querySelector(sel) as HTMLElement | null
  return { pair, host, stop, q }
}

/** Walk window.aq into dotted names (namespaces one level deep). */
function surface(aq: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(aq)) {
    if (k === "debug") continue
    if (v && typeof v === "object" && !Array.isArray(v)) for (const sub of Object.keys(v)) out.push(`${k}.${sub}`)
    else out.push(k)
  }
  return out.sort()
}

describe("extension SDK (window.aq)", () => {
  it("exposes exactly AQ_SDK_EXPORTS, documented in the builder prompt (capability twins)", () => {
    const { pair, stop } = run("<script></script>", data())
    const aq = pair.frame.aq as Record<string, unknown>
    expect(aq.version).toBe(AQ_SDK_VERSION)
    expect(surface(aq)).toEqual([...AQ_SDK_EXPORTS].sort())
    for (const name of AQ_SDK_EXPORTS) expect(TOOLS_BUILDER_SYSTEM_PROMPT, name).toContain(`aq.${name}`)
    expect(TOOLS_BUILDER_SYSTEM_PROMPT).toContain(`"sdk": 1`)
    expect(API_REV_ADDITIONS[TOOLS_API_REV]?.join(" ")).toContain("window.aq")
    stop()
  })

  it("is injected only for sdk: 1, and the manifest field is validated and hash-neutral when absent", async () => {
    const boot: ToolBoot = { tool: { id: "t", name: "T", version: 1 }, project: { id: "p", name: "P" }, user: { username: "u", roleLevel: 1 }, mount: "page", theme: {} }
    expect(buildToolSrcdoc("x", boot)).not.toContain("window.aq")
    expect(buildToolSrcdoc("x", boot, { sdk: 1 })).toContain("window.aq")
    expect(validateManifest({ ...ALL }).manifest?.sdk).toBe(1)
    expect(validateManifest({ ...ALL, sdk: 2 }).errors.join()).toContain("manifest.sdk 2")
    expect(validateManifest({ ...ALL, apiRev: 3 }).errors.join()).toContain("apiRev 4")
    const plain: ToolManifest = { name: "n", description: "", scopes: ["read:cells"], mounts: ["page"], apiRev: 3 }
    expect(validateManifest(plain).manifest).not.toHaveProperty("sdk")
    expect(await toolCodeHash("s", plain)).not.toBe(await toolCodeHash("s", { ...plain, apiRev: 4, sdk: 1 }))
    // A pre-SDK manifest hashes exactly as before (sdk is left out of the canonical form).
    expect(await toolCodeHash("s", plain)).toBe(await toolCodeHash("s", { ...plain, sdk: undefined }))
  })

  it("a side panel from hooks + UI kit renders the file and follows a live edit", async () => {
    const d = data(["read:cells"])
    const getCells = vi.spyOn(d, "getCells")
    const counts = vi.spyOn(d, "commentCounts")
    const source = `<script>
      const cells = aq.useCells();
      const total = aq.ui.Stat({ label: "words", value: "…" });
      const list = aq.ui.Stack({ gap: 6 });
      aq.mount(aq.ui.Panel({ title: "Word count", children: [total, list] }));
      function render() {
        let sum = 0; list.textContent = "";
        cells.value.forEach((c) => { const n = aq.cell.words(c.target); sum += n; list.append(aq.ui.Stack({ row: true, children: [c.ref, aq.ui.Badge({ text: String(n) })] })); });
        total.set(sum);
      }
      cells.subscribe(render); render();
    </script>`
    const { q, host, stop } = run(source, d, { mount: "panel", tool: { id: "t", name: "T", version: 1, scopes: ["read:cells"] } })
    await vi.waitFor(() => expect(q(".k-panel-h h2")?.textContent).toBe("Word count"))
    await vi.waitFor(() => expect(q(".k-panel-b")?.textContent).toContain("MAT 1:2"))
    const before = Number(q(".k-stat-v")?.textContent)
    expect(before).toBeGreaterThan(0)
    getCells.mockResolvedValueOnce([{ cellId: "c3", ref: "MAT 2:1", source: "Now when Jesus was born", target: "uno dos tres cuatro cinco", validated: false, chapter: "MAT 2" }])
    host.push({ type: "cells.changed", fileId: "f1", cellIds: ["c3"] })
    await vi.waitFor(() => expect(Number(q(".k-stat-v")?.textContent)).toBe(before + 5))
    // Optional reads stay inside the declared scopes: no read:comments call.
    expect(counts).not.toHaveBeenCalled()
    stop()
  })

  it("a verse-card view from SDK components edits, autosaves and validates through the bridge", async () => {
    const d = data(["read:cells", "write:target", "write:validation"])
    const commit = vi.spyOn(d, "commit")
    const validate = vi.spyOn(d, "validate")
    const source = `<script>
      aq.mount(aq.ui.Page({ title: "Verse cards", children: [aq.CellList({ row: (id) => aq.h("div", {}, [
        aq.ui.Card({ title: aq.cell.ref(id), actions: [aq.ValidateButton(id)], children: [aq.SourceText(id), aq.TargetEditor(id)] }) ]) })] }));
    </script>`
    const { pair, q, stop } = run(source, d)
    const card = (id: string) => q(`[data-cell-id="${id}"] .k-card`)
    await vi.waitFor(() => expect(card("c2")).not.toBeNull())
    expect(pair.doc.body.classList.contains("aq-fill")).toBe(true)
    expect(card("c2")?.querySelector(".k-title")?.textContent).toBe("MAT 1:2")
    expect(card("c2")?.querySelector("[data-editor-cell-surface=source]")?.textContent).toContain("Abraham")
    const box = card("c2")!.querySelector("[data-target-read-view]") as HTMLElement
    box.click()
    await vi.waitFor(() => expect(box.getAttribute("contenteditable")).toBe("true"))
    box.textContent = "Abraham engendró a Isaac"
    box.dispatchEvent(new Event("input"))
    box.blur()
    await vi.waitFor(() => expect(commit).toHaveBeenCalled())
    expect(commit.mock.calls[0][0][0]).toMatchObject({ fileId: "f1", cellId: "c2", value: "Abraham engendró a Isaac" })
    const val = () => card("c2")!.querySelector("[data-testid=validation-gutter] button") as HTMLButtonElement
    await vi.waitFor(() => expect(val().getAttribute("aria-pressed")).toBe("false"))
    val().click()
    await vi.waitFor(() => expect(validate).toHaveBeenCalledWith([{ fileId: "f1", cellId: "c2" }]))
    stop()
  })

  it("SDK extensions pass the builder's smoke gate in every mount they declare", async () => {
    const source = `<script>
      const cells = aq.useCells();
      aq.mount(aq.ui.Page({ title: "Progress", children: [aq.CellList({ row: (id) => aq.h("div", {}, [aq.ui.Card({ title: aq.cell.ref(id), children: [aq.SourceText(id)] })]) })] }));
    </script>`
    const manifest: ToolManifest = { name: "Cards", description: "", scopes: ["read:cells"], mounts: ["page", "panel"], apiRev: TOOLS_API_REV, sdk: 1 }
    const res = await runToolSmoke(source, manifest, { createFrame: () => fakeSmokeFrame() })
    expect(res.errors).toEqual([])
    expect(res.calls["cells.page"]).toBeGreaterThanOrEqual(1)
  }, 30_000)
})
