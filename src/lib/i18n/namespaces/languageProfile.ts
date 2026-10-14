import { defineNamespace } from "./types"

/**
 * `languageProfile` namespace (AQU-1691): the collapsible rows under the
 * quotation marks in the "Language profile for checks" card (Settings →
 * General → Languages). Each row records one fact about the target language:
 * its title, a plain-language description, one example, and the fields.
 *
 * The card's title, its quotation-mark rows and its save errors stay in
 * `bibleData.profile.*`.
 */
export const languageProfile = defineNamespace({
  keys: {
    // ── Row chrome ──
    "languageProfile.more.label": "More about your language",
    "languageProfile.more.description":
      "Fill in only what applies. Each answer turns on the checks and drafting help that need it.",
    "languageProfile.set": "Set",
    "languageProfile.notSet": "Not set",
    "languageProfile.example": "Example: {example}",
    "languageProfile.saved": "Saved.",
    "languageProfile.invalid": "Some of these answers can't be saved. Check each field, then save again.",
    "languageProfile.listHint": "Separate entries with commas.",
    "languageProfile.choice.yes": "Yes",
    "languageProfile.choice.no": "No",

    // ── Question markers ──
    "languageProfile.questionMarkers.title": "Question markers",
    "languageProfile.questionMarkers.description":
      "Words or word endings that make a sentence a question, besides a question mark. If your language uses only a question mark, save with both fields empty.",
    "languageProfile.questionMarkers.example": "Mandarin ends a question with 吗: 你好吗？ Finnish adds -ko to a word: Onko?",
    "languageProfile.questionMarkers.particles": "Question words",
    "languageProfile.questionMarkers.suffix": "Question endings",

    // ── Pronouns ──
    "languageProfile.pronouns.title": "Pronouns",
    "languageProfile.pronouns.description": "The differences your language makes in words such as “you”, “we” and “they”.",
    "languageProfile.pronouns.example": "Tok Pisin has yumi for “we, including you” and mipela for “we, not you”.",
    "languageProfile.pronouns.secondPerson": "Does “you” change for one person and for several people?",
    "languageProfile.pronouns.singular": "Forms for one person",
    "languageProfile.pronouns.plural": "Forms for several people",
    "languageProfile.pronouns.firstPersonPlural": "Is “we, including you” different from “we, not you”?",
    "languageProfile.pronouns.inclusive": "Forms that include the listener",
    "languageProfile.pronouns.exclusive": "Forms that leave the listener out",
    "languageProfile.pronouns.extraNumbers": "Other numbers",
    "languageProfile.pronouns.dual": "Dual (two)",
    "languageProfile.pronouns.trial": "Trial (three)",
    "languageProfile.pronouns.paucal": "Paucal (a few)",
    "languageProfile.pronouns.dualForms": "Dual forms",
    "languageProfile.pronouns.trialForms": "Trial forms",
    "languageProfile.pronouns.paucalForms": "Paucal forms",
    "languageProfile.pronouns.thirdPerson": "Do “he”, “she” and “they” mark gender or noun class?",
    "languageProfile.pronouns.thirdPersonForms": "Third-person forms",
    "languageProfile.pronouns.honorifics": "Levels of respect",
    "languageProfile.pronouns.honorificsHint": "One level on each line, as name: forms. For example, Polite: vous",

    // ── Lists ──
    "languageProfile.negators.title": "Negative words",
    "languageProfile.negators.description": "Words that make a sentence negative.",
    "languageProfile.negators.example": "French: ne, pas, jamais, rien",
    "languageProfile.speechVerbs.title": "Speech verbs",
    "languageProfile.speechVerbs.description": "Verbs that introduce what someone says.",
    "languageProfile.speechVerbs.example": "said, asked, answered, replied",

    // ── Number words ──
    "languageProfile.numberWords.title": "Number words",
    "languageProfile.numberWords.description": "How your translation writes numbers out in words.",
    "languageProfile.numberWords.example": "12 → twelve, 5000 → five thousand",
    "languageProfile.numberWords.source": "Where the words come from",
    "languageProfile.numberWords.cldr": "The standard words for this language (CLDR)",
    "languageProfile.numberWords.explicit": "Words I enter",
    "languageProfile.numberWords.words": "Numbers and words",
    "languageProfile.numberWords.wordsHint": "One on each line, as number = word. For example, 12 = twelve",

    // ── Kin terms ──
    "languageProfile.kinTerms.title": "Kin terms",
    "languageProfile.kinTerms.description": "Whether words for brother, sister and other relatives say who is older.",
    "languageProfile.kinTerms.example": "Indonesian: kakak (older sibling), adik (younger sibling)",
    "languageProfile.kinTerms.relativeAge": "Do kin terms say who is older?",
    "languageProfile.kinTerms.notes": "Notes",

    // ── Divine names ──
    "languageProfile.divineNames.title": "Names of God",
    "languageProfile.divineNames.description": "How your translation renders the names and titles of God.",
    "languageProfile.divineNames.example": "YHWH → the LORD; κύριος for Jesus → Lord",
    "languageProfile.divineNames.yhwh": "The divine name YHWH",
    "languageProfile.divineNames.kyriosGod": "κύριος (Lord) for God",
    "languageProfile.divineNames.kyriosJesus": "κύριος (Lord) for Jesus",
    "languageProfile.divineNames.capitalization": "Capitalize pronouns that refer to God?",

    // ── Policies ──
    "languageProfile.measures.title": "Measures",
    "languageProfile.measures.description": "How to render units such as cubits, talents and denarii.",
    "languageProfile.measures.example": "Convert: “about 45 metres” for “a hundred cubits”",
    "languageProfile.measures.convert": "Convert to local units",
    "languageProfile.measures.transliterate": "Keep the original unit",
    "languageProfile.measures.mixed": "Keep the unit and add a conversion",
    "languageProfile.textualVariants.title": "Textual variants",
    "languageProfile.textualVariants.description": "What to do with verses that some old manuscripts leave out.",
    "languageProfile.textualVariants.example": "Footnote: Mark 16:9–20 goes in a note",
    "languageProfile.textualVariants.omit": "Leave them out",
    "languageProfile.textualVariants.bracket": "Keep them in brackets",
    "languageProfile.textualVariants.footnote": "Put them in a footnote",
    "languageProfile.headings.title": "Section headings",
    "languageProfile.headings.description": "Whether passages have a heading above them.",
    "languageProfile.headings.example": "A heading for each passage: “Jesus feeds five thousand people”",
    "languageProfile.headings.none": "No headings",
    "languageProfile.headings.pericope": "A heading for each passage",
  },
  context: {
    _context: {
      description:
        "Rows in the 'Language profile for checks' settings card (Settings → General → " +
        "Languages), read by a project maintainer. Each row records one fact about the " +
        "language the project translates INTO: how it marks questions, its pronouns, " +
        "its negative words, how it writes numbers, how it renders the names of God, and " +
        "the project's policy for measures, manuscript variants and headings. Automatic " +
        "checks and the Autopilot drafting assistant use these facts. Rows start closed; " +
        "most projects fill in only a few. Example sentences quote real languages: keep " +
        "the quoted words (吗, yumi, kakak, YHWH, κύριος) exactly as they are.",
    },
    keys: {
      "languageProfile.more.label": {
        description: "Heading above the collapsible rows, under the quotation-mark rows of the same card.",
      },
      "languageProfile.more.description": {
        description: "One sentence under that heading: the rows are optional and each one switches features on.",
      },
      "languageProfile.set": {
        description: "Status at the end of a closed row: this fact is saved. One short word.",
        maxLength: 16,
      },
      "languageProfile.notSet": {
        description:
          "Status at the end of a closed row, and the first choice in yes/no lists: nothing is saved yet. " +
          "Short phrase.",
        maxLength: 20,
      },
      "languageProfile.example": {
        description: "A row's example line.",
        placeholders: { example: "The row's example, already translated, e.g. 'said, asked, answered, replied'." },
      },
      "languageProfile.saved": { description: "Confirmation after one row is saved." },
      "languageProfile.invalid": {
        description: "Error when a row cannot be saved because a field holds something the check cannot use.",
      },
      "languageProfile.listHint": {
        description: "Hint under a text field that takes several words: type them separated by commas.",
      },
      "languageProfile.choice.yes": { description: "Choice in a yes/no list.", maxLength: 12 },
      "languageProfile.choice.no": { description: "Choice in a yes/no list.", maxLength: 12 },
      "languageProfile.questionMarkers.title": {
        description: "Row title: the words or word endings that turn a sentence into a question.",
      },
      "languageProfile.questionMarkers.description": {
        description: "Explains the row. 'Both fields' are the question words and the question endings below.",
      },
      "languageProfile.questionMarkers.example": {
        description: "Example. Keep 吗, 你好吗？ and Onko exactly; translate the rest.",
      },
      "languageProfile.questionMarkers.particles": {
        description: "Label of a field: separate words that mark a question, such as Mandarin 吗.",
      },
      "languageProfile.questionMarkers.suffix": {
        description: "Label of a field: word endings that mark a question, such as Finnish -ko.",
      },
      "languageProfile.pronouns.title": { description: "Row title: the language's pronoun distinctions." },
      "languageProfile.pronouns.description": { description: "Explains the row." },
      "languageProfile.pronouns.example": {
        description: "Example from Tok Pisin. Keep yumi and mipela exactly.",
      },
      "languageProfile.pronouns.secondPerson": {
        description: "Yes/no question: does the word for 'you' differ between one listener and several?",
      },
      "languageProfile.pronouns.singular": { description: "Label: the words for 'you' addressed to one person." },
      "languageProfile.pronouns.plural": { description: "Label: the words for 'you' addressed to several people." },
      "languageProfile.pronouns.firstPersonPlural": {
        description:
          "Yes/no question about clusivity: does 'we' that includes the listener differ from 'we' that excludes them?",
      },
      "languageProfile.pronouns.inclusive": { description: "Label: the words for 'we' that include the listener." },
      "languageProfile.pronouns.exclusive": { description: "Label: the words for 'we' that exclude the listener." },
      "languageProfile.pronouns.extraNumbers": {
        description: "Label of three checkboxes: grammatical numbers besides singular and plural.",
      },
      "languageProfile.pronouns.dual": { description: "Checkbox: the language has a dual (forms for exactly two)." },
      "languageProfile.pronouns.trial": { description: "Checkbox: the language has a trial (forms for exactly three)." },
      "languageProfile.pronouns.paucal": { description: "Checkbox: the language has a paucal (forms for a few)." },
      "languageProfile.pronouns.dualForms": { description: "Label: the pronoun forms for exactly two." },
      "languageProfile.pronouns.trialForms": { description: "Label: the pronoun forms for exactly three." },
      "languageProfile.pronouns.paucalForms": { description: "Label: the pronoun forms for a few." },
      "languageProfile.pronouns.thirdPerson": {
        description: "Yes/no question: do third-person pronouns change with gender or noun class?",
      },
      "languageProfile.pronouns.thirdPersonForms": { description: "Label: the third-person pronoun forms." },
      "languageProfile.pronouns.honorifics": {
        description: "Label of a field listing the levels of politeness or respect that pronouns show.",
      },
      "languageProfile.pronouns.honorificsHint": {
        description: "Hint: write one level per line as 'name: forms'. Keep 'vous' as it is.",
      },
      "languageProfile.negators.title": { description: "Row title, and the label of its field: words that negate a sentence." },
      "languageProfile.negators.description": { description: "Explains the row." },
      "languageProfile.negators.example": { description: "Example from French. Keep the French words exactly." },
      "languageProfile.speechVerbs.title": {
        description: "Row title, and the label of its field: verbs such as 'said' that introduce a quotation.",
      },
      "languageProfile.speechVerbs.description": { description: "Explains the row." },
      "languageProfile.speechVerbs.example": {
        description: "Example list of English speech verbs. Translate them into the UI language's own verbs.",
      },
      "languageProfile.numberWords.title": { description: "Row title: how numbers are written as words." },
      "languageProfile.numberWords.description": { description: "Explains the row." },
      "languageProfile.numberWords.example": {
        description: "Example: digits and the words for them. Translate the words; keep the digits.",
      },
      "languageProfile.numberWords.source": { description: "Label of a choice between the two options below." },
      "languageProfile.numberWords.cldr": {
        description: "Choice: use the standard number words from CLDR (a public locale database; keep 'CLDR').",
      },
      "languageProfile.numberWords.explicit": { description: "Choice: the maintainer types the number words." },
      "languageProfile.numberWords.words": { description: "Label of a field listing numbers and their words." },
      "languageProfile.numberWords.wordsHint": {
        description: "Hint: write one 'number = word' pair per line. Translate 'twelve'; keep '12'.",
      },
      "languageProfile.kinTerms.title": { description: "Row title: words for relatives such as brother or sister." },
      "languageProfile.kinTerms.description": { description: "Explains the row." },
      "languageProfile.kinTerms.example": { description: "Example from Indonesian. Keep kakak and adik exactly." },
      "languageProfile.kinTerms.relativeAge": {
        description: "Yes/no question: must a kin term say whether the relative is older or younger?",
      },
      "languageProfile.kinTerms.notes": { description: "Label of a free-text field for anything else about kin terms." },
      "languageProfile.divineNames.title": { description: "Row title: how the names and titles of God are rendered." },
      "languageProfile.divineNames.description": { description: "Explains the row." },
      "languageProfile.divineNames.example": {
        description: "Example. Keep YHWH and κύριος exactly; translate 'the LORD' and 'Lord' as a Bible in the UI language would.",
      },
      "languageProfile.divineNames.yhwh": {
        description: "Label of a field: the rendering of YHWH, the Hebrew divine name. Keep 'YHWH'.",
      },
      "languageProfile.divineNames.kyriosGod": {
        description: "Label of a field: the rendering of the Greek word κύριος when it refers to God. Keep 'κύριος'.",
      },
      "languageProfile.divineNames.kyriosJesus": {
        description: "Label of a field: the rendering of the Greek word κύριος when it refers to Jesus. Keep 'κύριος'.",
      },
      "languageProfile.divineNames.capitalization": {
        description: "Yes/no question: do pronouns that refer to God (He, His) start with a capital letter?",
      },
      "languageProfile.measures.title": { description: "Row title: how ancient units of measure are rendered." },
      "languageProfile.measures.description": { description: "Explains the row." },
      "languageProfile.measures.example": { description: "Example of the 'convert' choice. Use the UI language's units." },
      "languageProfile.measures.convert": { description: "Choice: replace an ancient unit with a modern local one." },
      "languageProfile.measures.transliterate": { description: "Choice: keep the ancient unit's name." },
      "languageProfile.measures.mixed": { description: "Choice: keep the ancient unit and add the modern equivalent." },
      "languageProfile.textualVariants.title": {
        description: "Row title: verses that appear in some ancient manuscripts but not in others.",
      },
      "languageProfile.textualVariants.description": { description: "Explains the row." },
      "languageProfile.textualVariants.example": { description: "Example of the 'footnote' choice." },
      "languageProfile.textualVariants.omit": { description: "Choice: leave such verses out of the translation." },
      "languageProfile.textualVariants.bracket": { description: "Choice: keep such verses, inside brackets." },
      "languageProfile.textualVariants.footnote": { description: "Choice: move such verses into a footnote." },
      "languageProfile.headings.title": { description: "Row title: section headings above Bible passages." },
      "languageProfile.headings.description": { description: "Explains the row." },
      "languageProfile.headings.example": { description: "Example of a section heading." },
      "languageProfile.headings.none": { description: "Choice: the translation has no section headings." },
      "languageProfile.headings.pericope": { description: "Choice: each passage (pericope) has its own heading." },
    },
  },
  surfaces: [],
})
