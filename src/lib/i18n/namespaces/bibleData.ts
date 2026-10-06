import { defineNamespace } from "./types"

/**
 * `bibleData` namespace (AQU-1686): the Bible data enrichments inside the
 * "Bible data" card in Settings → General, and its Data sources dialog.
 *
 * The card's title, switch label and description are `bibleData.card.*` while
 * the experimental switch is on, and the old `projectSettings.bible.*`
 * "Bible resources" strings while it is off (src/lib/bible-data/experiment.ts).
 * The hints under the switch stay in `projectSettings.bible.*` either way.
 * Enrichment ids map to these keys through the typed tables in
 * src/lib/bible-data/enrichment-labels.ts.
 *
 * AQU-1688 adds `bibleData.check.*` (the Bible data checks: their rows in
 * Rules → Built-in checks, and each finding's explanation and evidence, keyed
 * from reason codes in src/lib/bible-data/check-messages.ts) and
 * `bibleData.profile.*` (the "Language profile for checks" card).
 */
export const bibleData = defineNamespace({
  keys: {
    // ── Experimental switch (Project settings → Experimental, AQU-1685) ──
    "bibleData.experiment.label": "Bible data enrichments",
    "bibleData.experiment.description":
      "Shows Bible data while a Bible book is open: who speaks to whom, who is who, original-language context, translation helps and Bible data checks. Only on this device.",

    // ── Card heading and main switch, while the experimental switch is on ──
    "bibleData.card.title": "Bible data",
    "bibleData.card.enableLabel": "Enable Bible data",
    "bibleData.card.description":
      "Bible reference data from bibletranslation.org, built from Macula, OpenText, ACAI and unfoldingWord. It powers Verse Resources, Bible search, the agent's Bible lookups and the enrichments below.",

    // ── Enrichment rows (one label + one sentence each) ──
    "bibleData.enrichment.voices.label": "Voices",
    "bibleData.enrichment.voices.description":
      "Shows who speaks to whom in each cell, with rails that mark where a quotation opens and closes.",
    "bibleData.enrichment.whosWho.label": "Who's Who",
    "bibleData.enrichment.whosWho.description":
      "Follows each person through the passage, including the pronouns and implied subjects that refer to them.",
    "bibleData.enrichment.structure.label": "Passage structure",
    "bibleData.enrichment.structure.description":
      "Shows section titles, question and command markers, and verses that some manuscripts leave out.",
    "bibleData.enrichment.originalContext.label": "Original-language context",
    "bibleData.enrichment.originalContext.description":
      "Adds a Context tab with the Greek or Hebrew words, their glosses, and who each pronoun refers to.",
    "bibleData.enrichment.helps.label": "Translation helps",
    "bibleData.enrichment.helps.description":
      "Shows Translation Notes and Translation Questions next to the words and verses they discuss.",
    "bibleData.enrichment.terms.label": "Key terms",
    "bibleData.enrichment.terms.description":
      "Marks key terms in the source text and links each one to its Translation Words article.",
    "bibleData.enrichment.places.label": "Places and maps",
    "bibleData.enrichment.places.description":
      "Shows a short description and a map for each place that a passage names.",
    "bibleData.enrichment.checks.label": "Bible data checks",
    "bibleData.enrichment.checks.description":
      "Checks translations against known facts, such as who is speaking and where a quotation ends.",
    "bibleData.enrichment.autopilot.label": "Autopilot uses Bible data",
    "bibleData.enrichment.autopilot.description":
      "Gives Autopilot these facts while it drafts, and checks its drafts against them.",

    // ── Row chrome ──
    "bibleData.enrichment.sourceChip": "{sources} · {license}",
    "bibleData.enrichment.switchOffReason": "Turn on Bible data to use these enrichments.",
    "bibleData.enrichment.autopilotOffReason":
      "Autopilot is off for this project. Turn it on under Experimental first.",
    "bibleData.enrichment.openBuiltinChecks": "Open built-in checks",

    // ── Data sources dialog ──
    "bibleData.sources.open": "Data sources",
    "bibleData.sources.title": "Bible data sources",
    "bibleData.sources.description":
      "Bible data comes from bibletranslation.org, which builds it from these open datasets. Each dataset keeps its own license.",
    "bibleData.source.macula.name": "Macula Greek/Hebrew (Clear-Bible)",
    "bibleData.source.macula.short": "Macula",
    "bibleData.source.opentext.name": "OpenText context-annotation",
    "bibleData.source.opentext.short": "OpenText",
    "bibleData.source.speakerQuotations.name": "Clear speaker-quotations",
    "bibleData.source.speakerQuotations.short": "Clear quotations",
    "bibleData.source.acai.name": "ACAI (BibleAquifer)",
    "bibleData.source.acai.short": "ACAI",
    "bibleData.source.unfoldingword.name": "unfoldingWord TN/TQ/TW",
    "bibleData.source.unfoldingword.short": "unfoldingWord",

    // ── Bible data checks (AQU-1688): Rules → Built-in checks rows ──
    "bibleData.check.v1.name": "Quotation opens",
    "bibleData.check.v1.description":
      "Where a speech starts in a verse, the translation has the opening quotation mark for its level.",
    "bibleData.check.v2.name": "Quotation closes",
    "bibleData.check.v2.description":
      "Where a speech ends in a verse, the translation closes the quotation there, before any narration that follows.",
    "bibleData.check.v3.name": "Quotation continues",
    "bibleData.check.v3.description":
      "Where a speech goes on into the next verse, the translation does not close the quotation early.",
    "bibleData.check.v5.name": "Nested quotation marks",
    "bibleData.check.v5.description":
      "A quotation inside a quotation uses the marks the Language profile sets for its level.",
    "bibleData.check.v7.name": "Quotation marks without speech",
    "bibleData.check.v7.description":
      "Flags quotation marks in a verse where nobody speaks. Short titles and scare quotes are allowed.",
    "bibleData.check.v8.name": "Interrupted quotation",
    "bibleData.check.v8.description":
      "Where the narrator interrupts a speech, the quotation closes before the interruption and reopens after it.",
    "bibleData.check.v9.name": "Speaker's own framing",
    "bibleData.check.v9.description":
      "Words a speaker introduces with “I tell you that …” are part of that speech and need no extra quotation level.",
    "bibleData.check.m1.name": "Question kept",
    "bibleData.check.m1.description":
      "Where the source asks a question, the translation has a question mark or a question marker.",
    "bibleData.check.needs.quoteMarks": "Needs: quotation marks in Language profile",
    "bibleData.check.needs.questionMarkers": "Needs: question markers in Language profile",

    // ── Bible data checks: one finding, explained (Issues tab, findings drawer) ──
    "bibleData.check.reason.openMissing":
      "A speech starts in this verse, but the translation has no opening quotation mark for it (level {level}).",
    "bibleData.check.reason.closeMissing":
      "A speech ends in this verse, but the translation has no closing quotation mark for it (level {level}).",
    "bibleData.check.reason.closeAfterAside":
      "The quotation closes after the narration that follows it. Close it before that narration.",
    "bibleData.check.reason.closeInContinuingSpeech":
      "The speech goes on into the next verse, so the quotation should stay open here (level {level}).",
    "bibleData.check.reason.wrongLevelMarks":
      "A quotation inside a quotation (level {level}) uses the wrong marks. The Language profile sets {open} {close} for this level.",
    "bibleData.check.reason.marksWithoutSpeech":
      "Nobody speaks in this verse, but the translation has quotation marks.",
    "bibleData.check.reason.interruptionNotMarked":
      "The narrator interrupts this speech, so the quotation usually closes before the interruption and opens again after it.",
    "bibleData.check.reason.selfProjectionAddsLevel":
      "These words belong to the speaker's own speech (“I tell you that …”), so they need no extra quotation marks.",
    "bibleData.check.reason.questionMarkMissing":
      "The source asks a question in this verse, but the translation has no question mark or question marker.",
    "bibleData.check.evidence.speech":
      "{dataset} speech {ref} words {from}–{to}; speaker from {sources} (confidence {confidence})",
    "bibleData.check.evidence.speechAcrossVerses":
      "{dataset} speech {startRef} word {from} to {endRef} word {to}; speaker from {sources} (confidence {confidence})",
    "bibleData.check.evidence.speechNoSpeaker": "{dataset} speech {ref} words {from}–{to}",
    "bibleData.check.evidence.speechAcrossVersesNoSpeaker":
      "{dataset} speech {startRef} word {from} to {endRef} word {to}",
    "bibleData.check.evidence.noSpeech": "{dataset}: no speech in {refs}",
    "bibleData.check.evidence.question": "{dataset}: {refs} asks a question",
    "bibleData.check.evidence.approximate":
      "Approximate: this verse is split across cells, so only facts about the whole verse are checked.",

    // ── Language profile for checks (Settings → General → Languages) ──
    "bibleData.profile.title": "Language profile for checks",
    "bibleData.profile.description":
      "Facts about your language that Bible data checks need. A check stays off until the facts it needs are filled in.",
    "bibleData.profile.quoteMarks.label": "Quotation marks",
    "bibleData.profile.quoteMarks.description":
      "The marks your translation uses for a quotation, for a quotation inside it, and for one inside that.",
    "bibleData.profile.quoteMarks.level1": "Quotation",
    "bibleData.profile.quoteMarks.level2": "Inside a quotation",
    "bibleData.profile.quoteMarks.level3": "Third level",
    "bibleData.profile.quoteMarks.openAriaLabel": "Opening mark: {level}",
    "bibleData.profile.quoteMarks.closeAriaLabel": "Closing mark: {level}",
    "bibleData.profile.continuation.label": "A quotation over several paragraphs",
    "bibleData.profile.continuation.reopenEachParagraph": "Repeat the opening mark at each new paragraph",
    "bibleData.profile.continuation.continuationMark": "Start each new paragraph with the closing mark",
    "bibleData.profile.continuation.none": "No mark at a new paragraph",
    "bibleData.profile.useDefaults": "Use defaults for {language}",
    "bibleData.profile.save": "Save quotation marks",
    "bibleData.profile.clear": "Clear quotation marks",
    "bibleData.profile.notSet": "Not set. The quotation checks stay off until you save the marks your translation uses.",
    "bibleData.profile.saved": "Quotation marks saved.",
    "bibleData.profile.invalid":
      "Each mark is one punctuation character. The first level needs both marks; a deeper level needs both or neither.",
    "bibleData.profile.error.conflict": "Someone else changed the project settings. Refresh, then save again.",
    "bibleData.profile.error.offline": "You're offline. Reconnect to save the Language profile.",
    "bibleData.profile.error.permission": "Only a maintainer can change the Language profile.",
    "bibleData.profile.error.failed": "The Language profile could not be saved.",
  },
  context: {
    _context: {
      description:
        "The 'Bible data' card in project Settings → General: a list of optional " +
        "Bible data features ('enrichments') under the card's main switch, and a " +
        "dialog that credits the open datasets the data comes from. Read by a " +
        "project maintainer deciding what translators see. Dataset and organization " +
        "names (Macula, Clear-Bible, OpenText, ACAI, BibleAquifer, unfoldingWord, " +
        "bibletranslation.org) are proper names: keep them in Latin script, untranslated. " +
        "The bibleData.check.* keys are automatic checks that compare a translation " +
        "with these Bible data (Rules → Built-in checks, and the findings shown on a " +
        "cell). The bibleData.profile.* keys are the 'Language profile for checks' " +
        "card, where a maintainer records facts about the target language, such as its " +
        "quotation marks, that the checks need.",
    },
    keys: {
      "bibleData.experiment.label": {
        description:
          "Name of a switch in Project settings → Experimental. It shows the Bible " +
          "data features (the enrichments) on this device only. 'Enrichments' are " +
          "optional extra Bible data features, not a financial or chemical term.",
      },
      "bibleData.experiment.description": {
        description:
          "Explanation under the Bible data enrichments switch in Project settings → " +
          "Experimental. 'A Bible book is open' means a Bible book file is open in " +
          "the editor. 'Only on this device' means collaborators are not affected.",
      },
      "bibleData.card.title": {
        description:
          "Title of the settings card that turns Bible reference data on or off for " +
          "the project, shown while the Bible data enrichments experiment is on. " +
          "Without the experiment the same card is titled 'Bible resources' " +
          "(projectSettings.section.bibleResources).",
      },
      "bibleData.card.enableLabel": {
        description:
          "Label of the main switch in the Bible data card. Turning it off turns off " +
          "every Bible data feature listed under it.",
      },
      "bibleData.card.description": {
        description:
          "Explanation under the Bible data switch. bibletranslation.org, Macula, " +
          "OpenText, ACAI and unfoldingWord are proper names: keep them untranslated. " +
          "Verse Resources is the name of a side panel; 'Bible search' is the Bible " +
          "mode of the Search panel; 'the enrichments below' are the switches listed " +
          "under this one.",
      },
      "bibleData.enrichment.voices.label": {
        description:
          "Name of the enrichment that labels each Bible cell with its speaker and " +
          "addressee ('Jesus → Samaritan woman'). 'Voices' means people speaking in " +
          "the Bible text, NOT text-to-speech voices or audio recordings.",
      },
      "bibleData.enrichment.voices.description": {
        description:
          "One-sentence explanation under the Voices switch. A 'rail' is a thin " +
          "vertical line at the edge of the cell that shows a quotation continuing.",
      },
      "bibleData.enrichment.whosWho.label": {
        description:
          "Name of the enrichment that links every mention of the same person " +
          "across cells. Use a natural phrase for 'who is who' in the passage.",
      },
      "bibleData.enrichment.whosWho.description": {
        description:
          "One-sentence explanation under the Who's Who switch. An 'implied subject' " +
          "is a person the verb refers to without naming them.",
      },
      "bibleData.enrichment.structure.label": {
        description: "Name of the enrichment that shows how a passage is organized.",
      },
      "bibleData.enrichment.structure.description": {
        description:
          "One-sentence explanation under the Passage structure switch. 'Manuscripts' " +
          "are the ancient copies of the Bible text.",
      },
      "bibleData.enrichment.originalContext.label": {
        description:
          "Name of the enrichment that shows the Greek or Hebrew text behind a verse.",
      },
      "bibleData.enrichment.originalContext.description": {
        description:
          "One-sentence explanation under the Original-language context switch. " +
          "'Context tab' is a tab in the expanded cell; a 'gloss' is a short " +
          "word-by-word meaning.",
      },
      "bibleData.enrichment.helps.label": {
        description: "Name of the enrichment that shows translator notes and questions.",
      },
      "bibleData.enrichment.helps.description": {
        description:
          "One-sentence explanation under the Translation helps switch. Translation " +
          "Notes and Translation Questions are names of unfoldingWord resources; " +
          "translate them as you would a book title.",
      },
      "bibleData.enrichment.terms.label": {
        description:
          "Name of the enrichment that marks important biblical words (key terms) in " +
          "the source text.",
      },
      "bibleData.enrichment.terms.description": {
        description:
          "One-sentence explanation under the Key terms switch. Translation Words is " +
          "the name of an unfoldingWord resource of short articles.",
      },
      "bibleData.enrichment.places.label": {
        description: "Name of the enrichment that shows information and maps for places.",
      },
      "bibleData.enrichment.places.description": {
        description: "One-sentence explanation under the Places and maps switch.",
      },
      "bibleData.enrichment.checks.label": {
        description:
          "Name of the enrichment that turns on automatic checks based on Bible data. " +
          "Each check is configured separately under Rules → Built-in checks.",
      },
      "bibleData.enrichment.checks.description": {
        description: "One-sentence explanation under the Bible data checks switch.",
      },
      "bibleData.enrichment.autopilot.label": {
        description:
          "Name of the enrichment that lets Autopilot (the app's automatic drafting " +
          "feature, a product name) use Bible data.",
      },
      "bibleData.enrichment.autopilot.description": {
        description:
          "One-sentence explanation under the 'Autopilot uses Bible data' switch. " +
          "'These facts' means the Bible data described by the other rows.",
      },
      "bibleData.enrichment.sourceChip": {
        description:
          "Small chip under each enrichment that says where its data comes from and " +
          "under which license. Keep it short; the middle dot separates the two parts.",
        placeholders: {
          sources:
            "The datasets the enrichment uses, already joined as a list, e.g. " +
            "'OpenText, Macula'. Proper names.",
          license: "The license identifier, e.g. 'CC BY-SA 4.0'. Never translated.",
        },
      },
      "bibleData.enrichment.switchOffReason": {
        description:
          "Shown above the enrichment list when the card's main 'Enable Bible data' " +
          "switch is off, explaining why every enrichment switch is disabled.",
      },
      "bibleData.enrichment.autopilotOffReason": {
        description:
          "Shown under the 'Autopilot uses Bible data' row when Autopilot itself is " +
          "off for the project, explaining why that switch is disabled. 'Experimental' " +
          "is the name of a settings page.",
      },
      "bibleData.enrichment.openBuiltinChecks": {
        description:
          "Button on the Bible data checks row. It opens the Rules page where each " +
          "built-in check has its own switch and severity.",
      },
      "bibleData.sources.open": {
        description:
          "Link-style button at the bottom of the Bible data card that opens a " +
          "dialog crediting each dataset and its license.",
      },
      "bibleData.sources.title": {
        description: "Title of the dialog that credits the Bible datasets.",
      },
      "bibleData.sources.description": {
        description:
          "Introduction under the dialog title. 'Bible data' is the name of the " +
          "setting; bibletranslation.org is a website name.",
      },
      "bibleData.source.macula.name": {
        description:
          "Full name of the Macula dataset (Greek and Hebrew grammar data by " +
          "Clear-Bible). Keep 'Macula' and 'Clear-Bible'; 'Greek/Hebrew' may be translated.",
      },
      "bibleData.source.macula.short": {
        description: "Short name of the Macula dataset, used inside the source chip. A proper name.",
      },
      "bibleData.source.opentext.name": {
        description:
          "Full name of the OpenText context-annotation dataset (who speaks, and " +
          "where passages begin). Keep the name as written.",
      },
      "bibleData.source.opentext.short": {
        description: "Short name of the OpenText dataset, used inside the source chip. A proper name.",
      },
      "bibleData.source.speakerQuotations.name": {
        description:
          "Full name of Clear-Bible's speaker-quotations dataset (which character " +
          "speaks each quotation). Keep the name as written.",
      },
      "bibleData.source.speakerQuotations.short": {
        description:
          "Short name of Clear-Bible's speaker-quotations dataset, used inside the " +
          "source chip. 'Clear' is a proper name; 'quotations' may be translated.",
      },
      "bibleData.source.acai.name": {
        description:
          "Full name of the ACAI dataset (people, places and key terms) published by " +
          "BibleAquifer. Keep the name as written.",
      },
      "bibleData.source.acai.short": {
        description: "Short name of the ACAI dataset, used inside the source chip. A proper name.",
      },
      "bibleData.source.unfoldingword.name": {
        description:
          "Full name of unfoldingWord's Translation Notes, Translation Questions and " +
          "Translation Words (TN/TQ/TW). The abbreviations may be spelled out.",
      },
      "bibleData.source.unfoldingword.short": {
        description:
          "Short name of the unfoldingWord resources, used inside the source chip. " +
          "A proper name, written with a lowercase 'u'.",
      },
      "bibleData.check.v1.name": {
        description:
          "Name of an automatic check in Rules → Built-in checks, also the title of its " +
          "finding on a cell. It checks that a quotation has its opening mark where " +
          "someone starts speaking in a Bible verse.",
      },
      "bibleData.check.v1.description": {
        description:
          "One-sentence explanation under the check's name. 'Level' is how deeply the " +
          "quotation is nested: a quotation, a quotation inside it, and so on.",
      },
      "bibleData.check.v2.name": {
        description:
          "Name of the check that a quotation is closed where the speaker stops, also " +
          "the title of its finding.",
      },
      "bibleData.check.v2.description": {
        description:
          "One-sentence explanation under the check's name. 'Narration' is the " +
          "narrator's text, e.g. an explanation after the quotation.",
      },
      "bibleData.check.v3.name": {
        description:
          "Name of the check that a quotation is not closed in a verse when the same " +
          "person keeps speaking in the next verse.",
      },
      "bibleData.check.v3.description": {
        description: "One-sentence explanation under the check's name.",
      },
      "bibleData.check.v5.name": {
        description:
          "Name of the check that a quotation inside another quotation uses its own " +
          "marks (in English, ‘ ’ inside “ ”).",
      },
      "bibleData.check.v5.description": {
        description:
          "One-sentence explanation under the check's name. 'Language profile' is the " +
          "name of a settings card that records facts about the target language.",
      },
      "bibleData.check.v7.name": {
        description:
          "Name of the check that flags quotation marks in a verse where nobody is " +
          "speaking, only the narrator.",
      },
      "bibleData.check.v7.description": {
        description:
          "One-sentence explanation under the check's name. 'Scare quotes' are quotation " +
          "marks around a word used in an unusual or ironic sense.",
      },
      "bibleData.check.v8.name": {
        description:
          "Name of the check for a speech that the narrator interrupts in the middle, " +
          "as in: “Give me,” she said, “the head of John.”",
      },
      "bibleData.check.v8.description": {
        description: "One-sentence explanation under the check's name.",
      },
      "bibleData.check.v9.name": {
        description:
          "Name of the check for words a speaker introduces himself, as in 'I tell you " +
          "that …'. Those words are already inside the speaker's own quotation.",
      },
      "bibleData.check.v9.description": {
        description:
          "One-sentence explanation under the check's name. Translate the example " +
          "'I tell you that …' naturally; keep the quotation marks around it.",
      },
      "bibleData.check.m1.name": {
        description:
          "Name of the check that a verse that asks a question in the original language " +
          "still ends its question with a question mark in the translation.",
      },
      "bibleData.check.m1.description": {
        description: "One-sentence explanation under the check's name.",
      },
      "bibleData.check.needs.quoteMarks": {
        description:
          "Shown under a check in Rules → Built-in checks while the check cannot run, " +
          "because the Language profile card has no quotation marks saved yet. " +
          "'Language profile' is the name of that settings card.",
      },
      "bibleData.check.needs.questionMarkers": {
        description:
          "Shown under the question check in Rules → Built-in checks while it cannot run, " +
          "because the Language profile card has no question markers saved yet. Question " +
          "markers are the words or word endings, besides a question mark, that make a " +
          "sentence a question. 'Language profile' is the name of that settings card.",
      },
      "bibleData.check.reason.openMissing": {
        description:
          "Explains a finding on one verse: a quotation should open here but has no " +
          "opening mark.",
        placeholders: { level: "The quotation's nesting level as a number: 1 for a quotation, 2 for one inside it." },
      },
      "bibleData.check.reason.closeMissing": {
        description:
          "Explains a finding on one verse: a quotation should close here but has no " +
          "closing mark.",
        placeholders: { level: "The quotation's nesting level as a number: 1 for a quotation, 2 for one inside it." },
      },
      "bibleData.check.reason.closeAfterAside": {
        description:
          "Explains a finding: the closing quotation mark was put after the narrator's " +
          "comment that follows the speech, so the comment is wrongly inside the quotation.",
      },
      "bibleData.check.reason.closeInContinuingSpeech": {
        description:
          "Explains a finding: the translation closes a quotation, but the same person " +
          "keeps speaking in the next verse.",
        placeholders: { level: "The quotation's nesting level as a number: 1 for a quotation, 2 for one inside it." },
      },
      "bibleData.check.reason.wrongLevelMarks": {
        description: "Explains a finding: a quotation inside a quotation uses the wrong kind of marks.",
        placeholders: {
          level: "The nesting level as a number, 2 or 3.",
          open: "The opening mark the project uses at that level, e.g. ‘. A symbol; never translated.",
          close: "The closing mark the project uses at that level, e.g. ’. A symbol; never translated.",
        },
      },
      "bibleData.check.reason.marksWithoutSpeech": {
        description: "Explains a finding: the verse has quotation marks although only the narrator speaks.",
      },
      "bibleData.check.reason.interruptionNotMarked": {
        description:
          "Explains a finding: the narrator interrupts the speech in the middle ('she " +
          "said'), but the translation quotes it as one piece.",
      },
      "bibleData.check.reason.selfProjectionAddsLevel": {
        description:
          "Explains a finding: the speaker introduces his own words ('I tell you that …'), " +
          "and the translation wrongly puts them in a further quotation.",
      },
      "bibleData.check.reason.questionMarkMissing": {
        description:
          "Explains a finding: the verse asks a question in the original language, but " +
          "the translation has no question mark.",
      },
      "bibleData.check.evidence.speech": {
        description:
          "Small evidence line under a finding: where the fact comes from. A 'speech' is " +
          "one quotation in the source data. 'Words 8–18' counts words in the Greek verse.",
        placeholders: {
          dataset: "A dataset name, e.g. 'OpenText'. A proper name.",
          ref: "The verse reference, e.g. 'JHN 4:9'. Never translated.",
          from: "Number of the first Greek word of the speech in the verse.",
          to: "Number of the last Greek word of the speech in the verse.",
          sources: "The datasets that name the speaker, already joined as a list. Proper names.",
          confidence: "How sure the data is about the speaker, already formatted as a percentage.",
        },
      },
      "bibleData.check.evidence.speechAcrossVerses": {
        description:
          "Evidence line for a speech that runs over several verses: where it starts and " +
          "where it ends.",
        placeholders: {
          dataset: "A dataset name, e.g. 'OpenText'. A proper name.",
          startRef: "The verse where the speech starts, e.g. 'JHN 4:11'. Never translated.",
          from: "Number of the speech's first Greek word in that verse.",
          endRef: "The verse where the speech ends, e.g. 'JHN 4:12'. Never translated.",
          to: "Number of the speech's last Greek word in that verse.",
          sources: "The datasets that name the speaker, already joined as a list. Proper names.",
          confidence: "How sure the data is about the speaker, already formatted as a percentage.",
        },
      },
      "bibleData.check.evidence.speechNoSpeaker": {
        description: "Evidence line for a speech whose speaker the data does not name.",
        placeholders: {
          dataset: "A dataset name, e.g. 'OpenText'. A proper name.",
          ref: "The verse reference, e.g. 'JHN 4:9'. Never translated.",
          from: "Number of the first Greek word of the speech in the verse.",
          to: "Number of the last Greek word of the speech in the verse.",
        },
      },
      "bibleData.check.evidence.speechAcrossVersesNoSpeaker": {
        description: "Evidence line for a speech over several verses whose speaker the data does not name.",
        placeholders: {
          dataset: "A dataset name, e.g. 'OpenText'. A proper name.",
          startRef: "The verse where the speech starts. Never translated.",
          from: "Number of the speech's first Greek word in that verse.",
          endRef: "The verse where the speech ends. Never translated.",
          to: "Number of the speech's last Greek word in that verse.",
        },
      },
      "bibleData.check.evidence.noSpeech": {
        description: "Evidence line: the data finds nobody speaking in these verses.",
        placeholders: {
          dataset: "A dataset name, e.g. 'OpenText'. A proper name.",
          refs: "One or more verse references, already joined as a list. Never translated.",
        },
      },
      "bibleData.check.evidence.question": {
        description: "Evidence line: the original-language text of these verses asks a question.",
        placeholders: {
          dataset: "A dataset name, e.g. 'Macula'. A proper name.",
          refs: "One or more verse references, already joined as a list. Never translated.",
        },
      },
      "bibleData.check.evidence.approximate": {
        description:
          "Added under the evidence line when one verse is split over several cells, so " +
          "the check cannot know which cell holds which words.",
      },
      "bibleData.profile.title": {
        description:
          "Title of a settings card where a maintainer records facts about the target " +
          "language that the automatic Bible data checks need.",
      },
      "bibleData.profile.description": {
        description: "One-sentence explanation under the card's title.",
      },
      "bibleData.profile.quoteMarks.label": {
        description: "Heading of the part of the card where the project's quotation marks are entered.",
      },
      "bibleData.profile.quoteMarks.description": {
        description: "Explains the three rows of quotation marks below it, one per nesting level.",
      },
      "bibleData.profile.quoteMarks.level1": {
        description: "Row label: the marks for an ordinary quotation (the first level).",
      },
      "bibleData.profile.quoteMarks.level2": {
        description: "Row label: the marks for a quotation inside another quotation (the second level).",
      },
      "bibleData.profile.quoteMarks.level3": {
        description: "Row label: the marks for a quotation inside a second-level one (the third level).",
      },
      "bibleData.profile.quoteMarks.openAriaLabel": {
        description: "Accessible name of the text box for one level's opening quotation mark.",
        placeholders: { level: "The row label, e.g. 'Inside a quotation'." },
      },
      "bibleData.profile.quoteMarks.closeAriaLabel": {
        description: "Accessible name of the text box for one level's closing quotation mark.",
        placeholders: { level: "The row label, e.g. 'Inside a quotation'." },
      },
      "bibleData.profile.continuation.label": {
        description:
          "Label of a choice: how the target language marks a quotation that goes on " +
          "into a new paragraph.",
      },
      "bibleData.profile.continuation.reopenEachParagraph": {
        description: "Choice: each new paragraph of the quotation starts again with the opening mark (English style).",
      },
      "bibleData.profile.continuation.continuationMark": {
        description: "Choice: each new paragraph of the quotation starts with the closing mark (Spanish style: »).",
      },
      "bibleData.profile.continuation.none": {
        description: "Choice: nothing marks the new paragraph of a quotation.",
      },
      "bibleData.profile.useDefaults": {
        description: "Button that fills in the usual quotation marks for the project's target language.",
        placeholders: { language: "The project's target language as stored, e.g. 'French' or 'fr'." },
      },
      "bibleData.profile.save": {
        description: "Button that saves the quotation marks entered in the card.",
      },
      "bibleData.profile.clear": {
        description: "Button that removes the saved quotation marks, which turns the quotation checks off.",
      },
      "bibleData.profile.notSet": {
        description: "Shown while no quotation marks are saved.",
      },
      "bibleData.profile.saved": {
        description: "Confirmation after the quotation marks are saved.",
      },
      "bibleData.profile.invalid": {
        description: "Error shown when the quotation marks entered cannot be saved.",
      },
      "bibleData.profile.error.conflict": {
        description: "Error: another person saved project settings first.",
      },
      "bibleData.profile.error.offline": {
        description: "Error: the device is offline, so the card cannot save.",
      },
      "bibleData.profile.error.permission": {
        description: "Error: the person's project role is too low to change this setting.",
      },
      "bibleData.profile.error.failed": {
        description: "Error: saving failed for another reason.",
      },
    },
  },
  surfaces: [],
})
