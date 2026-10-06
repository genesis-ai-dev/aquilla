// AQU-1690: which Language-profile slots autopilot asks for. A slot is asked
// for only when the book's Bible data needs it, and every one-click option
// must be an answer the profile can store — an option that fails validation
// turns a one-click answer into an error (AQU-1691 refuses to raise it).

import { describe, expect, it } from "vitest"
import { bibleFactQuestions } from "./bible-fact-questions"
import { jhn4BibleData } from "./bible-test-helpers"
import { factAnswerProblem } from "../../../../db/shared/project-facts"
import { decisionOptionsProblem } from "../../../../db/shared/contextual-decisions"

describe("bibleFactQuestions", () => {
  it("asks for quotation marks, question markers and 'you' number when JHN 4 needs them and the profile is empty", async () => {
    const questions = bibleFactQuestions(await jhn4BibleData({ profile: {} }))
    expect(questions.map((q) => q.factKey)).toEqual(["quoteMarks", "questionMarkers", "pronouns.secondPerson"])
    const quotes = questions[0]
    expect(quotes.cellIds).toEqual(["c7", "c9", "c10"])
    expect(quotes.options[0].label).toContain("(English)")
  })

  it("asks for nothing the profile already answers", async () => {
    const questions = bibleFactQuestions(
      await jhn4BibleData({
        profile: {
          quoteMarks: { levels: [{ open: "“", close: "”" }], continuation: "none" },
          questionMarkers: {},
          pronouns: { secondPerson: { numberDistinction: false } },
        },
      }),
    )
    expect(questions).toEqual([])
  })

  it("offers only options the Language profile can store, one click each", async () => {
    for (const question of bibleFactQuestions(await jhn4BibleData({ profile: {} }))) {
      expect(decisionOptionsProblem(question.options)).toBeNull()
      for (const option of question.options) {
        expect(factAnswerProblem(question.factKey, option.value, {}), `${question.factKey} = ${option.value}`).toBeNull()
      }
    }
  })
})
