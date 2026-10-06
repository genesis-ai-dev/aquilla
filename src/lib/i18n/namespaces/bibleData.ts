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
 * AQU-1687 adds `bibleData.voices.*` (the voice chip, its popover, the
 * speech rails and the "Show every line by …" filter in the editor) and
 * `bibleData.view.*` (View settings → Bible data). Pack enums map to these
 * keys through the typed tables in src/components/bible-data/voice-text.ts.
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
  },
  context: {
    _context: {
      description:
        "Bible data: open datasets about the Bible text. Two surfaces. (1) The 'Bible " +
        "data' card in project Settings → General: a list of optional Bible data " +
        "features ('enrichments') under the card's main switch, and a dialog that " +
        "credits the open datasets the data comes from. (2) In the translation editor, " +
        "'Voices': a small chip on each Bible verse naming who speaks to whom " +
        "('Narrator · Jesus → Samaritan woman'), a popover with details, thin lines " +
        "('speech rails') at the edge of the verse that show where a quotation opens " +
        "and closes, and the matching personal options in the editor's View settings. " +
        "'Speaker' and 'voice' mean people speaking in the Bible text, never " +
        "text-to-speech voices. Dataset and organization names (Macula, Clear-Bible, " +
        "OpenText, ACAI, BibleAquifer, unfoldingWord, bibletranslation.org) are proper " +
        "names: keep them in Latin script, untranslated.",
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
    },
  },
  surfaces: [],
})
