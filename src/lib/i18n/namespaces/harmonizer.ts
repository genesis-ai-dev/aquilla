import { defineNamespace } from "./types"

export const harmonizer = defineNamespace({
  keys: {
    "harmonizer.flagLabel": "Harmonizer",
    "harmonizer.flagDescription":
      "Check how cells fit together as a text, starting with quotations that open in one verse and never close. Suggestions appear beside smart edits, so smart edits must be on too.",
    "harmonizer.popoverNote": "Checked across verses against the source by Jev.",
    "harmonizer.quotes.closeHere":
      "The quotation that opens in {openedIn} ends here in the source, so close it at the end of this verse.",
    "harmonizer.reference.unclearSubject":
      "Someone new does this in the source, but a reader coming from {previous} may think it is the same person. Consider naming who it is.",
    "harmonizer.sentence.brokenCase":
      "This verse ends its sentence here, but {next} carries on in lowercase. Either the sentence continues or the next verse needs a capital.",
    "harmonizer.sentence.brokenOff":
      "In the source this sentence carries on into {next}, and here the translation stops before the sentence is complete.",
    "harmonizer.sentence.runOn":
      "The source sentence ends in this verse and {next} starts a new one, but the translation has no closing punctuation here.",
    "harmonizer.reference.impliedSubject":
      "Someone new does this in the source, but the translation leaves it unstated, so a reader coming from {previous} may assume the same person. Consider naming who it is.",
  },
  context: {
    _context: {
      description:
        "Harmonizer: suggestions about how neighbouring cells fit together as one text " +
        "(quotations, references to people, connectives). They appear as underlines in the " +
        "target editor and open the same small Accept / Dismiss card as smart edits.",
    },
    keys: {
      "harmonizer.flagLabel": { description: "Toggle label in Project settings → Experimental.", maxLength: 32 },
      "harmonizer.popoverNote": {
        description: "Small note under a harmonizer suggestion. Jev is a fast classifier model; keep the name untranslated.",
      },
      "harmonizer.reference.unclearSubject": {
        description:
          "Reason on an underlined word that refers to who acts in this verse. In the source a " +
          "different person or group acts than in the previous verse, but the translation's wording " +
          "would lead a reader to assume the same one. No automatic fix is offered.",
        placeholders: { previous: "Reference of the previous verse, e.g. 'JHN 6:27'." },
      },
      "harmonizer.reference.impliedSubject": {
        description:
          "Same as the reason above, for when the translation does not state who acts at all " +
          "(it is only implied by the verb).",
        placeholders: { previous: "Reference of the previous verse, e.g. 'JHN 6:27'." },
      },
      "harmonizer.sentence.brokenCase": {
        description:
          "Reason on the last word of a verse that ends with a full stop while the next verse starts " +
          "with a lowercase letter. No automatic fix: either the stop or the capital is wrong.",
        placeholders: { next: "Reference of the next verse, e.g. 'LUK 5:4'." },
      },
      "harmonizer.sentence.brokenOff": {
        description:
          "Reason on the last word of a verse whose translation ends with a full stop in the middle " +
          "of a sentence that the source continues into the next verse. No automatic fix.",
        placeholders: { next: "Reference of the next verse." },
      },
      "harmonizer.sentence.runOn": {
        description:
          "Reason on a suggestion that adds the project's usual full stop at the end of a verse " +
          "whose sentence ends there in the source.",
        placeholders: { next: "Reference of the next verse." },
      },
      "harmonizer.quotes.closeHere": {
        description:
          "Reason shown on a suggestion that adds a closing quotation mark. The source text " +
          "(e.g. Greek) has no quotation marks, so the speech's end was found by reading it.",
        placeholders: { openedIn: "Verse reference where the quotation opens, e.g. 'JHN 6:26'." },
      },
    },
  },
  surfaces: [],
})
