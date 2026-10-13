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
  },
  context: {
    _context: {
      description:
        "The 'Bible data' card in project Settings → General: a list of optional " +
        "Bible data features ('enrichments') under the card's main switch, and a " +
        "dialog that credits the open datasets the data comes from. Read by a " +
        "project maintainer deciding what translators see. Dataset and organization " +
        "names (Macula, Clear-Bible, OpenText, ACAI, BibleAquifer, unfoldingWord, " +
        "bibletranslation.org) are proper names: keep them in Latin script, untranslated.",
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
    },
  },
  surfaces: [],
})
