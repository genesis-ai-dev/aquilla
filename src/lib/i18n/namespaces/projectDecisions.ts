import { defineNamespace } from "./types"

/**
 * `projectDecisions` namespace (AQU-1691): the decision log.
 *
 * AQU-2342: there is no separate "Project decisions" card any more. An answer
 * to an Autopilot question card is added to the project instructions (or, for
 * a language fact, to the Language profile the checks read).
 * `projectDecisions.card.*` is what the question card says about that.
 */
export const projectDecisions = defineNamespace({
  keys: {
    // ── Autopilot question card ──
    "projectDecisions.card.durable":
      "Your answer is added to the project instructions (or to the language data the checks use), so " +
      "every later AI draft follows it.",
    "projectDecisions.card.otherAnswer": "Or write your own answer",
    "projectDecisions.card.needsMaintainer":
      "Only a maintainer can answer this question, because the answer changes the Language profile.",
    "projectDecisions.card.reason.notStorable":
      "This answer doesn't fit the Language profile. Choose one of the answers above, or change the " +
      "profile in Living Memory → Checks.",
    "projectDecisions.card.reason.tooLong": "This answer is too long to keep as a project decision.",
    "projectDecisions.card.reason.full":
      "The project can't keep any more answers. Shorten the project instructions in Living Memory, " +
      "then answer again.",
  },
  context: {
    _context: {
      description:
        "The decision log. Autopilot (an AI drafting assistant) sometimes asks the team a " +
        "question it cannot answer alone, such as 'Is Andrew older or younger than Peter?'. " +
        "The answer is added to the project instructions (the one text every AI draft reads), " +
        "or, for a fact about the language, to the 'Language profile' the checks read. The " +
        "projectDecisions.card.* strings appear on " +
        "the question card itself, in Autopilot's activity panel. Decision keys such as " +
        "'kin.andrew-peter.relative-age' and book codes such as ACT are data: never translate them.",
    },
    keys: {
      "projectDecisions.card.durable": {
        description:
          "Line on an Autopilot question card: the answer is added to the project instructions (or the " +
          "Language profile) and followed from now on.",
      },
      "projectDecisions.card.otherAnswer": {
        description: "Placeholder of a text box under the suggested answers, for an answer of the person's own.",
      },
      "projectDecisions.card.needsMaintainer": {
        description:
          "Error on a question card: this answer changes the 'Language profile' settings card, which only a " +
          "maintainer may change.",
      },
      "projectDecisions.card.reason.notStorable": {
        description:
          "Error on a question card: the typed answer is not a value the Language profile accepts. " +
          "'Language profile' is the name of a settings card.",
      },
      "projectDecisions.card.reason.tooLong": { description: "Error on a question card: the answer is too long to keep." },
      "projectDecisions.card.reason.full": {
        description:
          "Error on a question card: the project cannot keep this answer — its instructions or its decision " +
          "record is full. 'Living Memory' is the name of the page that holds the instructions.",
      },
    },
  },
  surfaces: [],
})
