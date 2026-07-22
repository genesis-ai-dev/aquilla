import { afterEach, describe, expect, it, vi } from "vitest"
import { importSdbh } from "./import-sdbh"

const MASTER = JSON.stringify([{
  MainId: "1",
  Lemma: "אָב",
  AlphaPos: "א",
  StrongCodes: ["H1"],
  BaseForms: [{
    BaseFormID: "1",
    PartsOfSpeech: ["noun"],
    LEXMeanings: [{
      LEXID: "000001001001000",
      LEXDomains: null,
      LEXCoreDomains: null,
      LEXSenses: [{
        LanguageCode: "en",
        DefinitionLong: "father",
        DefinitionShort: "",
        Glosses: null,
        Comments: "",
      }],
    }],
  }],
}])

afterEach(() => vi.unstubAllGlobals())

describe("importSdbh", () => {
  it("stages every generated file, preserves the edition, and reports publication failures", async () => {
    const calls: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = []
    let publication = 0
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      calls.push({ url, init, body })
      if (url.includes("/source-bindings")) return new Response("{}", { status: 200 })
      if (url.includes("/source")) {
        return new Response(JSON.stringify({ artifactId: "a", key: "k", sha256: "f".repeat(64) }), { status: 200 })
      }
      if (body?.publishEventId) {
        publication++
        if (publication === 2) return new Response("cannot publish", { status: 400 })
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 })
    }))

    const exactBytes = new TextEncoder().encode(`${MASTER}\n`).buffer
    const summary = await importSdbh(
      MASTER,
      null,
      { projectId: "p1", author: "alice", getToken: async () => "tok" },
      undefined,
      { master: { name: "SDBH-en.JSON", bytes: exactBytes } },
    )

    const stagedFinalizers = calls.filter((call) => call.body?.complete && !call.body.publishEventId)
    expect(stagedFinalizers).toHaveLength(2)
    const sourceUpload = calls.find((call) => call.url.includes("/source") && !call.url.includes("source-bindings"))
    expect(sourceUpload?.init?.headers).toMatchObject({ "X-Source-Format": "sdbh-master" })
    expect(new Uint8Array(sourceUpload?.init?.body as ArrayBuffer)).toEqual(new Uint8Array(exactBytes))
    expect(summary.refs).toHaveLength(1)
    expect(summary.skipped).toEqual([
      expect.objectContaining({ book: "SDBH Semantic domains", reason: expect.stringMatching(/publication failed/) }),
    ])
  })
})
