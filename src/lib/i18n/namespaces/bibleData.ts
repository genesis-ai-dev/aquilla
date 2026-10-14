import { defineNamespace, plural } from "./types"

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
 * AQU-1687 adds `bibleData.voices.*` (the voice chip, its popover, the
 * speech rails and the "Show every line by …" filter in the editor) and
 * `bibleData.view.*` (View settings → Bible data). Pack enums map to these
 * keys through the typed tables in src/components/bible-data/voice-text.ts.
 *
 * AQU-1689 adds `bibleData.whosWho.*` (mention highlights, their popover, the
 * cell filter and the Who's Who panel) and `bibleData.context.*` (the cell's
 * Context tab). Pack enums map to them through the typed tables in
 * src/components/bible-data/people-text.ts.
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
    // ── Voices: the chip in each Bible cell (AQU-1687) ──
    "bibleData.voices.narrator": "Narrator",
    "bibleData.voices.author": "Author",
    "bibleData.voices.unknownSpeaker": "Unknown speaker",
    "bibleData.voices.more": "+{count}",
    "bibleData.voices.chipAria": "Who is speaking: {voices}",
    "bibleData.voices.chipAriaApproximate": "Who is speaking in this verse: {voices}",
    "bibleData.voices.speaksTo": "{speaker} to {addressee}",
    "bibleData.voices.moreVoices": plural({
      one: "{count} more speaker",
      other: "{count} more speakers",
    }),

    // ── Voices: the chip's popover ──
    "bibleData.voices.popoverTitle": "Who is speaking",
    "bibleData.voices.type.dialogue": "Conversation",
    "bibleData.voices.type.normal": "Speech",
    "bibleData.voices.type.quotation": "Quotation (of scripture or a source)",
    "bibleData.voices.type.hypothetical": "Imagined speech",
    "bibleData.voices.type.implicit": "Implied speech",
    "bibleData.voices.delivery": "Delivery: {delivery}",
    "bibleData.voices.level": "Quote level {level}",
    "bibleData.voices.speakerEvidence": "Speaker: {confidence} sure, from {sources}",
    "bibleData.voices.addresseeEvidence": "Listener: {confidence} sure, from {sources}",
    "bibleData.voices.evidence.macula1p": "Macula (first-person pronouns)",
    "bibleData.voices.evidence.macula2p": "Macula (second-person pronouns)",
    "bibleData.voices.evidence.maculaA2": "Macula (the verb's listener)",
    "bibleData.voices.namesHeading": "Where these names come from",
    "bibleData.voices.labelSource.terminology": "From your terminology",
    "bibleData.voices.labelSource.acai": "From ACAI",
    "bibleData.voices.labelSource.acaiOtherScript": "From ACAI, in Traditional characters",
    "bibleData.voices.labelSource.generated": "Generated, not yet reviewed",
    "bibleData.voices.labelSource.english": "In English",
    "bibleData.voices.approximate":
      "Approximate: this cell holds only part of its verse, so it shows the whole verse's speakers.",
    "bibleData.voices.showLinesBy": "Show every line by {speaker}",

    // ── Voices: the "Show every line by …" filter ──
    "bibleData.voices.filter.summary": plural({
      one: "Showing {count} line by {speaker}",
      other: "Showing {count} lines by {speaker}",
    }),
    "bibleData.voices.filter.clear": "Show all lines",

    // ── Voices: speech rails (screen-reader text) ──
    "bibleData.voices.rail.begins": "Speech by {speaker} begins",
    "bibleData.voices.rail.continues": "Speech by {speaker} continues",
    "bibleData.voices.rail.ends": "Speech by {speaker} ends",
    "bibleData.voices.rail.beginsAndEnds": "Speech by {speaker} begins and ends",

    // ── View settings → Bible data ──
    "bibleData.view.voiceChips": "Voice chips",
    "bibleData.view.speechRails": "Speech rails",
    "bibleData.view.labelLanguage": "Label language",
    "bibleData.view.labelLanguage.project": "Project names",
    "bibleData.view.labelLanguage.interface": "Interface language",
    "bibleData.view.labelLanguage.english": "English names",

    // ── Who's Who (AQU-1689): mentions in the source text and their popover ──
    "bibleData.whosWho.kind.explicit": "Named",
    "bibleData.whosWho.kind.pronoun": "Pronoun",
    "bibleData.whosWho.kind.subject": "Implied subject",
    "bibleData.whosWho.pronoun.firstSingular": "I",
    "bibleData.whosWho.pronoun.firstPlural": "we",
    "bibleData.whosWho.pronoun.secondSingular": "you",
    "bibleData.whosWho.pronoun.secondPlural": "you all",
    "bibleData.whosWho.pronoun.thirdSingularMasculine": "he",
    "bibleData.whosWho.pronoun.thirdSingularFeminine": "she",
    "bibleData.whosWho.pronoun.thirdSingularNeuter": "it",
    "bibleData.whosWho.pronoun.thirdPlural": "they",
    "bibleData.whosWho.hint": "[{pronoun} = {name}]",
    "bibleData.whosWho.hintNameOnly": "[{name}]",
    "bibleData.whosWho.gender.male": "male",
    "bibleData.whosWho.gender.female": "female",
    "bibleData.whosWho.gender.masculine": "masculine (grammatical gender)",
    "bibleData.whosWho.gender.feminine": "feminine (grammatical gender)",
    "bibleData.whosWho.gender.neuter": "neuter (grammatical gender)",
    "bibleData.whosWho.number.singular": "singular",
    "bibleData.whosWho.number.plural": "plural",
    "bibleData.whosWho.mentionAria": "{word}: {kind}, {name}",
    "bibleData.whosWho.groupMembers": "A group: {members}",
    "bibleData.whosWho.unknownParticipant": "Unnamed participant",
    "bibleData.whosWho.firstMention": "First mention in this passage: {ref}",
    "bibleData.whosWho.evidence": "{confidence} sure, from {sources}",
    "bibleData.whosWho.hops": plural({
      one: "Reached through {count} link",
      other: "Reached through {count} links",
    }),
    "bibleData.whosWho.previousMention": "Previous mention",
    "bibleData.whosWho.nextMention": "Next mention",
    "bibleData.whosWho.previousMentionAria": "Previous mention of {name}",
    "bibleData.whosWho.nextMentionAria": "Next mention of {name}",
    "bibleData.whosWho.noEarlierMention": "No earlier mention",
    "bibleData.whosWho.noLaterMention": "No later mention",
    "bibleData.whosWho.showMentions": "Show cells that mention {name}",

    // ── Who's Who: the cell filter ──
    "bibleData.whosWho.filter.summary": plural({
      one: "Showing {count} cell that mentions {name}",
      other: "Showing {count} cells that mention {name}",
    }),

    // ── Who's Who: the right-rail panel ──
    "bibleData.whosWho.panel.edgeTab": "People",
    "bibleData.whosWho.panel.showAria": "Show Who's Who",
    "bibleData.whosWho.panel.hideAria": "Hide Who's Who",
    "bibleData.whosWho.panel.openTooltip": "Who's Who: the people in this passage",
    "bibleData.whosWho.panel.resizeAria": "Resize the Who's Who panel",
    "bibleData.whosWho.panel.scrollHint": "Scroll to a verse to see who is in its passage.",
    "bibleData.whosWho.panel.unavailable.offline":
      "Bible data for this book is not available offline yet. Try again when you are online.",
    "bibleData.whosWho.panel.unavailable.notFound": "There is no Bible data for this book yet.",
    "bibleData.whosWho.panel.unavailable.invalid": "The Bible data for this book could not be read.",
    "bibleData.whosWho.panel.noPassage": "No passage data for {ref}.",
    "bibleData.whosWho.panel.range": "{from}–{to}",
    "bibleData.whosWho.panel.mentions": plural({
      one: "{count} mention",
      other: "{count} mentions",
    }),
    "bibleData.whosWho.panel.goToFirst": "First: {ref}",
    "bibleData.whosWho.panel.goToFirstAria": "Go to the first mention of {name} in this passage, {ref}",
    "bibleData.whosWho.panel.placesAndOthers": plural({
      one: "{count} place or other reference",
      other: "{count} places and other references",
    }),
    "bibleData.whosWho.panel.alignmentNote":
      "Word highlights need an alignment between your source text and the Greek or Hebrew. The cast, the cell filter and the Context tab work without one.",
    "bibleData.whosWho.flag.reintroducePronoun":
      "Name them again: this passage first refers to them with a pronoun, at {ref}.",
    "bibleData.whosWho.flag.reintroduceSubject":
      "Name them again: this passage first refers to them only through a verb, at {ref}.",
    "bibleData.whosWho.flag.ambiguity": "A pronoun at {ref} may be read as {others}.",

    // ── The cell's Context tab (AQU-1689) ──
    "bibleData.context.tab": "Context",
    "bibleData.context.wordsHeading": "Original words",
    "bibleData.context.refersToSrOnly": "{word} refers to {name}",
    "bibleData.context.approximate":
      "Approximate: this cell holds only part of its verse, so it shows the whole verse's words.",

    // ── View settings → Bible data, Who's Who (AQU-1689) ──
    "bibleData.view.off": "Off",
    "bibleData.view.whosWhoHighlights": "Who's Who highlights",
    "bibleData.view.whosWhoHighlights.hover": "On hover or focus",
    "bibleData.view.whosWhoHighlights.always": "Always on",
    "bibleData.view.impliedSubjectHints": "Implied-subject hints",
    "bibleData.view.impliedSubjectHints.names": "Names only",
    "bibleData.view.impliedSubjectHints.all": "All implied subjects",

    // ── Voices and Who's Who popovers: add to terminology (AQU-1693) ──
    "bibleData.terms.addAria": "Add {name} to terminology",
    "bibleData.terms.linkEntry": "Link “{term}” to {name}",
    "bibleData.terms.linkedToast": "Linked “{term}” to {name}",
  },
  context: {
    _context: {
      description:
        "Bible data: open datasets about the Bible text. Three surfaces. (1) The 'Bible " +
        "data' card in project Settings → General: a list of optional Bible data " +
        "features ('enrichments') under the card's main switch, and a dialog that " +
        "credits the open datasets the data comes from. (2) In the translation editor, " +
        "'Voices': a small chip on each Bible verse naming who speaks to whom " +
        "('Narrator · Jesus → Samaritan woman'), a popover with details, thin lines " +
        "('speech rails') at the edge of the verse that show where a quotation opens " +
        "and closes, and the matching personal options in the editor's View settings. " +
        "(3) 'Who's Who': which person each Greek or Hebrew word refers to (a name, a " +
        "pronoun, or a verb whose subject is implied), highlights and a popover on those " +
        "words, a side panel listing the people in the current passage, and a 'Context' " +
        "tab in the expanded cell. 'Passage' means a section of a Bible book, such as a " +
        "story. " +
        "'Speaker' and 'voice' mean people speaking in the Bible text, never " +
        "text-to-speech voices. Dataset and organization names (Macula, Clear-Bible, " +
        "OpenText, ACAI, BibleAquifer, unfoldingWord, bibletranslation.org) are proper " +
        "names: keep them in Latin script, untranslated. " +
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

      // ── AQU-1687: Voices ──
      "bibleData.voices.narrator": {
        description:
          "In the voice chip of a Bible verse: the narrator of a Gospel or of Acts, the " +
          "voice that tells the story between the quotations. A role in the text, not " +
          "an audio or text-to-speech voice.",
        maxLength: 16,
      },
      "bibleData.voices.author": {
        description:
          "In the voice chip of a verse in a letter (Romans, Hebrews …) or in " +
          "Revelation: the writer of the book, who 'narrates' it. Not the author of a " +
          "comment or of a translation.",
        maxLength: 16,
      },
      "bibleData.voices.unknownSpeaker": {
        description:
          "In the voice chip and its popover, in place of a name when the data does not " +
          "say who speaks a quotation.",
        maxLength: 24,
      },
      "bibleData.voices.more": {
        description:
          "Very short count at the end of a voice chip when a verse has more speakers " +
          "than the chip shows, e.g. 'Narrator · Jesus → Samaritan woman +1'.",
        placeholders: { count: "How many more speakers the verse has. A number." },
        maxLength: 6,
      },
      "bibleData.voices.chipAria": {
        description:
          "Screen-reader name of the voice chip, a button that opens details about who " +
          "speaks in the verse.",
        placeholders: {
          voices:
            "The voices in reading order, already joined as a list, e.g. 'Narrator, " +
            "Jesus to Samaritan woman'.",
        },
      },
      "bibleData.voices.chipAriaApproximate": {
        description:
          "Screen-reader name of the voice chip when the cell holds only part of a verse, " +
          "so the chip lists the speakers of the whole verse.",
        placeholders: {
          voices: "The voices in reading order, already joined as a list.",
        },
      },
      "bibleData.voices.speaksTo": {
        description:
          "One voice in words: who speaks, and to whom. Read by screen readers in place " +
          "of the arrow the chip shows ('Jesus → Samaritan woman').",
        placeholders: {
          speaker: "The name of the person speaking.",
          addressee: "The name of the person or group spoken to.",
        },
      },
      "bibleData.voices.moreVoices": {
        description:
          "Screen-reader text for the '+N' at the end of a voice chip: how many more " +
          "speakers the verse has than the chip shows.",
        placeholders: { count: "How many more speakers. A number." },
      },
      "bibleData.voices.popoverTitle": {
        description:
          "Heading of the popover that opens from a verse's voice chip and lists each " +
          "voice in the verse with its details.",
      },
      "bibleData.voices.type.dialogue": {
        description:
          "Kind of speech, in the voice popover: people talking with each other in the " +
          "story (dialogue). Not a chat with the app.",
      },
      "bibleData.voices.type.normal": {
        description:
          "Kind of speech, in the voice popover: a speech or saying addressed to " +
          "someone, without a reply in the same scene.",
      },
      "bibleData.voices.type.quotation": {
        description:
          "Kind of speech, in the voice popover: words quoted from scripture or from " +
          "another written source.",
      },
      "bibleData.voices.type.hypothetical": {
        description:
          "Kind of speech, in the voice popover: words someone might say, or is imagined " +
          "saying ('if anyone says to you …').",
      },
      "bibleData.voices.type.implicit": {
        description:
          "Kind of speech, in the voice popover: speech the text implies without " +
          "quoting it word for word.",
      },
      "bibleData.voices.delivery": {
        description:
          "Line in the voice popover: how the line is spoken, as a dramatized audio " +
          "Bible would perform it.",
        placeholders: {
          delivery:
            "A short English note from the dataset, e.g. 'requesting' or 'angry'. It is " +
            "shown as it is and is not translated.",
        },
      },
      "bibleData.voices.level": {
        description:
          "Line in the voice popover: how deeply the quotation is nested. Level 1 is a " +
          "quotation in the story; level 2 is a quotation inside a quotation.",
        placeholders: { level: "The nesting depth, a small number (1, 2 or 3)." },
      },
      "bibleData.voices.speakerEvidence": {
        description:
          "Line in the voice popover: how sure the data is about who speaks, and which " +
          "datasets say so.",
        placeholders: {
          confidence: "A percentage, e.g. '97%'.",
          sources: "Dataset names joined as a list, e.g. 'Clear speaker-quotations and Macula'.",
        },
      },
      "bibleData.voices.addresseeEvidence": {
        description:
          "Line in the voice popover: how sure the data is about who is spoken to, and " +
          "which datasets say so.",
        placeholders: {
          confidence: "A percentage, e.g. '80%'.",
          sources: "Dataset names joined as a list.",
        },
      },
      "bibleData.voices.evidence.macula1p": {
        description:
          "A data source in the voice popover: the Macula dataset, which here found the " +
          "speaker from words such as 'I' and 'me' in the quotation. Keep 'Macula'.",
      },
      "bibleData.voices.evidence.macula2p": {
        description:
          "A data source in the voice popover: the Macula dataset, which here found who " +
          "is spoken to from words such as 'you' in the quotation. Keep 'Macula'.",
      },
      "bibleData.voices.evidence.maculaA2": {
        description:
          "A data source in the voice popover: the Macula dataset, which here found who " +
          "is spoken to from the speaking verb ('said to her'). Keep 'Macula'.",
      },
      "bibleData.voices.namesHeading": {
        description:
          "Small heading in the voice popover over a list of the names it shows, each " +
          "with where that name came from.",
      },
      "bibleData.voices.labelSource.terminology": {
        description:
          "Where a name came from, in the voice popover: the project's own approved " +
          "rendering in its terminology (glossary).",
      },
      "bibleData.voices.labelSource.acai": {
        description:
          "Where a name came from, in the voice popover: the ACAI dataset's name for the " +
          "person in the interface language. ACAI is a proper name.",
      },
      "bibleData.voices.labelSource.acaiOtherScript": {
        description:
          "Where a name came from, in the voice popover, for Chinese only: ACAI's name, " +
          "which is written in Traditional characters even in a Simplified Chinese " +
          "interface. ACAI is a proper name.",
      },
      "bibleData.voices.labelSource.generated": {
        description:
          "Where a name came from, in the voice popover: made automatically from the " +
          "data (for a person the Bible does not name, e.g. 'Samaritan woman'), and not " +
          "checked by a person yet.",
      },
      "bibleData.voices.labelSource.english": {
        description:
          "Where a name came from, in the voice popover: the English name, used because " +
          "no name in the chosen language is available.",
      },
      "bibleData.voices.approximate": {
        description:
          "Note in the voice popover when the project splits one Bible verse across " +
          "several cells: the data cannot yet tell which part each person speaks, so " +
          "every part lists all of the verse's speakers.",
      },
      "bibleData.voices.showLinesBy": {
        description:
          "Button in the voice popover. It filters the editor to the lines (verses) " +
          "where this person speaks.",
        placeholders: { speaker: "The name of the person, e.g. 'Jesus'." },
      },
      "bibleData.voices.filter.summary": {
        description:
          "Bar above the editor's list while it shows only one person's lines, after " +
          "'Show every line by …'.",
        placeholders: {
          count: "How many lines are shown. A number.",
          speaker: "The name of the person, e.g. 'Jesus'.",
        },
      },
      "bibleData.voices.filter.clear": {
        description:
          "Button on the bar above the editor's list. It removes the one-person filter " +
          "and shows every line of the file again.",
      },
      "bibleData.voices.rail.begins": {
        description:
          "Screen-reader text for the thin line at the edge of a verse: a quotation by " +
          "this person starts in this verse and goes on into the next.",
        placeholders: { speaker: "The name of the person speaking." },
      },
      "bibleData.voices.rail.continues": {
        description:
          "Screen-reader text for the thin line at the edge of a verse: a quotation by " +
          "this person started in an earlier verse and goes on after this one.",
        placeholders: { speaker: "The name of the person speaking." },
      },
      "bibleData.voices.rail.ends": {
        description:
          "Screen-reader text for the thin line at the edge of a verse: a quotation by " +
          "this person that started earlier ends in this verse.",
        placeholders: { speaker: "The name of the person speaking." },
      },
      "bibleData.voices.rail.beginsAndEnds": {
        description:
          "Screen-reader text for the thin line at the edge of a verse: a quotation by " +
          "this person starts and ends within this verse.",
        placeholders: { speaker: "The name of the person speaking." },
      },
      "bibleData.view.voiceChips": {
        description:
          "Switch in the editor's View settings, under 'Bible data': shows or hides the " +
          "small chip on each verse that names who is speaking.",
      },
      "bibleData.view.speechRails": {
        description:
          "Switch in the editor's View settings, under 'Bible data': shows or hides the " +
          "thin lines at the edge of verses that mark where quotations open and close.",
      },
      "bibleData.view.labelLanguage": {
        description:
          "Heading of a choice in the editor's View settings, under 'Bible data': which " +
          "language the names of speakers are shown in.",
      },
      "bibleData.view.labelLanguage.project": {
        description:
          "Option under 'Label language': use the names the project agreed in its " +
          "terminology (e.g. 'Yesus' in an Indonesian project), then the interface " +
          "language, then English.",
      },
      "bibleData.view.labelLanguage.interface": {
        description:
          "Option under 'Label language': use names in the language of the app's own " +
          "menus and buttons, then English.",
      },
      "bibleData.view.labelLanguage.english": {
        description: "Option under 'Label language': always use the English names.",
      },
      "bibleData.whosWho.kind.explicit": {
        description:
          "How a Greek or Hebrew word refers to a person in the Bible text, in the Who's " +
          "Who popover: the word is the person's name or a noun for them ('Jesus', 'the " +
          "woman').",
      },
      "bibleData.whosWho.kind.pronoun": {
        description:
          "How a Greek or Hebrew word refers to a person in the Bible text, in the Who's " +
          "Who popover: the word is a pronoun ('him', 'her', 'me').",
      },
      "bibleData.whosWho.kind.subject": {
        description:
          "How a Greek or Hebrew word refers to a person in the Bible text, in the Who's " +
          "Who popover: the word is a verb whose subject is the person, though the text " +
          "does not name them ('[he] answered').",
      },
      "bibleData.whosWho.pronoun.firstSingular": {
        description:
          "A pronoun inside a small hint before a Bible verb, '[I = Jesus]': the verb's " +
          "subject is the one speaking. Use the plain subject pronoun of the interface " +
          "language.",
      },
      "bibleData.whosWho.pronoun.firstPlural": {
        description:
          "A pronoun inside a small hint before a Bible verb, '[we = Jesus, Peter]': the " +
          "verb's subject is the speakers' group.",
      },
      "bibleData.whosWho.pronoun.secondSingular": {
        description:
          "A pronoun inside a small hint before a Bible verb, '[you = Samaritan woman]': " +
          "the verb's subject is ONE person being spoken to. Use the singular, plain form, " +
          "not a polite form addressed to the app's user.",
      },
      "bibleData.whosWho.pronoun.secondPlural": {
        description:
          "A pronoun inside a small hint before a Bible verb, '[you all = disciples]': the " +
          "verb's subject is SEVERAL people being spoken to. Use your language's plural " +
          "'you'.",
      },
      "bibleData.whosWho.pronoun.thirdSingularMasculine": {
        description:
          "A pronoun inside a small hint before a Bible verb, '[he = Jesus]': the verb's " +
          "subject is one male person, not named in the text.",
      },
      "bibleData.whosWho.pronoun.thirdSingularFeminine": {
        description:
          "A pronoun inside a small hint before a Bible verb, '[she = Samaritan woman]': " +
          "the verb's subject is one female person, not named in the text.",
      },
      "bibleData.whosWho.pronoun.thirdSingularNeuter": {
        description:
          "A pronoun inside a small hint before a Bible verb, '[it = water]': the verb's " +
          "subject is one thing (Greek neuter gender), not named in the text.",
      },
      "bibleData.whosWho.pronoun.thirdPlural": {
        description:
          "A pronoun inside a small hint before a Bible verb, '[they = disciples]': the " +
          "verb's subject is a group, not named in the text.",
      },
      "bibleData.whosWho.hint": {
        description:
          "A small grey hint shown before a Greek or Hebrew verb whose subject the text " +
          "does not name, e.g. '[he = Jesus]'. Keep the square brackets, or use your " +
          "language's usual brackets for an editorial note.",
        placeholders: {
          pronoun: "A subject pronoun, e.g. 'he' or 'they' (translated separately).",
          name: "The person's or group's name, e.g. 'Jesus' or 'Andrew, James and John'.",
        },
      },
      "bibleData.whosWho.hintNameOnly": {
        description:
          "The same hint when no pronoun can be given (the verb is a participle or an " +
          "infinitive): only the name, in square brackets, e.g. '[Jesus]'.",
        placeholders: { name: "The person's or group's name, e.g. 'Jesus'." },
      },
      "bibleData.whosWho.gender.male": {
        description: "A person's sex, from the ACAI dataset, in the Who's Who panel: male.",
      },
      "bibleData.whosWho.gender.female": {
        description: "A person's sex, from the ACAI dataset, in the Who's Who panel: female.",
      },
      "bibleData.whosWho.gender.masculine": {
        description:
          "For an unnamed participant, the grammatical gender of the Greek or Hebrew word " +
          "that first refers to them, in the Who's Who panel.",
      },
      "bibleData.whosWho.gender.feminine": {
        description:
          "For an unnamed participant, the grammatical gender of the Greek or Hebrew word " +
          "that first refers to them, in the Who's Who panel.",
      },
      "bibleData.whosWho.gender.neuter": {
        description:
          "For an unnamed participant, the grammatical gender of the Greek or Hebrew word " +
          "that first refers to them, in the Who's Who panel.",
      },
      "bibleData.whosWho.number.singular": {
        description: "Grammatical number of a participant in the Who's Who panel: one person.",
      },
      "bibleData.whosWho.number.plural": {
        description: "Grammatical number of a participant in the Who's Who panel: a group.",
      },
      "bibleData.whosWho.mentionAria": {
        description:
          "Screen-reader name of a Greek or Hebrew word in the source text that refers to " +
          "a person. Read instead of the word alone.",
        placeholders: {
          word: "The Greek or Hebrew word, e.g. 'αὐτόν'.",
          kind: "How it refers to them: 'Named', 'Pronoun' or 'Implied subject'.",
          name: "The person's name, e.g. 'Jesus'.",
        },
      },
      "bibleData.whosWho.groupMembers": {
        description:
          "Line in the Who's Who popover when a word refers to a group of people: who is " +
          "in the group.",
        placeholders: { members: "The members' names joined as a list, e.g. 'Andrew, James and Jesus'." },
      },
      "bibleData.whosWho.unknownParticipant": {
        description:
          "Shown in place of a name when the data refers to a person it has no name for.",
      },
      "bibleData.whosWho.firstMention": {
        description:
          "Line in the Who's Who popover: the verse where the current passage first " +
          "refers to this person.",
        placeholders: { ref: "A Bible reference, e.g. 'JHN 4:6'." },
      },
      "bibleData.whosWho.evidence": {
        description:
          "Line in the Who's Who popover: how sure the data is that the word refers to " +
          "this person, and which datasets say so.",
        placeholders: {
          confidence: "A percentage, e.g. '97%'.",
          sources: "Dataset names joined as a list, e.g. 'ACAI and Macula'.",
        },
      },
      "bibleData.whosWho.hops": {
        description:
          "Line in the Who's Who popover and the Context tab: the data found the person " +
          "by following a chain of words that refer to each other (e.g. 'him' → 'the one " +
          "saying' → 'Jesus'). A longer chain is less certain.",
        placeholders: { count: "How many steps the chain has, 2 or more." },
      },
      "bibleData.whosWho.previousMention": {
        description:
          "Button in the Who's Who popover: go to the previous verse that refers to the " +
          "same person.",
      },
      "bibleData.whosWho.nextMention": {
        description:
          "Button in the Who's Who popover: go to the next verse that refers to the same " +
          "person.",
      },
      "bibleData.whosWho.previousMentionAria": {
        description: "Screen-reader name of the 'Previous mention' button.",
        placeholders: { name: "The person's name, e.g. 'Jesus'." },
      },
      "bibleData.whosWho.nextMentionAria": {
        description: "Screen-reader name of the 'Next mention' button.",
        placeholders: { name: "The person's name, e.g. 'Jesus'." },
      },
      "bibleData.whosWho.noEarlierMention": {
        description:
          "Shown instead of the 'Previous mention' button when no earlier verse of the " +
          "book refers to this person.",
      },
      "bibleData.whosWho.noLaterMention": {
        description:
          "Shown instead of the 'Next mention' button when no later verse of the book " +
          "refers to this person.",
      },
      "bibleData.whosWho.showMentions": {
        description:
          "Button in the Who's Who popover and panel. It filters the editor to the cells " +
          "(verses) that refer to this person.",
        placeholders: { name: "The person's name, e.g. 'Jesus'." },
      },
      "bibleData.whosWho.filter.summary": {
        description:
          "Bar above the editor's list while it shows only the cells (verses) that refer " +
          "to one person.",
        placeholders: {
          count: "How many cells are shown. A number.",
          name: "The person's name, e.g. 'Jesus'.",
        },
      },
      "bibleData.whosWho.panel.edgeTab": {
        description:
          "Short vertical label on the closed Who's Who panel at the right edge of the " +
          "editor. 'People' means the people in the Bible passage, not the project's users.",
        maxLength: 12,
      },
      "bibleData.whosWho.panel.showAria": {
        description: "Screen-reader name of the closed panel's tab: opens the Who's Who panel.",
      },
      "bibleData.whosWho.panel.hideAria": {
        description: "Screen-reader name of the close button in the Who's Who panel.",
      },
      "bibleData.whosWho.panel.openTooltip": {
        description: "Tooltip on the closed Who's Who panel's tab.",
      },
      "bibleData.whosWho.panel.resizeAria": {
        description: "Screen-reader name of the handle that changes the panel's width.",
      },
      "bibleData.whosWho.panel.scrollHint": {
        description: "Shown in the Who's Who panel before the editor shows a Bible verse.",
      },
      "bibleData.whosWho.panel.unavailable.offline": {
        description: "Shown in the Who's Who panel when the data could not be downloaded.",
      },
      "bibleData.whosWho.panel.unavailable.notFound": {
        description:
          "Shown in the Who's Who panel when the Bible data has nothing for this book " +
          "(today it covers the New Testament).",
      },
      "bibleData.whosWho.panel.unavailable.invalid": {
        description: "Shown in the Who's Who panel when the downloaded data is damaged.",
      },
      "bibleData.whosWho.panel.noPassage": {
        description:
          "Shown in the Who's Who panel when the data has no passage (section) for the " +
          "verse the editor shows.",
        placeholders: { ref: "A Bible reference, e.g. 'JHN 4:6'." },
      },
      "bibleData.whosWho.panel.range": {
        description:
          "The verses a passage covers, under its title in the Who's Who panel. Use your " +
          "language's range mark.",
        placeholders: {
          from: "The first verse, e.g. 'JHN 4:1'.",
          to: "The last verse, e.g. 'JHN 4:26'.",
        },
      },
      "bibleData.whosWho.panel.mentions": {
        description:
          "In the Who's Who panel: how many words in the passage refer to this person " +
          "(names, pronouns and verbs together).",
        placeholders: { count: "A number." },
      },
      "bibleData.whosWho.panel.goToFirst": {
        description:
          "Small button in the Who's Who panel that scrolls the editor to the first verse " +
          "of the passage that refers to this person.",
        placeholders: { ref: "A Bible reference, e.g. 'JHN 4:7'." },
      },
      "bibleData.whosWho.panel.goToFirstAria": {
        description: "Screen-reader name of the 'First: …' button in the Who's Who panel.",
        placeholders: {
          name: "The person's name, e.g. 'Jesus'.",
          ref: "A Bible reference, e.g. 'JHN 4:7'.",
        },
      },
      "bibleData.whosWho.panel.placesAndOthers": {
        description:
          "Heading of a collapsed list in the Who's Who panel: places, and other things " +
          "the passage refers to that are not people.",
        placeholders: { count: "How many are in the list. A number." },
      },
      "bibleData.whosWho.panel.alignmentNote": {
        description:
          "Quiet note in the Who's Who panel when the project's source text is not the " +
          "Greek or Hebrew itself (e.g. an English Bible). 'Alignment' is a link between " +
          "the words of two texts. The 'Context tab' is a tab in the expanded cell.",
      },
      "bibleData.whosWho.flag.reintroducePronoun": {
        description:
          "Note in the Who's Who panel: in this passage, the first word for this person " +
          "is a pronoun ('he', 'his'), so a reader who starts here may not know who it " +
          "is. The translator may want to use the name there.",
        placeholders: { ref: "The verse, e.g. 'JHN 4:27'." },
      },
      "bibleData.whosWho.flag.reintroduceSubject": {
        description:
          "Note in the Who's Who panel: in this passage, the person is first referred to " +
          "only by a verb's form ('[he] was teaching'), so a reader who starts here may " +
          "not know who it is.",
        placeholders: { ref: "The verse, e.g. 'MRK 1:21'." },
      },
      "bibleData.whosWho.flag.ambiguity": {
        description:
          "Note in the Who's Who panel: a pronoun for this person sits in a verse that " +
          "also refers to another person of the same gender and number, so in some " +
          "languages it could be read as that other person.",
        placeholders: {
          ref: "The verse, e.g. 'MRK 1:30'.",
          others: "The other people's names joined as a list, e.g. 'Peter'.",
        },
      },
      "bibleData.context.tab": {
        description:
          "Name of a tab in the expanded cell that shows the Greek or Hebrew words of the " +
          "verse, their meanings and who each word refers to. Short.",
        maxLength: 16,
      },
      "bibleData.context.wordsHeading": {
        description:
          "Heading in the Context tab over the verse's Greek or Hebrew words, each with " +
          "its short meaning (gloss).",
      },
      "bibleData.context.refersToSrOnly": {
        description:
          "Screen-reader text in the Context tab for a Greek or Hebrew word that refers to " +
          "a person. Sighted readers see an arrow instead.",
        placeholders: {
          word: "The Greek or Hebrew word, e.g. 'αὐτόν'.",
          name: "The person's name, e.g. 'Jesus'.",
        },
      },
      "bibleData.context.approximate": {
        description:
          "Note in the Context tab when the project splits one Bible verse across several " +
          "cells: each part shows the whole verse's words.",
      },
      "bibleData.view.off": {
        description:
          "Option in the editor's View settings, under 'Bible data', for 'Who's Who " +
          "highlights' and for 'Implied-subject hints': show none.",
      },
      "bibleData.view.whosWhoHighlights": {
        description:
          "Heading of a choice in the editor's View settings, under 'Bible data': when " +
          "words in the source text that refer to the same person are highlighted.",
      },
      "bibleData.view.whosWhoHighlights.hover": {
        description:
          "Option under 'Who's Who highlights': highlight a person's words when the " +
          "pointer is over one of them, or when one has keyboard focus.",
      },
      "bibleData.view.whosWhoHighlights.always": {
        description: "Option under 'Who's Who highlights': highlight every person's words all the time.",
      },
      "bibleData.view.impliedSubjectHints": {
        description:
          "Heading of a choice in the editor's View settings, under 'Bible data': whether " +
          "a small hint like '[he = Jesus]' is shown before verbs whose subject the text " +
          "does not name.",
      },
      "bibleData.view.impliedSubjectHints.names": {
        description:
          "Option under 'Implied-subject hints': only when the subject is a named person " +
          "or group (e.g. Jesus), not an unnamed one (e.g. 'a woman').",
      },
      "bibleData.view.impliedSubjectHints.all": {
        description: "Option under 'Implied-subject hints': for every verb whose subject is implied.",
      },
      "bibleData.terms.addAria": {
        description:
          "Accessible name of the 'Add to terminology' button in the popover about a Bible " +
          "person, place or group. It suggests a new terminology entry linked to them.",
        placeholders: { name: "The person's, place's or group's name, e.g. Jesus." },
      },
      "bibleData.terms.linkEntry": {
        description:
          "Button in the popover about a Bible person, place or group: links the project's " +
          "existing terminology entry (its source term) to that person, so the entry's " +
          "rendering becomes their name.",
        placeholders: {
          term: "The terminology entry's source term, as the user wrote it, e.g. Jesus.",
          name: "The person's, place's or group's name, e.g. Jesus.",
        },
      },
      "bibleData.terms.linkedToast": {
        description: "Confirmation toast after a terminology entry was linked to a Bible person, place or group.",
        placeholders: {
          term: "The terminology entry's source term, as the user wrote it.",
          name: "The person's, place's or group's name.",
        },
      },
    },
  },
  surfaces: [],
})
