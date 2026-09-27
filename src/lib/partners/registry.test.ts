/**
 * AQU-1286 — the partner-integration seam must survive its partners being gone.
 *
 * WHY: the open-source copy of this repo is produced by *deleting* the
 * `partner-integrations` folders (`scripts/make-public-copy.ts`). If any of these
 * assertions regress, that copy either fails to build or ships a dialog with a
 * tile that opens nothing — the two failure modes the carve-out exists to
 * prevent. `integrationsFrom({})` is the stripped tree as this module sees it; a
 * real `import.meta.glob` cannot be made to match nothing from inside a test.
 */

import { describe, it, expect, vi } from "vitest"
import type { IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import {
  integrationsFrom,
  normalizeIdmlTargetHtmlWith,
  partnerIntegrations,
} from "./registry"
import type { PartnerIntegration } from "./types"

const METADATA = {} as IdmlFormatMetadataV2

function fake(id: string, extra: Partial<PartnerIntegration> = {}): PartnerIntegration {
  return { id, ...extra }
}

describe("partner registry — stripped tree", () => {
  it("has no integrations when the partner folders are absent", () => {
    expect(integrationsFrom({})).toEqual([])
  })

  it("leaves IDML target html untouched when no partner is present", () => {
    expect(
      normalizeIdmlTargetHtmlWith([], { biblica: {} }, "<p>source</p>", "<p>target</p>", METADATA),
    ).toBe("<p>target</p>")
  })

  it("skips a register module that exports no default rather than throwing", () => {
    expect(integrationsFrom({ "/src/partner-integrations/broken/register.ts": {} })).toEqual([])
  })
})

describe("partner registry — discovery", () => {
  it("orders integrations by module path, not filesystem order", () => {
    const modules = {
      "/src/partner-integrations/zeta/register.ts": { default: fake("zeta") },
      "/src/partner-integrations/alpha/register.ts": { default: fake("alpha") },
    }
    expect(integrationsFrom(modules).map((i) => i.id)).toEqual(["alpha", "zeta"])
  })

  it("applies every present partner's normalizers in turn", () => {
    const first = vi.fn((_m: unknown, _s: string, html: string) => `${html}+first`)
    const second = vi.fn((_m: unknown, _s: string, html: string) => `${html}+second`)
    const integrations = [
      fake("a", { idmlTargetHtmlNormalizers: [first] }),
      fake("b", { idmlTargetHtmlNormalizers: [second] }),
    ]

    expect(normalizeIdmlTargetHtmlWith(integrations, null, "<p>s</p>", "t", METADATA))
      .toBe("t+first+second")
    expect(first).toHaveBeenCalledWith(null, "<p>s</p>", "t", METADATA)
  })
})

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
    expect(biblica?.idmlTargetHtmlNormalizers).toHaveLength(1)
  })
})
