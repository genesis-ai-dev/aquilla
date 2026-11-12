// AQU-1187: the eBible and Hello AO importers emit ONE SOURCE FILE PER BOOK.
//
// Before this, a whole-Bible import from either catalog landed as a single file
// with no `bookCode` — it sat in the sidebar's "Ungrouped" bucket, the OT/NT
// Testament jump did not apply to it, and it produced the 31k-cell single files
// behind AQU-1047 / AQU-1160. These tests pin the file-per-book shape, the
// `bookCode` each file carries (what the sidebar groups and orders on), and the
// single-book and re-import cases that must not regress.
//
// Both importers reach the network through global `fetch`, so the stub below
// serves the catalog payloads and captures the resulting bulk-import bodies.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import "fake-indexeddb/auto"
import { importEBible, importHelloao } from "./import"
import { __setVrefsForTest, type EBibleTranslation } from "./parsers/ebible"
import type { HelloaoComplete, HelloaoTranslation } from "./parsers/helloao"
import { resetOutboxConnectionForTests } from "./sync/outbox"

interface CapturedUpload {
  url: string
  projectId: string
  fileId: string
  file?: { name: string; bookCode?: string; fileType?: string }
  cells: { cellId: string; value: string }[]
  complete?: boolean
}

let captured: CapturedUpload[]
/** Decoded bodies of the source-artifact (raw original) uploads. */
let artifactUploads: string[]
let corpusText: string
let completePayload: HelloaoComplete

const getToken = async () => "test-token"

const EBIBLE_TRANSLATION: EBibleTranslation = {
  id: "eng-engBBE",
  translationId: "engBBE",
  languageCode: "eng",
  languageName: "English",
  languageNameInEnglish: "English",
  title: "Bible in Basic English",
  textDirection: "ltr",
} as EBibleTranslation

const HELLOAO_TRANSLATION = {
  id: "BSB",
  name: "Berean Standard Bible",
  englishName: "Berean Standard Bible",
  language: "eng",
  textDirection: "ltr",
} as HelloaoTranslation

/** A Hello AO `complete.json` holding one verse in each of the given books. */
function helloaoComplete(books: string[]): HelloaoComplete {
  return {
    translation: HELLOAO_TRANSLATION,
    books: books.map((id, index) => ({
      id,
      name: id,
      commonName: id,
      order: index + 1,
      numberOfChapters: 1,
      totalNumberOfVerses: 1,
      chapters: [{
        chapter: {
          number: 1,
          content: [{ type: "verse" as const, number: 1, content: [`${id} verse one`] }],
        },
      }],
    })),
  }
}

/** The uploads that carried `file.create` metadata, in emission order. */
function fileUploads(): CapturedUpload[] {
  return captured.filter((body) => body.file !== undefined)
}

beforeEach(async () => {
  await resetOutboxConnectionForTests()
  captured = []
  artifactUploads = []
  corpusText = ""
  completePayload = helloaoComplete(["GEN"])
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const href = String(url)
      // eBible corpus text.
      if (href.endsWith(".txt")) return new Response(corpusText, { status: 200 })
      // Hello AO bulk payload.
      if (href.endsWith("complete.json")) {
        return new Response(JSON.stringify(completePayload), { status: 200 })
      }
      if (init?.body instanceof ArrayBuffer) {
        // The raw original is uploaded as bytes, separately from the cell JSON.
        artifactUploads.push(new TextDecoder().decode(init.body))
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body)) as CapturedUpload
      captured.push({ ...body, url: href })
      return new Response(
        JSON.stringify({ accepted: body.cells.length, fileId: body.fileId }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }),
  )
})

afterEach(async () => {
  await resetOutboxConnectionForTests()
  __setVrefsForTest(null)
  vi.unstubAllGlobals()
})

describe("importEBible — one file per book (AQU-1187)", () => {
  it("splits a whole-Bible corpus into one bookCode-carrying file per book", async () => {
    __setVrefsForTest(["GEN 1:1", "GEN 1:2", "EXO 1:1", "MAT 1:1"])
    corpusText = [
      "In the beginning",
      "And the earth was waste",
      "Now these are the names",
      "The book of the generations",
    ].join("\n")

    const refs = await importEBible(
      EBIBLE_TRANSLATION,
      { projectId: "p-1", author: "alice", getToken },
    )

    expect(refs).toHaveLength(3)
    expect(refs.map((ref) => ref.bookCode)).toEqual(["GEN", "EXO", "MAT"])
    // Named by book, the way the USFM and Paratext per-book paths name theirs —
    // this is what the sidebar's canonical ordering reads.
    expect(refs.map((ref) => ref.name)).toEqual(["Genesis", "Exodus", "Matthew"])
    // Every verse landed in its own book's file; none were dropped or shared.
    expect(refs.map((ref) => ref.cellCount)).toEqual([2, 1, 1])

    const uploads = fileUploads()
    expect(uploads.map((upload) => upload.file?.bookCode)).toEqual(["GEN", "EXO", "MAT"])
    // Distinct files, not one file written three times.
    expect(new Set(uploads.map((upload) => upload.fileId)).size).toBe(3)
  })

  it("keeps a single-book corpus as one file, but stamps its bookCode", async () => {
    __setVrefsForTest(["MRK 1:1", "MRK 1:2"])
    corpusText = "The start of the good news\nEven as it is said"

    const refs = await importEBible(
      EBIBLE_TRANSLATION,
      { projectId: "p-1", author: "alice", getToken },
    )

    expect(refs).toHaveLength(1)
    // The translation title still names a one-book import; only the code is new.
    expect(refs[0].name).toBe("Bible in Basic English (eng-engBBE)")
    expect(refs[0].bookCode).toBe("MRK")
  })

  it("re-imports into the existing per-book file instead of duplicating the book", async () => {
    __setVrefsForTest(["GEN 1:1", "EXO 1:1"])
    corpusText = "In the beginning\nNow these are the names"

    const refs = await importEBible(
      EBIBLE_TRANSLATION,
      {
        projectId: "p-1",
        author: "alice",
        getToken,
        // Same shape the USFM path uses: keyed by uppercase book code.
        reimportFileIds: new Map([["GEN", "existing-genesis-file"]]),
      },
    )

    expect(refs.map((ref) => ref.id)[0]).toBe("existing-genesis-file")
    expect(refs[1].id).not.toBe("existing-genesis-file")
  })
})

describe("importHelloao — one file per selected book (AQU-1187)", () => {
  it("emits one file per book for a whole-Bible selection", async () => {
    completePayload = helloaoComplete(["GEN", "PSA", "JHN"])

    const refs = await importHelloao(
      HELLOAO_TRANSLATION,
      null,
      { projectId: "p-1", author: "alice", getToken },
    )

    expect(refs.map((ref) => ref.bookCode)).toEqual(["GEN", "PSA", "JHN"])
    expect(refs.map((ref) => ref.name)).toEqual(["Genesis", "Psalms", "John"])
  })

  it("honours the dialog's book selection", async () => {
    completePayload = helloaoComplete(["GEN", "PSA", "JHN"])

    const refs = await importHelloao(
      HELLOAO_TRANSLATION,
      new Set(["GEN", "JHN"]),
      { projectId: "p-1", author: "alice", getToken },
    )

    expect(refs.map((ref) => ref.bookCode)).toEqual(["GEN", "JHN"])
  })

  it("keeps a one-book selection as a single file carrying its bookCode", async () => {
    completePayload = helloaoComplete(["GEN", "PSA"])

    const refs = await importHelloao(
      HELLOAO_TRANSLATION,
      new Set(["PSA"]),
      { projectId: "p-1", author: "alice", getToken },
    )

    expect(refs).toHaveLength(1)
    expect(refs[0].name).toBe("Berean Standard Bible (BSB)")
    expect(refs[0].bookCode).toBe("PSA")
  })

  it("gives each book its own original rather than 66 copies of the whole payload", async () => {
    completePayload = helloaoComplete(["GEN", "PSA"])

    await importHelloao(
      HELLOAO_TRANSLATION,
      null,
      { projectId: "p-1", author: "alice", getToken },
    )

    expect(artifactUploads).toHaveLength(2)
    for (const raw of artifactUploads) {
      const parsed = JSON.parse(raw) as HelloaoComplete
      expect(parsed.books).toHaveLength(1)
    }
    expect(artifactUploads.map((raw) => (JSON.parse(raw) as HelloaoComplete).books[0].id))
      .toEqual(["GEN", "PSA"])
  })
})
