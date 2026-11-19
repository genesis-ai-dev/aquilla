import { describe, expect, it } from "vitest"
import { __resetStreamingDiffForTests, diffWhileWriting, diffWriting, hasChanges, type DiffChunk } from "./diff"

/** A diff as one line: `[-out-]` `{+in+}`, changed letters in capitals' place
 *  are not shown — this reads the word-level shape only. */
const line = (chunks: readonly DiffChunk[]): string =>
  chunks.map((c) => (c.kind === "same"
    ? c.text
    : `${c.del.length ? `[-${c.del.map((p) => p.text).join("")}-]` : ""}${c.ins.length ? `{+${c.ins.map((p) => p.text).join("")}+}` : ""}`)).join(" ")

describe("diffWriting", () => {
  it("shows what was taken out and what was put in, in place", () => {
    expect(line(diffWriting("ni eema akaenda kwa mji kapernaumu", "ni Yesu akaenda mjini kapernaumu")))
      .toBe("ni [-eema-]{+Yesu+} akaenda [-kwa mji-]{+mjini+} kapernaumu")
  })

  // Orthography is what the cleanup is for: a restored capital or full stop is
  // a change the person must be able to see, not noise to hide.
  it("counts a capital letter or a full stop as a change", () => {
    const chunks = diffWriting("yesu akasema", "Yesu akasema.")
    expect(hasChanges(chunks)).toBe(true)
    expect(line(chunks)).toBe("[-yesu-]{+Yesu+} [-akasema-]{+akasema.+}")
  })

  it("has no change when the writing is the same", () => {
    expect(hasChanges(diffWriting("yesu  akasema", " yesu akasema "))).toBe(false)
  })

  // "kitsi → kitsí" should point at the accent, not repaint the whole word.
  it("marks only the letters that changed inside a respelled word", () => {
    const [chunk] = diffWriting("kitsi", "kitsí")
    expect(chunk).toEqual({
      kind: "change",
      del: [{ text: "kits", changed: false }, { text: "i", changed: true }],
      ins: [{ text: "kits", changed: false }, { text: "í", changed: true }],
    })
  })

  it("marks an unrelated replacement whole, without picking out stray shared letters", () => {
    const [chunk] = diffWriting("eema", "Yohana")
    expect(chunk).toEqual({
      kind: "change",
      del: [{ text: "eema", changed: true }],
      ins: [{ text: "Yohana", changed: true }],
    })
  })
})

describe("diffWhileWriting", () => {
  const heard = "ni eema akaenda kwa mji kapernaumu"

  // The reason this function exists: the first token of a reply must not make
  // the whole heard line look deleted.
  it("never shows the words the reply has not reached yet as deleted", () => {
    const start = diffWhileWriting(heard, "ni ")
    expect(line(start.chunks)).toBe("ni")
    expect(start.pending).toBe("eema akaenda kwa mji kapernaumu")
  })

  it("covers only as much of the heard text as has been rewritten", () => {
    const mid = diffWhileWriting(heard, "ni Yesu akaenda ")
    expect(line(mid.chunks)).toBe("ni [-eema-]{+Yesu+} akaenda")
    expect(mid.pending).toBe("kwa mji kapernaumu")
  })

  // Tokens split words. Half a word would flash as a change and then heal.
  it("holds back a word that is still being written", () => {
    const partial = diffWhileWriting(heard, "ni Ye")
    expect(line(partial.chunks)).toBe("ni")
    expect(partial.pending).toBe("eema akaenda kwa mji kapernaumu")
  })

  // Whatever the reply has got to, every heard word is still on the row
  // exactly once and in order: kept, struck out, or waiting. A word that
  // vanished or doubled mid-stream would make the row jump about.
  it("accounts for every heard word exactly once at every point of the reply", () => {
    const reply = "ni Yesu akaenda mjini kapernaumu"
    for (let cut = 0; cut <= reply.length; cut++) {
      const { chunks, pending } = diffWhileWriting(heard, reply.slice(0, cut))
      const shown = chunks
        .map((c) => (c.kind === "same" ? c.text : c.del.map((p) => p.text).join("")))
        .concat(pending)
        .filter(Boolean)
        .join(" ")
      expect(shown, `after ${JSON.stringify(reply.slice(0, cut))}`).toBe(heard)
    }
  })

  it("shows nothing pending and nothing changed before the first word", () => {
    expect(diffWhileWriting(heard, "")).toEqual({ chunks: [], pending: heard })
  })

  it("matches the finished diff once every word has been written", () => {
    const written = "ni Yesu akaenda mjini kapernaumu "
    expect(diffWhileWriting(heard, written)).toEqual({ chunks: diffWriting(heard, written), pending: "" })
  })

  // Words really dropped at the end only show as deleted when the reply ends,
  // which is the finished diff's job (diffWriting), not this one's.
  it("leaves trailing heard words pending rather than deleted while the reply is open", () => {
    const cut = diffWhileWriting("yesu akasema amina amina", "Yesu akasema ")
    expect(cut.pending).toBe("amina amina")
  })

  // AQU-2654: a reply that grows by a word continues the comparison it has
  // already made instead of redoing every pair of words on every token. The
  // answer must be the one a comparison from scratch gives, at every point of
  // the reply, and a reply that is NOT a continuation must not be answered
  // from the one before it.
  it("answers a growing reply exactly as a comparison from scratch does", () => {
    const long = "ni eema akaenda kwa mji kapernaumu na wanafunzi wake wakamfuata hata baharini"
    const reply = "Ni Yesu akaenda mjini Kapernaumu, na wanafunzi wake wakamfuata hata baharini."
    const fromScratch = (written: string) => {
      __resetStreamingDiffForTests()
      return diffWhileWriting(long, written)
    }
    const expected = Array.from({ length: reply.length + 1 }, (_, cut) => fromScratch(reply.slice(0, cut)))
    __resetStreamingDiffForTests()
    for (let cut = 0; cut <= reply.length; cut++) {
      expect(diffWhileWriting(long, reply.slice(0, cut)), `after ${JSON.stringify(reply.slice(0, cut))}`).toEqual(expected[cut])
    }
    // A different reply to the same heard text (the row was run again).
    const other = "ni eema hakuenda "
    const continued = diffWhileWriting(long, other)
    expect(continued).toEqual(fromScratch(other))
    // And the same reply cut shorter than what was last compared.
    diffWhileWriting(long, reply)
    expect(diffWhileWriting(long, reply.slice(0, 20))).toEqual(fromScratch(reply.slice(0, 20)))
  })
})
