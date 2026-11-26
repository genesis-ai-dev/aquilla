/**
 * Smart Extensions apiRev 8 — native editor integration contract & round-trip
 * tests through the SHIPPED runtime (`runtime-source.ts`), SDK 1.2 (`window.aq`),
 * bridge handlers, `NativeEditorStore`, `validateManifest`, and `editorGridStyle`.
 */

import { describe, expect, it, vi } from "vitest"
import { TOOLS_API_REV, TOOL_SCOPES, toolCodeHash, validateManifest } from "../../../../shared/tools/manifest"
import { applySpanFix, parseAnnotateInput } from "../../../../shared/tools/native-editor"
import { editorGridStyle } from "@/lib/editor/editor-grid"
import { createBridgeHost } from "../host-bridge"
import { createToolHandlers, type ToolHostData } from "../host-handlers"
import { NativeEditorStore } from "../native-editor-store"
import { defaultSmokeFixtures } from "../smoke"
import { buildToolSrcdoc } from "../srcdoc"
import { createFakeFramePair } from "./fake-frame"

describe("apiRev 8 manifest validation", () => {
  it("accepts cell/selection action places and manifest.columns on apiRev 8", async () => {
    const res = validateManifest({
      name: "Word Alignment Helper",
      description: "Shows notes and word checks in the real editor",
      scopes: ["read:cells"],
      mounts: ["page", "panel"],
      apiRev: TOOLS_API_REV,
      sdk: 1,
      actions: [
        { id: "check-verse", label: "Check verse", where: ["cell", "bar"] },
        { id: "lookup-word", label: "Look up in lexicon", where: ["selection"] },
      ],
      columns: [
        { id: "gloss", label: "Interlinear", placement: "before" },
        { id: "notes", label: "Notes", placement: "after" },
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.manifest?.actions?.[0].where).toEqual(["cell", "bar"])
    expect(res.manifest?.actions?.[1].where).toEqual(["selection"])
    expect(res.manifest?.columns).toHaveLength(2)

    // Changing manifest.columns changes the version code hash.
    const h1 = await toolCodeHash("<p>a</p>", res.manifest!)
    const h2 = await toolCodeHash("<p>a</p>", { ...res.manifest!, columns: [{ id: "gloss", label: "Glosses" }] })
    expect(h1).not.toBe(h2)
  })

  it("rejects manifest.columns on apiRev < 8 and invalid placements", () => {
    const oldRev = validateManifest({
      name: "Old",
      description: "",
      scopes: ["read:cells"],
      mounts: ["page"],
      apiRev: 7,
      columns: [{ id: "notes", label: "Notes" }],
    })
    expect(oldRev.ok).toBe(false)
    expect(oldRev.errors.join("\n")).toContain("apiRev 8")

    const badPlacement = validateManifest({
      name: "Bad",
      description: "",
      scopes: ["read:cells"],
      mounts: ["page"],
      apiRev: 8,
      columns: [{ id: "notes", label: "Notes", placement: "middle" }],
    })
    expect(badPlacement.ok).toBe(false)
    expect(badPlacement.errors.join("\n")).toContain("placement")
  })
})

describe("parseAnnotateInput and applySpanFix", () => {
  it("validates badges, spans, fixes, and columns cleanly", () => {
    const ok = parseAnnotateInput({
      fileId: "f1",
      layer: "checker",
      cells: {
        c1: {
          badges: [{ label: "2 notes", tone: "info", tooltip: "Notes available", openPanel: true }],
          spans: [{ side: "target", start: 0, end: 5, tone: "warn", message: "Check spelling", fix: { label: "Use Libro", replacement: "Libro" } }],
          columns: { gloss: { text: "biblos geneseos", badge: "GNT", tone: "neutral" } },
        },
      },
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    const span = ok.value.cells.c1.spans![0]
    expect(applySpanFix("Lirbo de la genealogía", span)).toBe("Libro de la genealogía")
  })

  it("rejects inverted span bounds", () => {
    const bad = parseAnnotateInput({
      fileId: "f1",
      cells: { c1: { spans: [{ side: "target", start: 5, end: 5, message: "bad" }] } },
    })
    expect(bad.ok).toBe(false)
  })
})

describe("apiRev 8 runtime + SDK 1.2 + NativeEditorStore round trip", () => {
  it("syncs active cell, reveals cells, annotates/clears native store, and opens panel", async () => {
    const store = new NativeEditorStore()
    const revealSpy = vi.fn(() => true)
    const openPanelSpy = vi.fn(() => true)
    store.registerReveal(revealSpy)
    store.setActiveCell({ fileId: "f1", cellId: "c1", ref: "MAT 1:1", source: "In the beginning", target: "En el principio" })

    const base = defaultSmokeFixtures({
      name: "Companion",
      description: "",
      scopes: [...TOOL_SCOPES],
      mounts: ["page", "panel"],
      apiRev: 8,
      sdk: 1,
    })[1].data

    const data: ToolHostData = {
      ...base,
      getActiveCell: async () => store.getActiveCell(),
      revealInEditor: async (fileId, cellId, focus) => store.reveal(fileId, cellId, focus),
      annotateEditor: async (input) => ({ cells: store.annotate("tool-1", "Companion", input) }),
      clearEditorAnnotations: async (fileId, layer) => store.clearAnnotations("tool-1", fileId, layer),
      openOwnPanel: async () => openPanelSpy(),
    }

    const pair = createFakeFramePair()
    const host = createBridgeHost({
      getFrameWindow: () => pair.frame as unknown as Window,
      handlers: createToolHandlers(data),
      authorize: async () => {},
    })
    const stop = host.listen(pair.host as unknown as Window)

    const source = `<!doctype html><html><body><div id="out"></div><script>
      (async () => {
        const active = aq.useActiveCell();
        const seen = [];
        active.subscribe((v) => { if (v) seen.push(v.cellId); document.getElementById("out").textContent = seen.join(","); });
        const init = await active.ready;
        window.__RESULT__ = { init, seen };
        await aq.editor.annotate("f1", {
          layer: "notes",
          cells: {
            c1: {
              badges: [{ label: "3 notes", tone: "info", openPanel: true }],
              spans: [{ side: "source", start: 0, end: 2, message: "Key preposition" }],
              columns: { notes: { text: "See TN on MAT 1:1" } }
            }
          }
        });
        await aq.editor.reveal("f1", "c2", { focus: true });
        await aq.ui.openPanel();
      })();
    </script></body></html>`

    pair.run(
      buildToolSrcdoc(
        source,
        {
          tool: { id: "tool-1", name: "Companion", version: 1, scopes: ["read:cells"] },
          project: { id: "p1", name: "Proj" },
          user: { username: "alice", roleLevel: 400 },
          mount: "panel",
          file: { fileId: "f1", name: "MAT" },
          theme: {},
        },
        { sdk: 1 },
      ),
    )

    await vi.waitFor(() => expect(revealSpy).toHaveBeenCalledWith("f1", "c2", true))
    expect(openPanelSpy).toHaveBeenCalledTimes(1)

    const ann = store.getCellAnnotations("f1", "c1")
    expect(ann.badges).toHaveLength(1)
    expect(ann.badges[0]).toMatchObject({ label: "3 notes", toolId: "tool-1", toolName: "Companion", openPanel: true })
    expect(ann.spans).toHaveLength(1)
    expect(store.getColumnCell("f1", "tool-1", "notes", "c1")).toEqual({ text: "See TN on MAT 1:1" })
    expect(store.hasPopulatedColumn("tool-1", "notes")).toBe(true)

    // Live active-cell push updates aq.useActiveCell() inside the panel.
    host.push({ type: "editor.activeCell", fileId: "f1", cellId: "c2", ref: "MAT 1:2", source: "Abraham", target: "Abrahán" })
    await vi.waitFor(() => expect(pair.doc.getElementById("out")?.textContent).toContain("c2"))

    // Clearing annotations empties the store for that layer.
    const aq = pair.frame.aq as { editor: { clearAnnotations: (opts?: unknown) => Promise<boolean> } }
    await aq.editor.clearAnnotations({ fileId: "f1", layer: "notes" })
    expect(store.getCellAnnotations("f1", "c1").badges).toEqual([])
    expect(store.getColumnCell("f1", "tool-1", "notes", "c1")).toBeNull()
    stop()
  })

  it("offsets --editor-rail-end cleanly for multiple trailing columns", () => {
    const one = editorGridStyle(false, 1, 1) as Record<string, string>
    expect(one["--editor-rail-end"]).toBe("calc((100% - 32px) / 3 + 24px)")
    const two = editorGridStyle(false, 2, 2) as Record<string, string>
    expect(two["--editor-rail-end"]).toBe("calc(2 * ((100% - 40px) / 4) + 32px)")
  })
})
