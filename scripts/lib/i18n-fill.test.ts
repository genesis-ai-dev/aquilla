// The checks a model's answer has to pass before the fill job imports it
// (AQU-2792). No model here: `complete` is a function the test writes.
import { describe, expect, it } from "vitest"
import { DEFAULT_LOCALE, LOCALES } from "../../src/lib/i18n/locales"
import { CATALOGS } from "../../src/lib/i18n/messages/all"
import {
  BATCH_SIZE,
  LOCALE_BRIEFS,
  buildPrompt,
  fillPacket,
  keptKeys,
  keptLimit,
  leafIssue,
  parseReply,
  priorArt,
  type ChatMessage,
  type Packet,
} from "./i18n-fill"

// Real keys: a plain one, one with a placeholder, and a plural one.
const SAVE = "common.save"
const ATTACHED = "editor.footnote.attachedTo"
const RESULTS_ONE = "search.resultCount#one"
const RESULTS_OTHER = "search.resultCount#other"

const packet = (locale: string, messages: Record<string, string>): Packet => ({
  locale,
  messages,
  notes: Object.fromEntries(Object.keys(messages).map((leaf) => [leaf, `note for ${leaf}`])),
})

/** A model that answers each request from a list, and records what it was sent. */
function scripted(...answers: Array<Record<string, string> | Error>) {
  const sent: ChatMessage[][] = []
  const complete = async (messages: ChatMessage[]) => {
    sent.push(messages)
    const answer = answers[sent.length - 1]
    if (answer === undefined) throw new Error("the test model was asked more often than it was scripted for")
    if (answer instanceof Error) throw answer
    return JSON.stringify(answer)
  }
  return { complete, sent }
}

describe("LOCALE_BRIEFS", () => {
  it("has a brief for every locale the interface ships, so a new locale cannot be filled without one", () => {
    const shipped = LOCALES.map((locale) => locale.code).filter((code) => code !== DEFAULT_LOCALE)
    expect(Object.keys(LOCALE_BRIEFS).sort()).toEqual([...shipped].sort())
  })
})

describe("leafIssue", () => {
  it("accepts a translation that keeps the placeholder", () => {
    expect(leafIssue("fr", ATTACHED, "Attached to {ref}.", "Rattachée à {ref}.")).toBeNull()
  })

  it("rejects a placeholder the app does not fill, and names the ones it does", () => {
    expect(leafIssue("fr", ATTACHED, "Attached to {ref}.", "Rattachée à {référence}.")).toMatch(
      /\{référence\}.*Allowed: \{ref\}/,
    )
  })

  it("rejects a plain string that drops its placeholder", () => {
    expect(leafIssue("fr", ATTACHED, "Attached to {ref}.", "Rattachée.")).toBe("drops {ref}")
  })

  it("lets a plural form drop the count, and not add another name", () => {
    expect(leafIssue("fr", RESULTS_ONE, "{count} result", "Un résultat")).toBeNull()
    expect(leafIssue("fr", RESULTS_ONE, "{count} result", "{total} résultat")).toMatch(/\{total\}/)
    // A translated name is still a name the app does not fill.
    expect(leafIssue("zh-Hans", RESULTS_OTHER, "{count} results", "{数量} 条结果")).toMatch(/\{数量\}/)
  })

  it("rejects an answer left in English for a locale with a script of its own", () => {
    expect(leafIssue("th", SAVE, "Save", "Save it")).toMatch(/script/)
    expect(leafIssue("th", SAVE, "Save", "บันทึก")).toBeNull()
    // Latin-script locales have no such check: French is not told from English by script.
    expect(leafIssue("fr", SAVE, "Save", "Save it")).toBeNull()
  })

  it("does not ask for a script from a string that has no letters to translate", () => {
    expect(leafIssue("th", ATTACHED, "{ref}:", "{ref} :")).toBeNull()
  })

  it("rejects an empty answer and a leaf that is not a message", () => {
    expect(leafIssue("fr", SAVE, "Save", "  ")).toBe("empty")
    expect(leafIssue("fr", "no.such.key", "Nothing", "Rien")).toBe("not a message key")
  })
})

describe("parseReply", () => {
  it("reads the object out of a fenced or chatty answer and keeps only strings", () => {
    const text = 'Here you go:\n```json\n{"a": "un", "b": 2, "c": "trois"}\n```'
    expect(parseReply(text)).toEqual({ a: "un", c: "trois" })
  })

  it("reads nothing from an answer that is not an object", () => {
    expect(parseReply("I cannot translate this.")).toEqual({})
    expect(parseReply('["un"]')).toEqual({})
    expect(parseReply('{"a": "un"')).toEqual({})
  })
})

describe("priorArt", () => {
  it("offers strings the locale already ships, each with its English", () => {
    const art = priorArt([ATTACHED], CATALOGS.fr)
    expect(art.length).toBeGreaterThan(0)
    expect(art.length).toBeLessThanOrEqual(80)
    for (const { english, translation } of art) {
      expect(english).not.toBe("")
      expect(translation).not.toBe("")
    }
  })

  it("never offers the string being asked for, and nothing from an empty catalog", () => {
    expect(priorArt([SAVE], { [SAVE]: "Enregistrer" })).toEqual([])
    expect(priorArt([SAVE], {})).toEqual([])
  })
})

describe("buildPrompt", () => {
  it("names the language, its variety and each string with its note", () => {
    const [system, user] = buildPrompt("pt", [{ leaf: SAVE, english: "Save", note: "A button." }], [])
    expect(system.content).toContain("Portuguese (pt)")
    expect(system.content).toContain(LOCALE_BRIEFS.pt)
    expect(JSON.parse(user.content).strings).toEqual([{ id: SAVE, english: "Save", note: "A button." }])
  })

  it("on a retry sends back why each answer was refused", () => {
    const [, user] = buildPrompt("pt", [{ leaf: SAVE, english: "Save", note: "" }], [], { [SAVE]: "empty" })
    const body = JSON.parse(user.content)
    expect(body.retry).toBeTruthy()
    expect(body.strings[0].rejected).toBe("empty")
  })
})

describe("fillPacket", () => {
  it("keeps what passes, and reports what the model left in English", async () => {
    const model = scripted({ [SAVE]: "Enregistrer", [ATTACHED]: "Attached to {ref}." })
    const input = packet("fr", { [SAVE]: "Save", [ATTACHED]: "Attached to {ref}." })

    const result = await fillPacket(input, CATALOGS.fr, model.complete)

    expect(result.translated).toEqual({ [SAVE]: "Enregistrer" })
    expect(result.kept).toEqual([ATTACHED])
    expect(result.failed).toEqual([])
    expect(model.sent).toHaveLength(1)
  })

  it("asks once more for an answer it refused, with the reason, and takes the second", async () => {
    const model = scripted({ [ATTACHED]: "Rattachée." }, { [ATTACHED]: "Rattachée à {ref}." })

    const result = await fillPacket(packet("fr", { [ATTACHED]: "Attached to {ref}." }), CATALOGS.fr, model.complete)

    expect(result.translated).toEqual({ [ATTACHED]: "Rattachée à {ref}." })
    expect(JSON.parse(model.sent[1][1].content).strings).toEqual([
      expect.objectContaining({ id: ATTACHED, rejected: "drops {ref}" }),
    ])
  })

  it("gives up on a string after two refusals and says why", async () => {
    const model = scripted({ [SAVE]: "Save now" }, { [SAVE]: "Save now" })

    const result = await fillPacket(packet("th", { [SAVE]: "Save" }), CATALOGS.th, model.complete)

    expect(result.translated).toEqual({})
    expect(result.failed).toEqual([{ leaf: SAVE, issue: expect.stringMatching(/script/) }])
  })

  it("survives a request that fails: the retry can still answer", async () => {
    const model = scripted(new Error("HTTP 503 from the model"), { [SAVE]: "Enregistrer" })

    const result = await fillPacket(packet("fr", { [SAVE]: "Save" }), CATALOGS.fr, model.complete)

    expect(result.translated).toEqual({ [SAVE]: "Enregistrer" })
  })

  it("reports a request that fails twice against each of its strings", async () => {
    const model = scripted(new Error("HTTP 503"), new Error("HTTP 503"))

    const result = await fillPacket(packet("fr", { [SAVE]: "Save" }), CATALOGS.fr, model.complete)

    expect(result.failed).toEqual([{ leaf: SAVE, issue: "the request failed: HTTP 503" }])
  })

  it("puts back the whitespace the English starts or ends with", async () => {
    const model = scripted({ [SAVE]: "Enregistrer" })

    const result = await fillPacket(packet("fr", { [SAVE]: "Save " }), CATALOGS.fr, model.complete)

    expect(result.translated[SAVE]).toBe("Enregistrer ")
  })

  it("shows a string whose English changed the translation it has now", async () => {
    const model = scripted({ [SAVE]: "Sauvegarder" })

    await fillPacket(packet("fr", { [SAVE]: "Save" }), CATALOGS.fr, model.complete)

    expect(JSON.parse(model.sent[0][1].content).strings[0].current).toBe(CATALOGS.fr[SAVE])
  })

  it("does not believe a model that returns most of a packet unchanged", async () => {
    // Made-up ids are enough: an unchanged answer is counted before any other check.
    const messages = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`made.up.${n}`, `English ${n}`]))
    const model = scripted(messages)

    const result = await fillPacket(packet("fr", messages), CATALOGS.fr, model.complete)

    expect(keptLimit(8)).toBe(3)
    expect(result.kept).toEqual([])
    expect(result.failed).toHaveLength(8)
    expect(result.failed[0].issue).toMatch(/unchanged/)
  })

  it("sends a large packet in batches", async () => {
    const messages = Object.fromEntries(Array.from({ length: BATCH_SIZE + 1 }, (_, n) => [`made.up.${n}`, `English ${n}`]))
    // Unchanged answers need no retry, so each request is one batch.
    const model = scripted(messages, messages)

    await fillPacket(packet("fr", messages), CATALOGS.fr, model.complete)

    expect(model.sent).toHaveLength(2)
    expect(JSON.parse(model.sent[0][1].content).strings).toHaveLength(BATCH_SIZE)
    expect(JSON.parse(model.sent[1][1].content).strings).toHaveLength(1)
  })

  it("refuses a locale it has no brief for", async () => {
    await expect(fillPacket(packet("en", { [SAVE]: "Save" }), {}, scripted().complete)).rejects.toThrow(/brief/)
  })
})

describe("keptKeys", () => {
  it("names a key only when every one of its forms was kept", () => {
    const input = packet("fr", { [SAVE]: "Save", [RESULTS_ONE]: "{count} result", [RESULTS_OTHER]: "{count} results" })
    const result = { locale: "fr", translated: {}, kept: [SAVE, RESULTS_ONE], failed: [] }
    expect(keptKeys(input, result)).toEqual([SAVE])
  })
})
