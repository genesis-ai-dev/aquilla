import { defineNamespace, plural } from "./types"

/**
 * `bibleHelps.*` (AQU-1695): what Bible Knowledge Pack 1.1 adds to the
 * editor, in its own module because `bibleData.ts` is already past the
 * file-size guideline.
 *
 * The cell's Context tab gains Translation Notes (numbered, with their words
 * highlighted in the tab's Greek word list), Translation Questions, key-term
 * chips, and the words a pronoun's chain went through ("via λέγων"). The Who's
 * Who popover and panel gain a person's family, and the voice popover a badge
 * for a speech whose boundary is disputed. Pack ids reach these keys through
 * the typed tables in src/components/bible-data/helps-text.ts.
 */
export const bibleHelps = defineNamespace({
  keys: {
    // ── Translation Notes in the Context tab ──
    "bibleHelps.notes.otherHeading": plural({
      one: "Notes on this verse",
      other: "Notes on these verses",
    }),
    "bibleHelps.notes.numberSrOnly": "Note {number}",
    "bibleHelps.notes.wordSrOnly": plural({
      one: "Discussed in note {numbers}",
      other: "Discussed in notes {numbers}",
    }),
    "bibleHelps.notes.unavailable.offline": "Translation Notes for this book are not available offline yet.",
    "bibleHelps.notes.unavailable.invalid": "The Translation Notes for this book could not be read.",
    "bibleHelps.verseRange": "Verses {range}",

    // ── Translation Academy categories, the chip on each note ──
    "bibleHelps.category.other": "Translation note",
    "bibleHelps.category.figsExplicit": "Assumed knowledge and implicit information",
    "bibleHelps.category.figsMetaphor": "Metaphor",
    "bibleHelps.category.figsActivePassive": "Active or passive",
    "bibleHelps.category.figsAbstractNouns": "Abstract nouns",
    "bibleHelps.category.figsIdiom": "Idiom",
    "bibleHelps.category.figsMetonymy": "Metonymy",
    "bibleHelps.category.writingPronouns": "Pronouns: when to use them",
    "bibleHelps.category.grammarConnectLogicResult": "Connect: reason and result",
    "bibleHelps.category.translateUnknown": "Translate unknowns",
    "bibleHelps.category.grammarConnectWordsPhrases": "Connecting words and phrases",
    "bibleHelps.category.figsPossession": "Possession",
    "bibleHelps.category.figsEllipsis": "Ellipsis",
    "bibleHelps.category.figsRquestion": "Rhetorical question",
    "bibleHelps.category.figsNominalAdj": "Nominal adjectives",
    "bibleHelps.category.figsGenderNotations": "When masculine words include women",
    "bibleHelps.category.translateNames": "How to translate names",
    "bibleHelps.category.figsDoublet": "Doublet",
    "bibleHelps.category.writingQuotations": "Quotations and quote margins",
    "bibleHelps.category.figsSynecdoche": "Synecdoche",
    "bibleHelps.category.figsExclusive": "Exclusive and inclusive “we”",
    "bibleHelps.category.figsPastForFuture": "Predictive past",
    "bibleHelps.category.guidelinesSonOfGod": "Translating Son and Father",

    // ── Translation Questions in the Context tab ──
    "bibleHelps.questions.heading": "Translation questions",

    // ── Key terms in the Context tab ──
    "bibleHelps.terms.chipAria": "Key term: {title}",
    "bibleHelps.terms.fromTw": "From unfoldingWord Translation Words",
    "bibleHelps.terms.fromAcai": "From the ACAI key terms",
    "bibleHelps.terms.traditionalCharacters": "In Traditional characters",

    // ── The chain behind a pronoun, in the Context tab ──
    "bibleHelps.context.via": "via {words}",
    "bibleHelps.context.viaWord": "{word} ({gloss})",

    // ── Who's Who: a person's family ──
    "bibleHelps.kin.father": "Father",
    "bibleHelps.kin.mother": "Mother",
    "bibleHelps.kin.siblings": plural({ one: "Sibling", other: "Siblings" }),
    "bibleHelps.kin.partners": plural({ one: "Spouse", other: "Spouses" }),
    "bibleHelps.kin.offspring": plural({ one: "Child", other: "Children" }),
    "bibleHelps.kin.goToAria": "Go to the first mention of {name}, {ref}",

    // ── Voices: a disputed speech boundary ──
    "bibleHelps.voices.disputed": "Boundary disputed",
  },
  context: {
    _context: {
      description:
        "Bible translation helps in the editor. A cell's 'Context' tab shows the verse's Greek " +
        "words with their English glosses. Translation Notes and Translation Questions are " +
        "published unfoldingWord resources that explain a verse to translators; their own text " +
        "is English data and is not translated here. 'Key terms' are important Bible words " +
        "(from unfoldingWord Translation Words and ACAI). 'Who's Who' follows the people in a " +
        "passage; 'voices' are the speakers of quoted speech.",
    },
    keys: {
      "bibleHelps.notes.otherHeading": {
        description:
          "Heading in the Context tab above the notes whose words cannot be pointed to in the " +
          "Greek (they are not highlighted). The form follows how many verses the cell holds.",
      },
      "bibleHelps.notes.numberSrOnly": {
        description:
          "Screen-reader text for the small number badge on a Translation Note. The same " +
          "number marks the note's Greek words in the word list above.",
        placeholders: { number: "The note's number in this cell, e.g. 2." },
      },
      "bibleHelps.notes.wordSrOnly": {
        description:
          "Screen-reader text after a highlighted Greek word in the Context tab: which " +
          "numbered Translation Notes discuss this word. The form follows how many notes.",
        placeholders: { numbers: "The notes' numbers as a list, e.g. '1 and 3'." },
      },
      "bibleHelps.notes.unavailable.offline": {
        description: "Shown in the Context tab when the notes could not load because there is no connection.",
      },
      "bibleHelps.notes.unavailable.invalid": {
        description: "Shown in the Context tab when the downloaded notes file is damaged.",
      },
      "bibleHelps.verseRange": {
        description: "Small label on a note or question that covers several verses.",
        placeholders: { range: "A Bible reference range, e.g. 'JHN 4:14–15'." },
      },
      "bibleHelps.category.other": {
        description:
          "Chip on a Translation Note whose Translation Academy topic has no name in the app. " +
          "The other 'bibleHelps.category' keys name unfoldingWord Translation Academy articles.",
        maxLength: 40,
      },
      "bibleHelps.category.figsExclusive": {
        description: "Translation Academy article name: whether 'we' includes the listener or not.",
      },
      "bibleHelps.category.figsPastForFuture": {
        description: "Translation Academy article name: a past or present verb form used for a future event.",
      },
      "bibleHelps.category.guidelinesSonOfGod": {
        description: "Translation Academy article name: how to translate 'Son of God' and 'God the Father'.",
      },
      "bibleHelps.questions.heading": {
        description:
          "Heading in the Context tab above the Translation Questions: comprehension questions " +
          "with answers, used to check that a translation communicates the verse.",
      },
      "bibleHelps.terms.chipAria": {
        description: "Screen-reader name of a key-term chip next to a Greek word in the Context tab.",
        placeholders: { title: "The key term's title, e.g. 'Samaria'." },
      },
      "bibleHelps.terms.fromTw": {
        description: "Line in a key term's popover: the term is a Translation Words article.",
      },
      "bibleHelps.terms.fromAcai": {
        description: "Line in a key term's popover: the term comes from ACAI's list of key terms.",
      },
      "bibleHelps.terms.traditionalCharacters": {
        description:
          "Line in a key term's popover, for Chinese only: the data has the term's title in " +
          "Traditional characters but not in Simplified ones, so a Simplified Chinese interface " +
          "shows the Traditional title.",
      },
      "bibleHelps.context.via": {
        description:
          "After a Greek word that refers to a person, in the Context tab: the words the data " +
          "followed to reach that person. Example: 'αὐτόν → Jesus, via λέγων (saying)'.",
        placeholders: { words: "One Greek word or more, each with its gloss, e.g. 'λέγων (saying)'." },
      },
      "bibleHelps.context.viaWord": {
        description: "One Greek word with its English gloss, inside the 'via' text.",
        placeholders: { word: "A Greek word, e.g. 'λέγων'.", gloss: "Its English gloss, e.g. 'saying'." },
      },
      "bibleHelps.kin.father": {
        description: "Label before a person's father in the Who's Who popover and panel.",
      },
      "bibleHelps.kin.mother": {
        description: "Label before a person's mother in the Who's Who popover and panel.",
      },
      "bibleHelps.kin.siblings": {
        description:
          "Label before a person's brothers and sisters in the Who's Who popover and panel. " +
          "The form follows how many are listed.",
      },
      "bibleHelps.kin.partners": {
        description:
          "Label before a person's husband or wife in the Who's Who popover and panel. " +
          "The form follows how many are listed.",
      },
      "bibleHelps.kin.offspring": {
        description:
          "Label before a person's sons and daughters in the Who's Who popover and panel. " +
          "The form follows how many are listed.",
      },
      "bibleHelps.kin.goToAria": {
        description: "Screen-reader name of a relative's name: it scrolls to their first mention in the book.",
        placeholders: { name: "The relative's name, e.g. 'Joseph'.", ref: "A Bible reference, e.g. 'JHN 4:5'." },
      },
      "bibleHelps.voices.disputed": {
        description:
          "Badge in the voice popover: scholars disagree where this quoted speech starts or ends " +
          "(for example, whether John 3:16–21 is still Jesus speaking).",
        maxLength: 32,
      },
    },
  },
  surfaces: [],
})
