import { defineNamespace, plural } from "./types"

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

    // ── A maintainer's corrections ──
    "bibleVoices.override.correct": "Correct speaker or listener",
    "bibleVoices.override.edit": "Edit correction",
    "bibleVoices.override.correctedBy": "Corrected by {name} on {date}",
    "bibleVoices.override.original": "Bible data: {reading}",
    "bibleVoices.override.dialogTitle": "Correct the speech at {ref}",
    "bibleVoices.override.dialogDescription":
      "Your correction replaces the Bible data's speaker or listener for everyone in this project. The Bible data itself does not change.",
    "bibleVoices.override.speaker": "Speaker",
    "bibleVoices.override.addressee": "Listener",
    "bibleVoices.override.keepPack": "As in the Bible data ({name})",
    "bibleVoices.override.keepPackNobody": "As in the Bible data (nobody named)",
    "bibleVoices.override.note": "Reason",
    "bibleVoices.override.notePlaceholder": "Why this reading? Everyone in the project sees it.",
    "bibleVoices.override.save": "Save correction",
    "bibleVoices.override.remove": "Remove correction",
    "bibleVoices.override.failed.offline": "You're offline. Reconnect to save the correction.",
    "bibleVoices.override.failed.role": "Only maintainers can correct who is speaking.",
    "bibleVoices.override.failed.conflict": "Someone changed the project settings at the same time. Try again.",
    "bibleVoices.override.failed.error": "The correction could not be saved. Try again.",

    // ── Adopt as cast ──
    "bibleVoices.cast.adopt": "Adopt voices as cast",
    "bibleVoices.cast.dialogTitle": "Adopt the voices as the cast?",
    "bibleVoices.cast.dialogDescription":
      "Each line that one voice reads gets that voice's name as its character. The narrator counts as a voice. Lines with more than one voice are left for you to assign.",
    "bibleVoices.cast.scope": "Lines to adopt",
    "bibleVoices.cast.scopeChapter": "Only {chapter}",
    "bibleVoices.cast.scopeFile": "The whole file",
    "bibleVoices.cast.willAssign": plural({
      one: "{count} line gets a character.",
      other: "{count} lines get a character.",
    }),
    "bibleVoices.cast.skippedSeveral": plural({
      one: "{count} line has more than one voice:",
      other: "{count} lines have more than one voice:",
    }),
    "bibleVoices.cast.skippedUnnamed": plural({
      one: "{count} line's voice has no name in the Bible data:",
      other: "{count} lines' voices have no name in the Bible data:",
    }),
    "bibleVoices.cast.skippedApproximate": plural({
      one: "{count} line shares its verse with another line:",
      other: "{count} lines share their verse with another line:",
    }),
    "bibleVoices.cast.keptExisting": plural({
      one: "{count} line already has a character, which stays:",
      other: "{count} lines already have a character, which stays:",
    }),
    "bibleVoices.cast.confirm": plural({
      one: "Adopt {count} line",
      other: "Adopt {count} lines",
    }),
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
      "bibleVoices.override.correct": {
        description:
          "Link in the voice popover, shown to a project's maintainers: opens a dialog to change who " +
          "speaks this quotation, or to whom, for this project.",
      },
      "bibleVoices.override.edit": {
        description: "Link in the voice popover on a quotation the project has already corrected: change or remove the correction.",
      },
      "bibleVoices.override.correctedBy": {
        description: "In the voice popover: this quotation's speaker or listener is the project's correction, not the Bible data's.",
        placeholders: { name: "The username of the maintainer who corrected it.", date: "The date, already formatted." },
      },
      "bibleVoices.override.original": {
        description: "In the voice popover, under a correction: what the Bible data said before the project corrected it.",
        placeholders: { reading: "Who spoke, or who spoke to whom, e.g. 'Orpah to Naomi'." },
      },
      "bibleVoices.override.dialogTitle": {
        description: "Title of the dialog in which a maintainer corrects one quotation's speaker or listener.",
        placeholders: { ref: "The Bible reference where the quotation starts, e.g. 'RUT 1:10'." },
      },
      "bibleVoices.override.dialogDescription": {
        description: "Under the title of the correction dialog: who sees the correction, and that the shared data is untouched.",
      },
      "bibleVoices.override.speaker": { description: "Label of the list of people who could be speaking the quotation.", maxLength: 24 },
      "bibleVoices.override.addressee": {
        description: "Label of the list of people the quotation could be spoken to. The same word as the popover's 'Listener'.",
        maxLength: 24,
      },
      "bibleVoices.override.keepPack": {
        description: "First choice in the speaker or listener list: no correction, keep what the Bible data says.",
        placeholders: { name: "The name the Bible data gives, e.g. 'Orpah'." },
      },
      "bibleVoices.override.keepPackNobody": {
        description: "First choice in the listener list when the Bible data names no listener: no correction.",
      },
      "bibleVoices.override.note": { description: "Label of the required text box: why the maintainer chose this reading.", maxLength: 24 },
      "bibleVoices.override.notePlaceholder": { description: "Hint inside the reason box of the correction dialog." },
      "bibleVoices.override.save": { description: "Button that saves the correction.", maxLength: 24 },
      "bibleVoices.override.remove": {
        description: "Button that removes the project's correction, so the Bible data's reading shows again.",
        maxLength: 24,
      },
      "bibleVoices.override.failed.offline": { description: "In the correction dialog when there is no connection." },
      "bibleVoices.override.failed.role": { description: "In the correction dialog when the server refused because the person is not a maintainer." },
      "bibleVoices.override.failed.conflict": {
        description: "In the correction dialog when another person saved project settings at the same moment.",
      },
      "bibleVoices.override.failed.error": { description: "In the correction dialog when saving failed for another reason." },
      "bibleVoices.cast.adopt": {
        description:
          "Link in the voice popover, for maintainers of dubbing projects: use the Bible data's speakers as " +
          "the characters ('cast') of the lines, as a character sheet would.",
      },
      "bibleVoices.cast.dialogTitle": { description: "Title of the confirm dialog for adopting the voices as the cast." },
      "bibleVoices.cast.dialogDescription": {
        description: "Under the title: which lines get a character name, and that lines with several speakers are skipped.",
      },
      "bibleVoices.cast.scope": { description: "Screen-reader name of the choice between one chapter and the whole file." },
      "bibleVoices.cast.scopeChapter": {
        description: "Choice: adopt only this chapter's lines.",
        placeholders: { chapter: "A book and chapter, e.g. 'RUT 1'." },
      },
      "bibleVoices.cast.scopeFile": { description: "Choice: adopt the lines of the whole open file (a Bible book)." },
      "bibleVoices.cast.willAssign": {
        description: "How many lines will get a character name.",
        placeholders: { count: "A number of lines." },
      },
      "bibleVoices.cast.skippedSeveral": {
        description: "Heading of a list of skipped lines: more than one person speaks in each. Ends with a colon before the list.",
        placeholders: { count: "A number of lines." },
      },
      "bibleVoices.cast.skippedUnnamed": {
        description: "Heading of a list of skipped lines: the data does not say who speaks them.",
        placeholders: { count: "A number of lines." },
      },
      "bibleVoices.cast.skippedApproximate": {
        description:
          "Heading of a list of skipped lines: each holds part of a verse that another line also covers, so " +
          "who speaks in that line is not known exactly.",
        placeholders: { count: "A number of lines." },
      },
      "bibleVoices.cast.keptExisting": {
        description: "Heading of a list of lines that already have a character name; adopting does not change them.",
        placeholders: { count: "A number of lines." },
      },
      "bibleVoices.cast.confirm": {
        description: "Confirm button: write the character names.",
        placeholders: { count: "A number of lines." },
        maxLength: 32,
      },
    },
  },
  surfaces: [],
})
