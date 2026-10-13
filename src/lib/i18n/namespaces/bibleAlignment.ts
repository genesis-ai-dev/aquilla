import { defineNamespace, plural } from "./types"

/**
 * `bibleAlignment.*` (AQU-1694): word alignment for Who's Who, its own
 * module because `bibleData.ts` is already past the file-size guideline.
 *
 * Used by the Who's Who panel ("Align source text to Greek", progress, what
 * dotted highlights mean) and by a mention placed by alignment (its
 * screen-reader name and a line in its popover).
 */
export const bibleAlignment = defineNamespace({
  keys: {
    "bibleAlignment.mentionApproximateAria": "{word}: {kind}, probably {name}",
    "bibleAlignment.placedAligned": "Found in your source text by word alignment with the Greek.",
    "bibleAlignment.placedApproximate": "Approximate: the word alignment with the Greek is not sure of this word.",
    "bibleAlignment.intro":
      "Highlight each person's words in your source text and translation: align the source text to the Greek. A book takes a few seconds.",
    "bibleAlignment.askMaintainer": "A project maintainer can align the source text to the Greek from this panel.",
    "bibleAlignment.align": "Align source text to Greek",
    "bibleAlignment.alignAgain": "Align again",
    "bibleAlignment.cancel": "Cancel",
    "bibleAlignment.retry": "Try again",
    "bibleAlignment.phase.reading": "Reading the source text…",
    "bibleAlignment.phase.aligning": "Aligning to the Greek… {percent}",
    "bibleAlignment.phase.saving": "Saving the alignment… {percent}",
    "bibleAlignment.progressAria": "Alignment progress",
    "bibleAlignment.aligned": plural({
      one: "{count} verse of this book is aligned to the Greek.",
      other: "{count} verses of this book are aligned to the Greek.",
    }),
    "bibleAlignment.stale": plural({
      one: "{count} verse changed after it was aligned. Its words have no highlights until you align again.",
      other: "{count} verses changed after they were aligned. Their words have no highlights until you align again.",
    }),
    "bibleAlignment.dotted": "Dotted highlights are approximate: the alignment is less sure of those words.",
    "bibleAlignment.shortBook":
      "This book has fewer than {min} verses to learn from, so every highlight is approximate (dotted).",
    "bibleAlignment.failed.offline": "Could not align the source text: you are offline.",
    "bibleAlignment.failed.forbidden": "Only a project maintainer can align the source text.",
    "bibleAlignment.failed.failed": "Could not align the source text.",
  },
  context: {
    _context: {
      description:
        "Who's Who word alignment. 'Who's Who' highlights the words that refer to each " +
        "person in a Bible passage. When the project's source text is a Bible in another " +
        "language (e.g. English), the app links ('aligns') each of its words to the Greek " +
        "words, statistically, so the highlights can be drawn on the source text and on " +
        "the translation. 'Align' and 'alignment' mean this linking of words between two " +
        "texts, never text layout. 'Greek' is the original language of the New Testament.",
    },
    keys: {
      "bibleAlignment.mentionApproximateAria": {
        description:
          "Screen-reader name of a highlighted word in the source text that probably refers " +
          "to a person: the word alignment placed it there with low confidence.",
        placeholders: {
          word: "The word as the text spells it, e.g. 'her'.",
          kind: "How it refers to the person, e.g. 'Pronoun'.",
          name: "The person's name, e.g. 'the Samaritan woman'.",
        },
      },
      "bibleAlignment.placedAligned": {
        description: "Line in the popover of a highlighted word: how the app found this word in the source text.",
      },
      "bibleAlignment.placedApproximate": {
        description:
          "Line in the popover of a highlighted word drawn with a dotted underline: the app " +
          "is not sure this word is the one that refers to the person.",
      },
      "bibleAlignment.intro": {
        description: "Text in the Who's Who panel above the 'Align source text to Greek' button.",
      },
      "bibleAlignment.askMaintainer": {
        description:
          "Text in the Who's Who panel for people who may not run the alignment. 'Maintainer' " +
          "is a project role.",
      },
      "bibleAlignment.align": {
        description: "Button in the Who's Who panel that starts the word alignment for the open book.",
        maxLength: 32,
      },
      "bibleAlignment.alignAgain": {
        description: "Button in the Who's Who panel that runs the word alignment again for the open book.",
        maxLength: 24,
      },
      "bibleAlignment.cancel": {
        description: "Button that stops the word alignment while it runs.",
        maxLength: 16,
      },
      "bibleAlignment.retry": {
        description: "Button that starts the word alignment again after it failed.",
        maxLength: 16,
      },
      "bibleAlignment.phase.reading": {
        description: "Progress text while the app reads the book's source text before aligning it.",
      },
      "bibleAlignment.phase.aligning": {
        description: "Progress text while the app aligns the source text to the Greek.",
        placeholders: { percent: "How far along it is, e.g. '40%'." },
      },
      "bibleAlignment.phase.saving": {
        description: "Progress text while the app saves the alignment.",
        placeholders: { percent: "How far along it is, e.g. '40%'." },
      },
      "bibleAlignment.progressAria": {
        description: "Screen-reader name of the progress bar shown while the alignment runs.",
      },
      "bibleAlignment.aligned": {
        description: "Status line in the Who's Who panel: how much of the open book is aligned.",
        placeholders: { count: "A number of verses." },
      },
      "bibleAlignment.stale": {
        description:
          "Status line in the Who's Who panel: verses whose source text was edited after the " +
          "alignment ran lose their highlights until it runs again.",
        placeholders: { count: "A number of verses." },
      },
      "bibleAlignment.dotted": {
        description:
          "Explanation in the Who's Who panel of highlights drawn with a dotted underline.",
      },
      "bibleAlignment.shortBook": {
        description:
          "Note in the Who's Who panel: the book is too short for the app to be sure of its " +
          "alignment, so all of its highlights are dotted.",
        placeholders: { min: "A number of verses, e.g. 120." },
      },
      "bibleAlignment.failed.offline": {
        description: "Error in the Who's Who panel when the alignment could not run because there is no connection.",
      },
      "bibleAlignment.failed.forbidden": {
        description: "Error in the Who's Who panel when the person's role may not save the alignment.",
      },
      "bibleAlignment.failed.failed": {
        description: "Error in the Who's Who panel when the alignment failed for another reason.",
      },
    },
  },
  surfaces: [],
})
