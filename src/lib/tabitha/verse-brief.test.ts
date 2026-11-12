// WHY: a cold TaBiThA verse costs ~35s upstream and the API is rate-limited,
// so the panel must never refetch a verse it already has — but a failed fetch
// must not be cached forever, or one network blip hides that verse's notes
// for the rest of the session.

import { afterEach, describe, expect, it, vi } from "vitest"
import { __resetVerseBriefCache, loadVerseBrief, verseRefFromPassagePath } from "./verse-brief"

const BRIEF = { available: true, lwcText: "x", notes: [], translatorNotes: [], culturalBackground: [] }

afterEach(() => {
  vi.restoreAllMocks()
  __resetVerseBriefCache()
})

describe("verseRefFromPassagePath", () => {
  it("parses the sidebar's passage path and rejects anything else", () => {
    expect(verseRefFromPassagePath("/en/passages/1SA/3/10/")).toEqual({ book: "1SA", chapter: 3, verse: 10 })
    expect(verseRefFromPassagePath("/en/passages/ACT/10/")).toBeNull()
    expect(verseRefFromPassagePath("/en/people/peter/")).toBeNull()
  })
})

describe("loadVerseBrief", () => {
  const ref = { book: "ACT", chapter: 10, verse: 9 }

  it("fetches a verse once per tab", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BRIEF)))
    await loadVerseBrief("jwt", "p1", ref)
    await loadVerseBrief("jwt", "p1", ref)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0][0])).toContain("/api/v1/aquifer/tabitha?projectId=p1&book=ACT&chapter=10&verse=9")
  })

  it("retries after a failed fetch", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("down", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(BRIEF)))
    await expect(loadVerseBrief("jwt", "p1", ref)).rejects.toThrow()
    await expect(loadVerseBrief("jwt", "p1", ref)).resolves.toEqual(BRIEF)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
