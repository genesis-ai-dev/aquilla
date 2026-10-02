// AQU-1573: the editor's cache of cited verses. Drafting asks it for the
// block of one call's cells; the quote check reads it synchronously. These
// pin the parts a translator would feel: the right verses in the block, one
// request per open file rather than per keystroke or per draft, and no block
// (never an error) when the lane has no Bible or the server lacks it.

import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor, act } from "@testing-library/react"

vi.mock("@/lib/frontier/reference-bibles", () => ({
  fetchReferencePassages: vi.fn(),
}))

import { fetchReferencePassages, type ReferencePassagesResult } from "@/lib/frontier/reference-bibles"
import { resetReferenceBibleCacheForTests, useReferenceBible } from "./useReferenceBible"
import { REFERENCE_VERSES_HEADING } from "@/lib/completion/prompt-build"
import type { ReferenceBibleSummary } from "@/lib/reference-bible/types"

const fetchPassages = vi.mocked(fetchReferencePassages)

const VAN_DYCK: ReferenceBibleSummary = {
  id: "arb-vandyck",
  name: "Van Dyck",
  fullName: "Smith & Van Dyck Arabic Bible",
  languageCode: "ar",
  languageName: "Arabic",
  direction: "rtl",
  versification: "eng",
  printing: "vowelled",
  license: "Public domain",
  source: "eBible.org arb-vd",
  verseCount: 31104,
}

const VERSES: Record<string, string[]> = {
  "ISA 40:25": ["«فَبِمَنْ تُشَبِّهُونَنِي فَأُسَاوِيَهُ؟» يَقُولُ ٱلْقُدُّوسُ."],
  "JHN 3:16": ["لِأَنَّهُ هَكَذَا أَحَبَّ ٱللهُ ٱلْعَالَمَ"],
  "ROM 5:8": ["وَلَكِنَّ ٱللهَ بَيَّنَ مَحَبَّتَهُ لَنَا"],
}

/** The server: answers from VERSES; anything else is unresolved. */
function serve(versionId = "arb-vandyck") {
  fetchPassages.mockImplementation(async (_jwt, id, refs): Promise<ReferencePassagesResult | null> => {
    if (id !== versionId) return null
    return {
      version: VAN_DYCK,
      passages: refs.filter((r) => VERSES[r]).map((canonical) => ({
        canonical,
        label: canonical,
        verses: VERSES[canonical].map((text, i) => ({ chapter: 1, verse: i + 1, text })),
      })),
      unresolved: refs.filter((r) => !VERSES[r]),
    }
  })
}

const cell = (original: string) => ({ original })
const ISAIAH = cell('Isaiah 40:25 says, "To whom will you compare me?"')
const PLAIN = cell("God is beyond compare.")
const LIST = cell("Romans 5:8; John 3:16 show us his love.")
const MISSING = cell("Isaiah 40:99 is not a verse.")

function hook(versionId: string | null, cells: { original: string }[] = [], jwt: string | null = "jwt") {
  const getCells = () => cells
  return renderHook(
    ({ v }) => useReferenceBible({ jwt, versionId: v, getCells, cellsVersion: cells.length }),
    { initialProps: { v: versionId } },
  )
}

describe("useReferenceBible", () => {
  beforeEach(() => {
    resetReferenceBibleCacheForTests()
    fetchPassages.mockReset()
  })

  it("gives no block, and asks nothing, when the lane has no Bible or nobody is signed in", async () => {
    serve()
    expect(await hook(null).result.current.blockFor([ISAIAH])).toBeUndefined()
    expect(await hook("arb-vandyck", [], null).result.current.blockFor([ISAIAH])).toBeUndefined()
    expect(fetchPassages).not.toHaveBeenCalled()
  })

  it("builds the labelled block from the server's verses", async () => {
    serve()
    const { result } = hook("arb-vandyck")
    const block = await result.current.blockFor([ISAIAH])
    expect(fetchPassages).toHaveBeenCalledWith("jwt", "arb-vandyck", ["ISA 40:25"])
    expect(block?.split("\n")[0]).toBe(`${REFERENCE_VERSES_HEADING}Van Dyck (Arabic) (MUST follow):`)
    expect(block).toContain(`[ISA 40:25]: ${VERSES["ISA 40:25"][0]}`)
  })

  it("asks once per reference: a second draft of the same cells reads the cache", async () => {
    serve()
    const { result } = hook("arb-vandyck")
    const first = await result.current.blockFor([ISAIAH, LIST])
    const second = await result.current.blockFor([ISAIAH, LIST])
    expect(second).toBe(first)
    expect(fetchPassages).toHaveBeenCalledTimes(1)
    expect(fetchPassages.mock.calls[0][2]).toEqual(["ISA 40:25", "ROM 5:8", "JHN 3:16"])
  })

  it("shares one in-flight request between two drafts started together", async () => {
    serve()
    const { result } = hook("arb-vandyck")
    const [a, b] = await Promise.all([result.current.blockFor([ISAIAH]), result.current.blockFor([ISAIAH])])
    expect(a).toBe(b)
    expect(fetchPassages).toHaveBeenCalledTimes(1)
  })

  it("gives no block for a cell that cites nothing, without asking the server", async () => {
    serve()
    expect(await hook("arb-vandyck").result.current.blockFor([PLAIN])).toBeUndefined()
    expect(fetchPassages).not.toHaveBeenCalled()
  })

  it("leaves out a verse the Bible does not have, and gives no block when that was the only one", async () => {
    serve()
    const { result } = hook("arb-vandyck")
    expect(await result.current.blockFor([MISSING])).toBeUndefined()
    const block = await result.current.blockFor([MISSING, ISAIAH])
    expect(block).toContain("[ISA 40:25]")
    expect(block).not.toContain("40:99")
    // ISA 40:99 was remembered as missing: only ISA 40:25 was asked the second time.
    expect(fetchPassages.mock.calls[1][2]).toEqual(["ISA 40:25"])
  })

  it("gives no block when the server does not have the Bible, and stops asking", async () => {
    serve("eng-kjv")
    const { result } = hook("arb-vandyck")
    expect(await result.current.blockFor([ISAIAH])).toBeUndefined()
    expect(await result.current.blockFor([LIST])).toBeUndefined()
    expect(fetchPassages).toHaveBeenCalledTimes(1)
    expect(result.current.checkContext).toBeNull()
  })

  it("rejects on a failed request (the caller drafts without it) and retries next time", async () => {
    serve()
    fetchPassages.mockRejectedValueOnce(new Error("offline"))
    const { result } = hook("arb-vandyck")
    await expect(result.current.blockFor([ISAIAH])).rejects.toThrow("offline")
    expect(await result.current.blockFor([ISAIAH])).toContain("[ISA 40:25]")
    expect(fetchPassages).toHaveBeenCalledTimes(2)
  })

  it("prefetches the open file in one request and hands the quote check a lookup", async () => {
    serve()
    const { result } = hook("arb-vandyck", [ISAIAH, PLAIN, LIST])
    expect(result.current.checkContext).toBeNull()
    const sigBefore = result.current.sig
    await waitFor(() => expect(result.current.checkContext).not.toBeNull())
    expect(fetchPassages).toHaveBeenCalledTimes(1)
    expect(fetchPassages.mock.calls[0][2]).toEqual(["ISA 40:25", "ROM 5:8", "JHN 3:16"])
    const ctx = result.current.checkContext!
    expect(ctx.versionName).toBe("Van Dyck")
    expect(ctx.lookup("JHN 3:16")).toEqual(VERSES["JHN 3:16"])
    expect(ctx.lookup("GEN 1:1")).toBeUndefined()
    expect(result.current.sig).not.toBe(sigBefore)
    // Drafting afterwards reads the cache.
    await act(async () => {
      await result.current.blockFor([LIST])
    })
    expect(fetchPassages).toHaveBeenCalledTimes(1)
  })

  it("switching the lane to another Bible switches the verses", async () => {
    fetchPassages.mockImplementation(async (_jwt, id, refs) => ({
      version: { ...VAN_DYCK, id, name: id === "eng-kjv" ? "King James Version" : "Van Dyck", languageName: id === "eng-kjv" ? "English" : "Arabic" },
      passages: refs.map((canonical) => ({ canonical, label: canonical, verses: [{ chapter: 40, verse: 25, text: `${id} text` }] })),
      unresolved: [],
    }))
    const { result, rerender } = hook("arb-vandyck")
    expect(await result.current.blockFor([ISAIAH])).toContain("arb-vandyck text")
    rerender({ v: "eng-kjv" })
    const block = await result.current.blockFor([ISAIAH])
    expect(block).toContain("King James Version (English)")
    expect(block).toContain("eng-kjv text")
  })
})
