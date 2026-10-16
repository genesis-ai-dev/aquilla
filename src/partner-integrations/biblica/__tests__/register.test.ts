/**
 * AQU-1286 — Biblica is actually wired into the partner registry.
 *
 * WHY this lives here and not with the registry: it asserts that THIS partner is
 * discovered, which is only true in a tree that carries this folder. The generic
 * registry test covers the seam itself (including the stripped case) and must pass
 * in the public copy, where this file does not exist. If the glob pattern or this
 * folder's name ever drifts, the Biblica importer disappears from the import dialog
 * with nothing else failing — this is the test that notices.
 */

import { describe, it, expect } from "vitest"
import { partnerIntegrations } from "@/lib/partners/registry"

describe("partner registry — this tree", () => {
  /**
   * Guards the wiring, not the partner: if `register.ts` stops being discovered
   * (a renamed folder, a moved glob pattern), the Biblica importer silently
   * vanishes from the dialog with nothing else failing.
   */
  it("discovers the Biblica integration with an import tile and an IDML normalizer", () => {
    const biblica = partnerIntegrations().find((integration) => integration.id === "biblica")
    expect(biblica).toBeDefined()
    expect(biblica?.importScreen?.titleKey).toBe("importExport.landing.biblica.title")
    expect(biblica?.idmlTargetHtmlNormalizers).toHaveLength(2)
    expect(biblica?.idmlExportOptions?.map((option) => option.id)).toEqual(["bible-swap"])
    expect(biblica?.idmlExportOptions?.[0]?.profileIds).toEqual([
      "builtin:biblica-study-notes",
      "builtin:biblica-treasure-hunt",
    ])
  })

  /** Without this hook the editor silently stops marking Biblica verse rows (AQU-1285). */
  it("marks Biblica scripture cells through the generic seam", async () => {
    const { isPartnerScriptureCell } = await import("@/lib/partners/registry")
    expect(isPartnerScriptureCell({ biblica: { contentType: "scripture" } })).toBe(true)
    expect(isPartnerScriptureCell({ biblica: { contentType: "notes" } })).toBe(false)
  })
})
