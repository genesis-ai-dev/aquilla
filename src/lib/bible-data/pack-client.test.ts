// AQU-1686 — the Bible Knowledge Pack client.
//
// What these tests protect:
//   • cached results are keyed by pack version, so a new pack version is
//     refetched and never answered with the old version's data (the spec's
//     "Source data is read-only and versioned" invariant);
//   • only the layers that enabled enrichments need are fetched, and nothing
//     at all while Bible data is off ("When it is off, no enrichment layer
//     loads");
//   • offline, missing and malformed files come back as typed failures, never
//     a throw into the UI, and a cached pack keeps working offline.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_BKP_BASE,
  __bkpMemoryBooks,
  __resetBkpMemoryCache,
  loadEnabledLayers,
  loadLayer,
  loadManifest,
} from "./pack-client"
import { __clearPackStore, __packRecordKeys } from "./pack-store"
import type { BkpManifest } from "./pack-types"
import type { FileReference } from "@/lib/parsers/types"

const SCRIPTURE: Pick<FileReference, "type">[] = [{ type: "usfm" }]
const ALL_BOOK_LAYERS = ["text", "structure", "voices", "people", "notes", "terms"]

function manifest(version: string, books: Record<string, string[]> = { JHN: ALL_BOOK_LAYERS }): BkpManifest {
  return {
    pack: "bkp",
    version,
    builtAt: "2026-10-05T00:00:00Z",
    versification: "org",
    sources: [{ id: "macula-greek", repo: "Clear-Bible/macula-greek", commit: "8423afe" }],
    layers: {},
    books: Object.fromEntries(
      Object.entries(books).map(([book, layers]) => [book, { layers, bytes: {} }]),
    ),
  }
}

/** A minimal, valid file for each layer; `tag` marks which version served it. */
function layerFile(layer: string, book: string, tag: string): Record<string, unknown> {
  const shapes: Record<string, Record<string, unknown>> = {
    text: { verses: { [`${book} 4:7`]: ["n43004007001"] }, words: {} },
    structure: { segments: [], moves: [], verses: {} },
    voices: { narrator: { kind: "narrator" }, speeches: [], verses: {} },
    people: { entities: {}, mentions: {} },
    notes: { notes: [], questions: [] },
    terms: { words: {}, terms: {} },
  }
  return { book, tag, ...shapes[layer] }
}

interface Server {
  manifest: BkpManifest | null
  /** Overrides for single paths: a status code or a raw body. */
  overrides: Map<string, number | string>
  offline: boolean
}

let server: Server
const fetchMock = vi.fn(async (input: string): Promise<Response> => {
  if (server.offline) throw new TypeError("Failed to fetch")
  const url = new URL(input)
  const path = url.pathname
  const override = server.overrides.get(path)
  if (typeof override === "number") return new Response("nope", { status: override })
  if (typeof override === "string") return new Response(override, { status: 200 })
  if (path.endsWith("/manifest.json")) {
    return server.manifest
      ? Response.json(server.manifest)
      : new Response("missing", { status: 404 })
  }
  const match = path.match(/\/bkp\/v1\/([a-z]+)\/([1-3A-Z]{3})\.json$/)
  if (!match) return new Response("missing", { status: 404 })
  return Response.json(layerFile(match[1], match[2], url.searchParams.get("v") ?? "unversioned"))
})

const fetchedPaths = () => fetchMock.mock.calls.map(([input]) => new URL(input).pathname)
const layerFetches = () => fetchedPaths().filter((path) => !path.endsWith("/manifest.json"))

beforeEach(async () => {
  server = { manifest: manifest("1.0.0"), overrides: new Map(), offline: false }
  fetchMock.mockClear()
  vi.stubGlobal("fetch", fetchMock)
  __resetBkpMemoryCache()
  await __clearPackStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("version-keyed caching", () => {
  it("fetches a layer once per session, then answers from memory", async () => {
    const first = await loadLayer("voices", "JHN")
    const second = await loadLayer("voices", "JHN")
    expect(first.ok && second.ok).toBe(true)
    expect(layerFetches()).toEqual(["/bkp/v1/voices/JHN.json"])
    // The manifest is read once per session too.
    expect(fetchedPaths().filter((path) => path.endsWith("/manifest.json"))).toHaveLength(1)
  })

  it("answers from IndexedDB after a reload while the pack version is unchanged", async () => {
    await loadLayer("voices", "JHN")
    __resetBkpMemoryCache()
    fetchMock.mockClear()

    const again = await loadLayer("voices", "JHN")
    expect(again.ok).toBe(true)
    // The manifest is revalidated; the layer file is not refetched.
    expect(layerFetches()).toEqual([])
  })

  it("refetches every layer for a new pack version and never serves the old data", async () => {
    const v1 = await loadLayer("voices", "JHN")
    expect(v1.ok && (v1.value as { tag?: string }).tag).toBe("1.0.0")

    server.manifest = manifest("2.0.0")
    __resetBkpMemoryCache()
    fetchMock.mockClear()

    const v2 = await loadLayer("voices", "JHN")
    expect(v2.ok && (v2.value as { tag?: string }).tag).toBe("2.0.0")
    // `?v=` keeps an HTTP cache from answering for the new version.
    const [layerCall] = fetchMock.mock.calls.filter(([input]) => input.includes("/voices/"))
    expect(new URL(layerCall[0]).searchParams.get("v")).toBe("2.0.0")
    // The old version's file is gone from IndexedDB.
    expect(await __packRecordKeys()).not.toContain("1.0.0/voices/JHN")
    expect(await __packRecordKeys()).toContain("2.0.0/voices/JHN")
  })
})

// AQU-1700: an OT book's layers are up to about 12 MB raw, several times that
// once parsed. A session that reads book after book must hold only the open
// one; IndexedDB answers when an earlier book is opened again.
describe("memory", () => {
  it("holds only the open book's layers, and reopens an earlier book from IndexedDB", async () => {
    server.manifest = manifest("1.0.0", { JHN: ALL_BOOK_LAYERS, RUT: ALL_BOOK_LAYERS })
    await loadLayer("text", "JHN")
    await loadLayer("people", "JHN")
    expect(__bkpMemoryBooks()).toEqual(["JHN"])

    await loadLayer("text", "RUT")
    expect(__bkpMemoryBooks()).toEqual(["RUT"])

    fetchMock.mockClear()
    expect((await loadLayer("text", "JHN")).ok).toBe(true)
    expect(layerFetches()).toEqual([])
    expect(__bkpMemoryBooks()).toEqual(["JHN"])
  })
})

describe("loadEnabledLayers", () => {
  it("loads only the layers of the enabled enrichments", async () => {
    const onlyVoices = Object.fromEntries(
      ["whos-who", "structure", "original-context", "helps", "terms", "places", "checks", "autopilot"].map(
        (id) => [id, false],
      ),
    )
    const loaded = await loadEnabledLayers(
      { files: SCRIPTURE, bibleEnrichments: { ...onlyVoices, voices: true } },
      "JHN",
    )
    // Voices needs the voices and people layers, and nothing else.
    expect(Object.keys(loaded).sort()).toEqual(["people", "voices"])
    expect(layerFetches().sort()).toEqual(["/bkp/v1/people/JHN.json", "/bkp/v1/voices/JHN.json"])
  })

  it("loads every default layer for a scripture project that chose nothing", async () => {
    const loaded = await loadEnabledLayers({ files: SCRIPTURE }, "JHN")
    expect(Object.keys(loaded).sort()).toEqual(["notes", "people", "structure", "terms", "text", "voices"])
    expect(Object.values(loaded).every((result) => result?.ok)).toBe(true)
  })

  it("fetches nothing, not even the manifest, while Bible data is off", async () => {
    expect(await loadEnabledLayers({ files: SCRIPTURE, bibleResourcesEnabled: false }, "JHN")).toEqual({})
    // Unset on a project without scripture files is off too.
    expect(await loadEnabledLayers({ files: [{ type: "docx" }] }, "JHN")).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("typed failures", () => {
  it("reports offline, without throwing, when nothing is cached", async () => {
    server.offline = true
    expect(await loadManifest()).toEqual({ ok: false, reason: "offline" })
    expect(await loadLayer("voices", "JHN")).toEqual({ ok: false, reason: "offline" })
    const loaded = await loadEnabledLayers({ files: SCRIPTURE }, "JHN")
    expect(loaded.voices).toEqual({ ok: false, reason: "offline" })
  })

  it("keeps a cached pack working offline", async () => {
    await loadLayer("structure", "JHN")
    __resetBkpMemoryCache()
    server.offline = true

    const structure = await loadLayer("structure", "JHN")
    expect(structure.ok).toBe(true)
    // A layer that was never cached is still a typed failure.
    expect(await loadLayer("voices", "JHN")).toEqual({ ok: false, reason: "offline" })
  })

  it("does not remember a failure: the next call retries", async () => {
    server.offline = true
    expect((await loadLayer("voices", "JHN")).ok).toBe(false)
    server.offline = false
    expect((await loadLayer("voices", "JHN")).ok).toBe(true)
  })

  it("reports not-found, without a fetch, for a book or layer the manifest lacks", async () => {
    server.manifest = manifest("1.0.0", { JHN: ["text"] })
    expect(await loadLayer("voices", "JHN")).toEqual({ ok: false, reason: "not-found" })
    expect(await loadLayer("text", "GEN")).toEqual({ ok: false, reason: "not-found" })
    // An inherited property of the books map is not a book either.
    expect(await loadLayer("text", "toString")).toEqual({ ok: false, reason: "not-found" })
    expect(layerFetches()).toEqual([])
  })

  it("reports not-found for a 404 and offline for a server error", async () => {
    server.overrides.set("/bkp/v1/voices/JHN.json", 404)
    server.overrides.set("/bkp/v1/people/JHN.json", 503)
    expect(await loadLayer("voices", "JHN")).toEqual({ ok: false, reason: "not-found" })
    expect(await loadLayer("people", "JHN")).toEqual({ ok: false, reason: "offline" })
  })

  it("reports invalid for an HTML page, another book's file, or a broken manifest", async () => {
    server.overrides.set("/bkp/v1/voices/JHN.json", "<!doctype html><html></html>")
    server.overrides.set("/bkp/v1/people/JHN.json", JSON.stringify(layerFile("people", "MRK", "1.0.0")))
    expect(await loadLayer("voices", "JHN")).toEqual({ ok: false, reason: "invalid" })
    expect(await loadLayer("people", "JHN")).toEqual({ ok: false, reason: "invalid" })

    __resetBkpMemoryCache()
    server.overrides.set("/bkp/v1/manifest.json", JSON.stringify({ pack: "bkp", version: 3 }))
    expect(await loadManifest()).toEqual({ ok: false, reason: "invalid" })
  })
})

describe("where it fetches from", () => {
  it("reads the published pack by default", async () => {
    await loadManifest()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${DEFAULT_BKP_BASE}/manifest.json`)
  })

  it("goes through the same-origin resource proxy when one is configured", async () => {
    vi.stubEnv("VITE_RESOURCES_BASE", "https://resources.aquilla.app")
    await loadManifest()
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://resources.aquilla.app/bibletranslation.org/bkp/v1/manifest.json",
    )
  })

  it("uses VITE_BKP_BASE when it is set", async () => {
    vi.stubEnv("VITE_BKP_BASE", "http://127.0.0.1:4321/bkp/v1/")
    await loadManifest()
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4321/bkp/v1/manifest.json")
  })
})
