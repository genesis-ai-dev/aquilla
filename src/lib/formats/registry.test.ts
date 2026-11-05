// Registry invariants for the shared format contract (AQU-2384).
//
// These are the claims the rest of the system is allowed to rely on: one
// filter per extension, an implementation behind every declared format, a
// skeleton that refuses the wrong filter, and a partner seam that survives
// its folders being deleted.

import { describe, expect, it } from "vitest"
import { TEXT_PARSE_FILE_TYPES } from "@/lib/parsers/parse-text-formats"
import type { PartnerIntegration } from "@/lib/partners/types"
import type { CellData } from "@/hooks/useCells"
import {
  FormatSkeletonMismatchError,
  assertSkeletonMatches,
  skeletonBytes,
  skeletonText,
  type FormatFilter,
} from "./contract"
import {
  FORMAT_DESCRIPTORS,
  descriptorForExtension,
  descriptorForFileName,
  extensionIndexFrom,
  extensionOfFileName,
  normalizeExtension,
  universallyParseableFormatIds,
} from "./descriptors"
import {
  boundFormatIds,
  filterForExtension,
  filterForFileName,
  partnerFiltersFrom,
  partnerFormatExtensionsFrom,
  registeredFormatIds,
} from "./registry"

describe("the format table", () => {
  it("declares the seven formats AQU-2384 wraps first", () => {
    expect([...registeredFormatIds()].sort()).toEqual(
      ["docx", "html", "idml", "pptx", "srt", "vtt", "xliff"],
    )
  })

  it("has an implementation behind every declared format, and no orphans", () => {
    // A descriptor with no loader is a format the UI offers and then cannot
    // open; a loader with no descriptor is unreachable code.
    expect(boundFormatIds()).toEqual([...registeredFormatIds()].sort())
  })

  it("refuses two formats claiming one extension", () => {
    expect(() =>
      extensionIndexFrom([
        ...FORMAT_DESCRIPTORS,
        { ...FORMAT_DESCRIPTORS[0], id: "impostor", extensions: ["docx"] },
      ]),
    ).toThrow(/claimed by both/)
  })

  it("resolves an extension however it is spelled", () => {
    for (const spelling of ["docx", ".docx", "DOCX", " .Docx "]) {
      expect(descriptorForExtension(spelling)?.id, spelling).toBe("docx")
    }
    expect(descriptorForFileName("Chapter 3 (final).DOCX")?.id).toBe("docx")
    expect(extensionOfFileName("no-extension")).toBe("")
    expect(descriptorForExtension("usfm")).toBeUndefined()
  })

  it("gives every format a canonical extension first", () => {
    for (const descriptor of FORMAT_DESCRIPTORS) {
      expect(descriptor.extensions.length).toBeGreaterThan(0)
      expect(descriptor.extensions[0]).toBe(normalizeExtension(descriptor.extensions[0]))
    }
  })
})

describe("the registry's runtime declarations", () => {
  // `runtime.parse` is the single declaration of which formats a Worker may
  // parse. If it drifts from the parse core's own routing set, one of the two
  // is wrong and an import either throws "DOMParser is not defined" in a
  // Worker or is needlessly refused there.
  it("agrees with the worker-safe text parse core about srt and vtt", () => {
    for (const id of ["srt", "vtt"]) {
      expect(TEXT_PARSE_FILE_TYPES.has(id), `${id} should be in the text parse core`).toBe(true)
      expect(descriptorForExtension(id)?.runtime.parse, id).toBe("universal")
    }
  })

  it("marks every format the text parse core cannot handle as DOM-bound or binary", () => {
    for (const descriptor of FORMAT_DESCRIPTORS) {
      if (TEXT_PARSE_FILE_TYPES.has(descriptor.id)) continue
      // Not in the text core ⇒ either it needs the DOM, or it is a binary
      // container the core routes around (docx, parsed by xml-lite).
      const binaryUniversal = descriptor.id === "docx" && descriptor.runtime.parse === "universal"
      expect(
        descriptor.runtime.parse === "dom" || binaryUniversal,
        `${descriptor.id} is in neither the text core nor the DOM/binary set`,
      ).toBe(true)
    }
  })

  it("names docx as the one binary format a server can parse", () => {
    // The asymmetry is real and load-bearing: AQU-1237 moved the DOCX *walk*
    // off DOMParser, which is why the Agent API can parse a .docx server-side,
    // while its *build* still needs the DOM to read a translation's inline HTML.
    expect([...universallyParseableFormatIds()].sort()).toEqual(["docx", "srt", "vtt"])
    expect(descriptorForExtension("docx")?.runtime).toEqual({ parse: "universal", build: "dom" })
    expect(descriptorForExtension("xliff")?.runtime).toEqual({ parse: "dom", build: "universal" })
  })
})

describe("skeleton identity", () => {
  const filter = { id: "docx", walkVersion: 1 }

  it("accepts its own skeleton", () => {
    expect(() =>
      assertSkeletonMatches(filter, { formatId: "docx", walkVersion: 1, source: { kind: "text", text: "" } }),
    ).not.toThrow()
  })

  it("refuses another format's skeleton", () => {
    expect(() =>
      assertSkeletonMatches(filter, { formatId: "pptx", walkVersion: 1, source: { kind: "text", text: "" } }),
    ).toThrow(FormatSkeletonMismatchError)
  })

  it("refuses an older walk of its own format", () => {
    // Building against a walk that addressed blocks differently writes
    // translations into the wrong blocks — a silent corruption, so it must be
    // an error rather than a best effort.
    expect(() =>
      assertSkeletonMatches(filter, { formatId: "docx", walkVersion: 0, source: { kind: "text", text: "" } }),
    ).toThrow(/walk 0/)
  })

  it("reads its artifact as either bytes or text", () => {
    const encoded = new TextEncoder().encode("héllo")
    const asBytes = { formatId: "x", walkVersion: 1, source: { kind: "bytes" as const, bytes: encoded.buffer as ArrayBuffer } }
    const asText = { formatId: "x", walkVersion: 1, source: { kind: "text" as const, text: "héllo" } }
    expect(skeletonText(asBytes)).toBe("héllo")
    expect(skeletonText(asText)).toBe("héllo")
    expect(new Uint8Array(skeletonBytes(asText))).toEqual(encoded)
    expect(new Uint8Array(skeletonBytes(asBytes))).toEqual(encoded)
  })
})

describe("the partner seam (AQU-1286)", () => {
  const partnerFilter = {} as FormatFilter<CellData>
  const integration = (over: Partial<PartnerIntegration>): PartnerIntegration => ({ id: "p", ...over })

  it("offers nothing once the partner folders are deleted", () => {
    // This is the public-copy case, and no real glob can be made to match
    // nothing — which is why the derivation takes its input.
    expect(partnerFormatExtensionsFrom([])).toEqual([])
    expect(partnerFiltersFrom([]).size).toBe(0)
  })

  it("registers a partner's own format through the partner registry only", () => {
    const partner = integration({
      formatFilters: [
        {
          descriptor: {
            id: "acme-notes",
            extensions: [".ACME"],
            walkVersion: 1,
            runtime: { parse: "dom", build: "dom" },
            fidelity: "payload",
          },
          load: () => Promise.resolve(partnerFilter),
        },
      ],
    })
    expect(partnerFormatExtensionsFrom([partner])).toEqual(["acme"])
  })

  it("never lets a partner shadow a generic format's extension", () => {
    // A publisher's walk silently taking over .docx would change what every
    // project in the app imports.
    const squatter = integration({
      formatFilters: [
        {
          descriptor: {
            id: "acme-docx",
            extensions: ["docx"],
            walkVersion: 1,
            runtime: { parse: "dom", build: "dom" },
            fidelity: "payload",
          },
          load: () => Promise.resolve(partnerFilter),
        },
      ],
    })
    expect(partnerFormatExtensionsFrom([squatter])).toEqual([])
  })
})

describe("loading a filter", () => {
  it("loads each registered format by extension and by file name", async () => {
    for (const descriptor of FORMAT_DESCRIPTORS) {
      const extension = descriptor.extensions[0]
      const byExtension = await filterForExtension(extension)
      expect(byExtension?.id, extension).toBe(descriptor.id)
      const byName = await filterForFileName(`fixture.${extension}`)
      expect(byName?.id, extension).toBe(descriptor.id)
      // The descriptor the registry hands back IS the table's entry.
      expect(byExtension?.walkVersion).toBe(descriptor.walkVersion)
      expect(byExtension?.fidelity).toBe(descriptor.fidelity)
      expect(byExtension?.runtime).toEqual(descriptor.runtime)
    }
  })

  it("returns undefined for a format not yet on the contract", async () => {
    // usfm/md/csv are still imported by their own parsers through import.ts —
    // a miss here means "not wrapped yet", never "unsupported".
    expect(await filterForExtension("usfm")).toBeUndefined()
    expect(await filterForFileName("notes.txt")).toBeUndefined()
  })
})
