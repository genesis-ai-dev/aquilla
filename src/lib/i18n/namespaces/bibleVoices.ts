import { defineNamespace } from "./types"

/**
 * `bibleVoices.*` (AQU-1692): the Voices follow-ups, in their own module
 * because `bibleData.ts` is already past the file-size guideline.
 *
 * A "check" marker where the Bible data is unsure who speaks, a "boundary
 * disputed" marker on the voice chip itself, a maintainer's corrections of a
 * speaker or listener, adopting the voices as a dubbing project's cast, and
 * what View settings → Bible data says when the data is not available.
 */
export const bibleVoices = defineNamespace({
  keys: {
    // ── Low confidence ──
    "bibleVoices.check.badge": "Check",
    "bibleVoices.check.disagree": "The sources disagree about who is speaking.",
    "bibleVoices.check.unknown": "No source names the speaker.",
    "bibleVoices.chip.checkAria": "{voice} (speaker needs checking)",
    "bibleVoices.chip.disputedAria": "boundary disputed",
  },
  context: {
    _context: {
      description:
        "Voices, in the translation editor of a Bible: a small chip on each verse names who speaks " +
        "to whom ('Narrator · Jesus → Samaritan woman'), and a popover gives the details. The data " +
        "comes from open datasets about the Bible text; a project's maintainer can correct it for " +
        "their project. 'Voice' here means a speaker in the text, never an audio or " +
        "text-to-speech voice.",
    },
    keys: {
      "bibleVoices.check.badge": {
        description:
          "Badge in the voice popover: the data is unsure who speaks this quotation, so the " +
          "translator should check it. An imperative or a noun, whichever is shorter.",
        maxLength: 16,
      },
      "bibleVoices.check.disagree": {
        description:
          "Under the 'Check' badge: the datasets name different speakers for this quotation.",
      },
      "bibleVoices.check.unknown": {
        description: "Under the 'Check' badge: none of the datasets says who speaks this quotation.",
      },
      "bibleVoices.chip.checkAria": {
        description:
          "Screen-reader text for one voice in the voice chip when the data is unsure who " +
          "speaks. The chip draws a small '?' after the speaker's name instead.",
        placeholders: { voice: "The voice in words, e.g. 'Orpah to Naomi' or 'Jesus'." },
      },
      "bibleVoices.chip.disputedAria": {
        description:
          "Screen-reader text added to the voice chip's list of speakers when scholars disagree " +
          "where a quotation in the verse starts or ends. Lowercase: it is read as a list item.",
      },
    },
  },
  surfaces: [],
})
