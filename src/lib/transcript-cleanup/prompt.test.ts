import { describe, expect, it } from "vitest"
import {
  buildCleanupMessages,
  CLEANUP_MAX_PAIRS,
  CLEANUP_MAX_SAMPLES,
  countChangedWords,
  parseCleanupResult,
  partialCleanupText,
  sameWriting,
  type CleanupInput,
} from "./prompt"

const base: CleanupInput = {
  heard: "ni eema akaenda kwa mji kapernaumu",
  language: "Swahili",
  pairs: [{ heard: "eema akasema", corrected: "Yesu akasema" }],
  correctedOnly: [],
  terms: [{ term: "Yesu", note: "Jesus" }],
  context: [],
}

describe("buildCleanupMessages", () => {
  it("teaches from the team's own corrections and key terms, and marks them as data", () => {
    const [system, user] = buildCleanupMessages(base)
    expect(system.content).toMatch(/untrusted data/)
    expect(user.content).toContain("heard: eema akasema\ncorrected: Yesu akasema")
    expect(user.content).toContain("Yesu — Jesus")
    expect(user.content).toContain("<transcript>\nni eema akaenda kwa mji kapernaumu\n</transcript>")
  })

  it("tells the model never to add unspoken words — a cleanup must not invent speech", () => {
    const [system] = buildCleanupMessages(base)
    expect(system.content).toMatch(/Never add words/)
  })

  it("fills only the example budget the pairs leave with corrected-only transcripts", () => {
    const pairs = Array.from({ length: CLEANUP_MAX_PAIRS - 1 }, (_, i) => ({ heard: `h${i}`, corrected: `c${i}` }))
    const [, user] = buildCleanupMessages({ ...base, pairs, correctedOnly: ["only-a", "only-b"] })
    expect(user.content).toContain("only-a")
    expect(user.content).not.toContain("only-b")
  })

  // With no corrected transcript yet, the team's written lines are the only
  // evidence of the orthography. They must reach the model, capped, and never
  // as something to copy words from.
  it("shows the team's written lines as spelling evidence, capped", () => {
    const samples = Array.from({ length: 30 }, (_, i) => `Mstari wa ${i}.`)
    const [system, user] = buildCleanupMessages({ ...base, samples })
    expect(user.content).toContain("<written-in-this-language>\nMstari wa 0.")
    expect(user.content).toContain(`Mstari wa ${CLEANUP_MAX_SAMPLES - 1}.`)
    expect(user.content).not.toContain(`Mstari wa ${CLEANUP_MAX_SAMPLES}.`)
    expect(system.content).toMatch(/Never copy a word from them that was not spoken/)
  })

  it("omits empty sections so the model is not shown a blank example block", () => {
    const [, user] = buildCleanupMessages({ ...base, pairs: [], terms: [] })
    expect(user.content).not.toContain("<team-corrections>")
    expect(user.content).not.toContain("<key-terms>")
    expect(user.content).not.toContain("<written-in-this-language>")
  })
})

describe("parseCleanupResult", () => {
  it("accepts a cleanup and counts its changes", () => {
    const r = parseCleanupResult(
      JSON.stringify({ text: "ni Yesu akaenda mjini kapernaumu", notes: [{ heard: "eema", wrote: "Yesu", reason: "name" }] }),
      base.heard,
    )
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.text).toBe("ni Yesu akaenda mjini kapernaumu")
    expect(r.notes).toHaveLength(1)
    expect(r.changes).toBe(3)
  })

  it("reports a transcript returned as it was as unchanged, so nothing is marked AI", () => {
    expect(parseCleanupResult(JSON.stringify({ text: " ni eema  akaenda kwa mji kapernaumu " }), base.heard).kind).toBe("unchanged")
  })

  // Capital letters and punctuation ARE the orthography. A CTC model writes
  // lower case with none; a cleanup that only restores them used to be thrown
  // away as "nothing to clean up" on text that was plainly not written right.
  it("accepts a cleanup that only restores capitals and punctuation, and counts the words it touched", () => {
    const r = parseCleanupResult(JSON.stringify({ text: "Ni eema, akaenda kwa mji Kapernaumu." }), base.heard)
    expect(r).toEqual(expect.objectContaining({ kind: "ok", changes: 3 }))
  })

  it("refuses a result that adds or drops too many words — the model filled in speech", () => {
    const longer = `${base.heard} na wanafunzi wake wote pamoja nao`
    expect(parseCleanupResult(JSON.stringify({ text: longer }), base.heard).kind).toBe("too-different")
  })

  it("allows a one-word join or split on a short take", () => {
    expect(parseCleanupResult(JSON.stringify({ text: "kwa mji" }), "kwamji").kind).toBe("ok")
  })

  it("treats non-JSON or an empty text as invalid", () => {
    expect(parseCleanupResult("sorry, I cannot", base.heard).kind).toBe("invalid")
    expect(parseCleanupResult(JSON.stringify({ text: "  " }), base.heard).kind).toBe("invalid")
  })

  it("reads JSON wrapped in prose or a code fence", () => {
    expect(parseCleanupResult('```json\n{"text":"ni Yesu akaenda kwa mji kapernaumu"}\n```', base.heard).kind).toBe("ok")
  })
})

describe("countChangedWords", () => {
  it("counts a replaced middle span by its longer side", () => {
    expect(countChangedWords("a b c d", "a x y z d")).toBe(3)
    expect(countChangedWords("a b c", "a b c")).toBe(0)
  })
})

describe("partialCleanupText", () => {
  // The lens shows the cleanup while it is written. What it shows must be the
  // transcript's own characters, never JSON syntax or half an escape.
  it("reads the text as far as the reply has got", () => {
    expect(partialCleanupText('{"te')).toEqual({ text: "", done: false })
    expect(partialCleanupText('{"text":"ni Ye')).toEqual({ text: "ni Ye", done: false })
    expect(partialCleanupText('{ "text" : "ni Yesu","notes":[')).toEqual({ text: "ni Yesu", done: true })
  })

  it("decodes escapes and waits for one that has only half arrived", () => {
    expect(partialCleanupText('{"text":"a \\"b\\" \\u00e9')).toEqual({ text: 'a "b" é', done: false })
    expect(partialCleanupText('{"text":"a \\')).toEqual({ text: "a ", done: false })
    expect(partialCleanupText('{"text":"a \\u00')).toEqual({ text: "a ", done: false })
  })

  it("only ever grows as the reply grows, so the row never flickers backwards", () => {
    const reply = '{"text":"ni \\"Yesu\\" akaenda \\u00e9 mjini","notes":[]}'
    let last = ""
    for (let cut = 0; cut <= reply.length; cut++) {
      const { text } = partialCleanupText(reply.slice(0, cut))
      expect(text.startsWith(last)).toBe(true)
      last = text
    }
    expect(last).toBe('ni "Yesu" akaenda é mjini')
  })
})

describe("sameWriting", () => {
  it("treats spacing around punctuation as the same writing, and nothing else", () => {
    expect(sameWriting("Yesu , akasema", "Yesu, akasema")).toBe(true)
    expect(sameWriting("yesu akasema", "Yesu akasema")).toBe(false)
    expect(sameWriting("yesu akasema", "yesu akasema.")).toBe(false)
    expect(sameWriting("kwa mji", "kwamji")).toBe(false)
  })
})
