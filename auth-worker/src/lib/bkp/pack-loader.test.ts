// AQU-1690: the server pack loader. Autopilot must keep working when the
// pack is unreachable, missing, or still an HTML page on the live site, and
// it must never read an old file for a new pack version.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetBkpServerMemory, bkpBase, compactTextLayer, impliedSubjectWords, loadBookPack, DEFAULT_BKP_BASE } from "./pack-loader"
import { JHN_A_STRUCTURE, JHN_A_TEXT, JHN_A_VOICES } from "../../../../db/shared/bible-checks/__fixtures__/pack-a"
import type { ServerBkpLayerData } from "./pack-types"
import { compileFileExpectations } from "../../../../db/shared/bible-checks/compile"
import { JHN4_STRUCTURE, JHN4_VOICES } from "../../../../db/shared/bible-checks/__fixtures__/pack"
import { JHN4_TEXT } from "../../../../db/shared/bible-facts/__fixtures__/jhn4-people"
import { computeCellFacts } from "../../../../db/shared/bible-facts/facts"

const BASE = "https://packs.test/bkp/v1"

function manifest(version = "1.0.0", layers = ["text", "structure", "voices", "people"]) {
  return {
    pack: "bkp",
    version,
    builtAt: "2026-10-06T00:00:00Z",
    versification: "org",
    sources: [],
    layers: {},
    books: { JHN: { layers, bytes: { voices: 10, structure: 10, people: 10, text: 10 } } },
  }
}

const LAYERS: Record<string, unknown> = {
  voices: { book: "JHN", narrator: { kind: "narrator" }, speeches: [], verses: {} },
  structure: { book: "JHN", segments: [], moves: [], verses: {} },
  people: { book: "JHN", entities: {}, mentions: {} },
  text: { book: "JHN", verses: {}, words: {} },
}

type Handler = (url: string) => Response | Promise<Response>

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

function serve(files: Record<string, () => Response>): { calls: string[]; handler: Handler } {
  const calls: string[] = []
  return {
    calls,
    handler: (url) => {
      calls.push(url)
      const path = url.slice(BASE.length)
      const file = files[path]
      return file ? file() : new Response("missing", { status: 404 })
    },
  }
}

function packFiles(over: Record<string, () => Response> = {}): Record<string, () => Response> {
  return {
    "/manifest.json": () => json(manifest()),
    "/voices/JHN.json": () => json(LAYERS.voices),
    "/structure/JHN.json": () => json(LAYERS.structure),
    "/people/JHN.json": () => json(LAYERS.people),
    "/text/JHN.json": () => json(LAYERS.text),
    ...over,
  }
}

function stubFetch(handler: Handler): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => handler(String(input))))
}

const env = { BKP_BASE: BASE }

beforeEach(() => __resetBkpServerMemory())
afterEach(() => vi.unstubAllGlobals())

describe("bkpBase", () => {
  it("defaults to the published pack and refuses a base that is not https", () => {
    expect(bkpBase({})).toBe(DEFAULT_BKP_BASE)
    expect(bkpBase({ BKP_BASE: "http://evil.example/bkp" })).toBeNull()
    expect(bkpBase({ BKP_BASE: "http://127.0.0.1:9998/bkp/v1/" })).toBe("http://127.0.0.1:9998/bkp/v1")
  })
})

describe("loadBookPack", () => {
  it("loads voices, structure and people, and leaves the text layer alone unless asked", async () => {
    const server = serve(packFiles())
    stubFetch(server.handler)
    const result = await loadBookPack(env, "JHN")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe("1.0.0")
    expect(result.value.text).toBeNull()
    expect(server.calls.some((url) => url.includes("/text/"))).toBe(false)
  })

  it("loads the text layer when asked", async () => {
    stubFetch(serve(packFiles()).handler)
    const result = await loadBookPack(env, "JHN", { text: true })
    expect(result.ok && result.value.text).toEqual(LAYERS.text)
  })

  // The live site serves its HTML app at unknown paths until the pack is deployed.
  it("treats an HTML page where JSON should be as invalid", async () => {
    stubFetch(
      serve(
        packFiles({
          "/manifest.json": () =>
            new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }),
        }),
      ).handler,
    )
    expect(await loadBookPack(env, "JHN")).toEqual({ ok: false, reason: "invalid" })
  })

  it("treats a JSON body that is not the layer for this book as invalid", async () => {
    stubFetch(serve(packFiles({ "/voices/JHN.json": () => json({ book: "MAT" }) })).handler)
    expect(await loadBookPack(env, "JHN")).toEqual({ ok: false, reason: "invalid" })
  })

  it("reports a 404 as not-found and a 503 or a network error as offline", async () => {
    stubFetch(serve(packFiles({ "/people/JHN.json": () => new Response("gone", { status: 404 }) })).handler)
    expect(await loadBookPack(env, "JHN")).toEqual({ ok: false, reason: "not-found" })

    __resetBkpServerMemory()
    stubFetch(serve(packFiles({ "/manifest.json": () => new Response("busy", { status: 503 }) })).handler)
    expect(await loadBookPack(env, "JHN")).toEqual({ ok: false, reason: "offline" })

    __resetBkpServerMemory()
    stubFetch(() => {
      throw new TypeError("network down")
    })
    expect(await loadBookPack(env, "JHN")).toEqual({ ok: false, reason: "offline" })
  })

  it("never fetches a book the manifest does not list, or a code that is not a book", async () => {
    const server = serve(packFiles())
    stubFetch(server.handler)
    expect(await loadBookPack(env, "GEN")).toEqual({ ok: false, reason: "not-found" })
    expect(await loadBookPack(env, "../x")).toEqual({ ok: false, reason: "not-found" })
    expect(server.calls.filter((url) => !url.endsWith("/manifest.json"))).toEqual([])
  })

  // AQU-1701: C1 asks the Translation Questions. The notes are most of the
  // layer's bytes and nothing on the server reads them, so only the questions
  // stay in memory — and only well-formed ones reach the check.
  it("loads only the notes layer's Translation Questions, and only when asked", async () => {
    const notes = {
      book: "JHN",
      notes: [{ id: "tn:1", ref: "JHN 4:7", words: [], text: "A long translation note." }],
      questions: [
        { id: "tq:172799", refs: ["JHN 4:7"], q: "Who came to Jacob’s well?", a: "A Samaritan woman came there to draw water." },
        { id: "tq:bad", refs: [], q: "No verses?", a: "Malformed." },
        { id: "tq:also-bad", refs: ["JHN 4:8"], q: "No answer?" },
      ],
    }
    const server = serve(
      packFiles({
        "/manifest.json": () => json(manifest("1.2.0", ["text", "structure", "voices", "people", "notes"])),
        "/notes/JHN.json": () => json(notes),
      }),
    )
    stubFetch(server.handler)
    const without = await loadBookPack(env, "JHN")
    expect(without.ok && without.value.questions).toBeNull()
    expect(server.calls.some((url) => url.includes("/notes/"))).toBe(false)

    const loaded = await loadBookPack(env, "JHN", { questions: true })
    expect(loaded.ok && loaded.value.questions).toEqual([notes.questions[0]])
  })

  it("leaves the questions out, and still loads the pack, when the notes layer fails", async () => {
    stubFetch(
      serve(
        packFiles({
          "/manifest.json": () => json(manifest("1.2.0", ["text", "structure", "voices", "people", "notes"])),
          "/notes/JHN.json": () => new Response("busy", { status: 503 }),
        }),
      ).handler,
    )
    const result = await loadBookPack(env, "JHN", { questions: true })
    expect(result.ok && result.value.questions).toBeNull()
  })

  it("keeps parsed layers per pack version: the next wave reads memory, a new version refetches", async () => {
    let version = "1.0.0"
    const server = serve(packFiles({ "/manifest.json": () => json(manifest(version)) }))
    stubFetch(server.handler)
    await loadBookPack(env, "JHN")
    const layerFetches = () => server.calls.filter((url) => url.includes("/voices/")).length
    await loadBookPack(env, "JHN")
    expect(layerFetches()).toBe(1)

    // Same isolate, six minutes later: the manifest is read again and names a
    // new version, so the remembered 1.0.0 layers must not answer for it.
    version = "1.1.0"
    vi.useFakeTimers({ now: Date.now() + 6 * 60 * 1000 })
    try {
      const next = await loadBookPack(env, "JHN")
      expect(next.ok && next.value.version).toBe("1.1.0")
      expect(layerFetches()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

// A parsed text layer is several times its ~4 MB of JSON; kept whole for a
// few books it could exhaust an isolate. Autopilot reads it for "you" and
// (AQU-1697) for the words the Bible data checks read.
describe("compactTextLayer", () => {
  it("keeps the second-person words and each verse's last word, and the facts read from it are unchanged", () => {
    const full = JHN4_TEXT as unknown as ServerBkpLayerData["text"]
    const compact = compactTextLayer(full)
    expect(Object.keys(compact.words).length).toBeLessThan(Object.keys(full.words).length / 4)
    // JHN 4:8 has no second-person word: only its last word stays, whose
    // punctuation says whether the sentence goes on (S3).
    expect(compact.verses["JHN 4:8"]).toEqual(["n43004008011"])
    const refs = ["JHN 4:7", "JHN 4:8", "JHN 4:9", "JHN 4:10"]
    const expectations = compileFileExpectations(refs.map((ref) => ({ id: ref, globalReferences: [ref] })), JHN4_VOICES, JHN4_STRUCTURE)
    for (const ref of refs) {
      const expectation = expectations.get(ref)
      if (!expectation) throw new Error(ref)
      const layers = { voices: JHN4_VOICES, structure: JHN4_STRUCTURE, people: null }
      expect(computeCellFacts(expectation, { ...layers, text: compact }).secondPerson).toBe(
        computeCellFacts(expectation, { ...layers, text: full }).secondPerson,
      )
    }
  })
})

// AQU-1701: the referent question (P13) names what the implied subject does
// ("…the one who answered?"), so the compact layer must keep those verbs'
// glosses — and only those verbs, or it grows back toward the full layer.
describe("compactTextLayer keeps the verbs whose subject the pack resolves", () => {
  const full = {
    book: "JHN",
    verses: { "JHN 1:42": ["n43001042001", "n43001042003", "n43001042005"] },
    words: {
      n43001042001: { text: "ἤγαγεν", lemma: "ἄγω", gloss: "He brought", english: "brought", after: " ", class: "verb", morph: "V-2AAI-3S", person: "third", number: "singular" },
      n43001042003: { text: "πρὸς", lemma: "πρός", gloss: "to", after: " ", class: "prep", morph: "PREP" },
      // The verse's last word: always kept, for S3.
      n43001042005: { text: "Ἰησοῦν", lemma: "Ἰησοῦς", gloss: "Jesus", after: ".", class: "noun", type: "proper", morph: "N-ASM" },
    },
  } as unknown as ServerBkpLayerData["text"]
  const people = {
    book: "JHN",
    entities: {},
    mentions: { n43001042001: { entity: "person:Andrew", kind: "subject", src: "macula", hops: 1, conf: 0.97 } },
  } as unknown as ServerBkpLayerData["people"]

  it("keeps an implied subject's verb with its gloss, and drops it without the people layer", () => {
    const kept = compactTextLayer(full, impliedSubjectWords(people))
    expect(kept.words.n43001042001).toMatchObject({ english: "brought", gloss: "He brought", person: "third" })
    expect(kept.words.n43001042003).toBeUndefined()
    expect(compactTextLayer(full).words.n43001042001?.english).toBeUndefined()
  })
})

// AQU-1697: the checks must see the same facts in the compact layer as in the
// full one, or autopilot and the editor disagree about the same verse.
describe("compactTextLayer keeps what the Bible data checks read", () => {
  it("gives the same numbers, negations and run-on sentences as the full layer", () => {
    const full = JHN_A_TEXT as unknown as ServerBkpLayerData["text"]
    const compact = compactTextLayer(full)
    expect(Object.keys(compact.words).length).toBeLessThan(Object.keys(full.words).length / 2)
    const cells = Object.keys(JHN_A_TEXT.verses).map((ref) => ({ id: ref, globalReferences: [ref] }))
    const facts = (text: unknown) =>
      [...compileFileExpectations(cells, JHN_A_VOICES, JHN_A_STRUCTURE, text as ServerBkpLayerData["text"])].map(
        ([ref, e]) => [ref, e.numbers, e.negation, e.continuesPast],
      )
    expect(facts(compact)).toEqual(facts(full))
  })
})
