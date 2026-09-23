import { afterEach, describe, expect, it, vi } from "vitest"
import { importSdbh, SdbhImportCancelledError } from "./import-sdbh"
import { SDBH_MAX_REFERENCES } from "./parsers/sdbh"

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

const OVERSIZED = JSON.stringify([{
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
      LEXSenses: [{ LanguageCode: "en", DefinitionLong: "father", DefinitionShort: "", Glosses: null, Comments: "" }],
      CONMeanings: [{
        CONID: "000001001001001",
        CONType: "COL",
        CONDomains: null,
        CONForms: null,
        CONCollocations: ["x"],
        CONSenses: [{ LanguageCode: "en", DefinitionLong: "", DefinitionShort: "", Glosses: ["g"], Comments: "" }],
        CONReferences: Array.from({ length: SDBH_MAX_REFERENCES + 1 }, (_, i) => String(i).padStart(14, "0")),
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

  it("asks before uploading when fields will be marked not imported, and cancelling uploads nothing", async () => {
    // WHY: the user must be able to back out BEFORE any cell lands, so there
    // is nothing to roll back — this gate is the whole point of AQU-793's
    // "not imported" marker over silent truncation.
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const confirm = vi.fn(async () => false)
    await expect(
      importSdbh(OVERSIZED, null, { projectId: "p1", author: "alice", getToken: async () => "tok" }, undefined, undefined, {
        confirmNotImported: confirm,
      }),
    ).rejects.toBeInstanceOf(SdbhImportCancelledError)
    expect(confirm).toHaveBeenCalledWith([
      { conId: "000001001001001", lemma: "אָב", field: "references", count: SDBH_MAX_REFERENCES + 1 },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("proceeds when confirmed and surfaces the not-imported list in the summary", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/source-bindings")) return new Response("{}", { status: 200 })
      if (url.includes("/source")) {
        return new Response(JSON.stringify({ artifactId: "a", key: "k", sha256: "f".repeat(64) }), { status: 200 })
      }
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 })
    }))
    const summary = await importSdbh(
      OVERSIZED, null, { projectId: "p1", author: "alice", getToken: async () => "tok" }, undefined, undefined,
      { confirmNotImported: async () => true },
    )
    expect(summary.notImported).toHaveLength(1)
    expect(summary.refs.length).toBeGreaterThan(0)
  })
})
