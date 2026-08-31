/**
 * The browser mapping loader replaces codex's `fs` reads with Vite URL assets,
 * so the contract worth pinning is that the glob still resolves every shipped
 * mapping, that the strategy usability gate is honoured, and that a study file
 * name coming off a real import still resolves to its volume.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clearBibleSwapMappingCache,
  hasMappingAssets,
  loadBibleSwapMappingPlan,
} from "./mapping-loader"
import {
  BIBLE_SWAP_LANGUAGES,
  getBibleSwapLanguageStrategy,
  type BibleSwapMappingDocument,
} from "./language-mappings"

const MAPPING_URLS = import.meta.glob<string>("./language-mappings/*/*.mapping.json", {
  query: "?url",
  import: "default",
  eager: true,
})

/** Serve the real mapping JSON off disk, standing in for the asset server. */
function stubFetchFromDisk() {
  vi.stubGlobal("fetch", async (input: string) => {
    const { readFile } = await import("node:fs/promises")
    const { fileURLToPath } = await import("node:url")
    // `?url` yields a served path; map it back to the source file. Resolve in
    // URL space because this repo's node polyfills break `path` on Windows.
    const relative = String(input).replace(/^.*\/language-mappings\//, "")
    const file = fileURLToPath(
      import.meta.url.replace(/\/[^/]*$/, `/language-mappings/${relative.split("?")[0]}`),
    )
    return new Response(await readFile(file, "utf-8"), { status: 200 })
  })
}

describe("bible swap mapping assets", () => {
  it("registers a URL for every volume each mapped language advertises", () => {
    const missing: string[] = []
    for (const language of BIBLE_SWAP_LANGUAGES.filter((l) => l.hasMappings)) {
      for (const volume of getBibleSwapLanguageStrategy(language.id).availableVolumes) {
        const key = `./language-mappings/${language.id}/${volume}.mapping.json`
        if (!MAPPING_URLS[key]) missing.push(`${language.id}/${volume}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("reports asset coverage per language", () => {
    for (const language of BIBLE_SWAP_LANGUAGES.filter((l) => l.hasMappings)) {
      expect(hasMappingAssets(language.id), language.id).toBe(true)
    }
    expect(hasMappingAssets("any")).toBe(false)
  })
})

describe("loadBibleSwapMappingPlan", () => {
  beforeEach(() => {
    clearBibleSwapMappingCache()
    vi.unstubAllGlobals()
  })

  it("returns null for the analyze-at-export language", async () => {
    expect(await loadBibleSwapMappingPlan("any", "JOS-EST.idml")).toBeNull()
    expect(await loadBibleSwapMappingPlan(undefined, "JOS-EST.idml")).toBeNull()
  })

  it("loads a real shipped plan and resolves the volume from the file name", async () => {
    stubFetchFromDisk()

    const loaded = await loadBibleSwapMappingPlan("portuguese", "JOS-EST.idml")

    expect(loaded).not.toBeNull()
    expect(loaded?.volume).toBe("JOS-EST")
    expect(loaded?.language).toBe("portuguese")
    expect(loaded?.plan.verseMappings.some((m) => m.action === "replace")).toBe(true)
  })

  it("resolves the volume through importer and dedup suffixes", async () => {
    stubFetchFromDisk()

    const tagged = await loadBibleSwapMappingPlan("portuguese", "JOS-EST-biblica.idml")

    expect(tagged?.volume).toBe("JOS-EST")
  })

  it("falls back to analyze-at-export when the asset 404s", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }))

    expect(await loadBibleSwapMappingPlan("portuguese", "JOS-EST.idml")).toBeNull()
  })

  it("rejects a plan whose projected match is below the language floor", async () => {
    const strategy = getBibleSwapLanguageStrategy("portuguese")
    const doc: BibleSwapMappingDocument = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      language: "portuguese",
      languageLabel: "Portuguese",
      studyVolume: "JOS-EST",
      files: {
        study: { name: "JOS-EST.idml", path: "" },
        bible: { name: "06JOS-17EST_portuguese.idml", path: "" },
      },
      versificationSummary: {
        projectedVerseMatchPercent: strategy.minUsableProjectedMatchPercent - 1,
      },
      plan: {
        verseMappings: [
          {
            study: { book: "JOS", chapter: "1", verse: "1", key: "JOS|1|1" },
            action: "replace",
            bible: { book: "JOS", chapter: "1", verse: "1" },
          },
        ],
        chapterRemaps: [],
        chapterInserts: [],
        structureChapters: [],
        trailingInserts: [],
        stats: {
          versesMapped: 1,
          versesRemoved: 0,
          versesInserted: 0,
          psalmChapterSlots: 0,
          psalmChapterShifts: 0,
        },
      },
    }
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(doc), { status: 200 }))

    expect(await loadBibleSwapMappingPlan("portuguese", "JOS-EST.idml")).toBeNull()
  })

  it("fetches each language/volume pair only once", async () => {
    stubFetchFromDisk()
    const spy = vi.spyOn(globalThis, "fetch")

    await loadBibleSwapMappingPlan("portuguese", "JOS-EST.idml")
    await loadBibleSwapMappingPlan("portuguese", "JOS-EST.idml")

    expect(spy).toHaveBeenCalledTimes(1)
  })
})
