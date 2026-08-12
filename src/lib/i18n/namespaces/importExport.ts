import { defineNamespace, plural } from "./types"

/**
 * `importExport` namespace — registered up front by the swarm orchestrator so parallel
 * agents fill only this file and never contend on the `messages/en.ts` barrel.
 *
 * Every key here MUST be prefixed `importExport.` — the namespace's name is derived
 * from its first key, not from the filename.
 */
export const importExport = defineNamespace({
  keys: {
    // — Import result panel (post-import report; also copied to the clipboard
    //   as plain text, so a couple of these keys render outside any markup) —
    "importExport.result.reportImportedCount": plural({
      one: "{count} item imported",
      other: "{count} items imported",
    }),
    "importExport.result.reportSkippedCount": plural({
      one: "{count} item skipped",
      other: "{count} items skipped",
    }),
    "importExport.result.reportHeader": "Import complete: {imported}, {skipped}.",
    "importExport.result.reportSkippedListLabel": "Skipped items:",
    "importExport.result.summaryImported": plural({
      one: "{count} item imported successfully;",
      other: "{count} items imported successfully;",
    }),
    "importExport.result.summarySkipped": "{count} could not be imported.",
    "importExport.result.summaryReviewHint": "Review the list below and copy it before closing.",
    "importExport.result.copied": "Copied!",
    "importExport.result.copyReport": "Copy report",
    "importExport.result.closing": "Closing…",

    // — Direction panel (post-import prompt to confirm source/target language) —
    "importExport.direction.intro":
      "We detected the source language from the imported project. Please confirm the " +
      "source and set the target language so back-translation and QA rules work correctly.",
    "importExport.direction.sourceLabel": "Source language",
    "importExport.direction.sourcePlaceholder": "e.g. English, arb, hbo",
    "importExport.direction.targetLabel": "Target language",
    "importExport.direction.targetPlaceholder": "e.g. Spanish, fra, swh",
    "importExport.direction.changeLaterHint": "You can change these later in {path}.",
    "importExport.direction.skip": "Skip for now",
    "importExport.direction.setting": "Setting…",
    "importExport.direction.setDirection": "Set direction",

    // — Shared across format panels —
    "importExport.action.import": "Import",
    "importExport.action.importing": "Importing…",
    "importExport.errors.importFailed": "Import failed",

    // — Macula Hebrew/Greek panel —
    "importExport.macula.description":
      "Upload a Macula TSV file obtained from {link}. Each TSV file represents one " +
      "biblical book. The Hebrew and Greek word-level morphology (lemma, morph code, " +
      "Strong's) will be preserved alongside the verse text.",
    "importExport.macula.chooseFile": "Choose Macula TSV file",
    "importExport.macula.parsing": "Parsing verse data…",
    "importExport.macula.uploadingCells": plural(
      { one: "Uploading: {enqueued} / {total} cell", other: "Uploading: {enqueued} / {total} cells" },
      "total",
    ),

    // — Translation Notes (TN) panel —
    "importExport.tn.description":
      "Upload an {link} TSV file. Each row becomes a note cell; notes appear in a " +
      "sidebar when you focus a translation cell at the matching verse reference.",
    "importExport.tn.chooseFile": "Choose Translation Notes TSV",
    "importExport.tn.parsing": "Parsing translation notes…",
    "importExport.tn.uploadingNotes": plural(
      { one: "Uploading: {enqueued} / {total} note", other: "Uploading: {enqueued} / {total} notes" },
      "total",
    ),
    "importExport.tn.rowsSkipped": plural({
      one: "{count} row skipped (missing canonical reference)",
      other: "{count} rows skipped (missing canonical reference)",
    }),

    // — Open Bible Stories (OBS) panel —
    "importExport.obs.description":
      "Narrative stories with reference images, from {link}. 50 stories are imported " +
      "as one source file; each frame becomes a cell carrying its reference image.",
    "importExport.obs.downloading": "Downloading stories… {progress}",
    "importExport.obs.parsingFrames": "Parsing frames…",
    "importExport.obs.uploadingFrames": "Uploading frames: {enqueued} / {total}",
    "importExport.obs.uploadingToProject": "Uploading to project…",
    "importExport.obs.downloadAndImport": "Download & Import",

    // — SDBH Hebrew lexicon panel —
    "importExport.sdbh.description":
      "Import the UBS MARBLE {dictName}. Choose the master edition (usually " +
      "{masterFile}) as the source; optionally add a localized edition (e.g. " +
      "{localizedFile}) to pre-fill the target column with the translation so far. " +
      "Entries import one file per Hebrew letter plus a semantic-domain label file; " +
      "each sense groups as one paragraph with a cell per definition, gloss list, and comment.",
    "importExport.sdbh.chooseMaster": "Choose master edition (SDBH-en.JSON)",
    "importExport.sdbh.chooseLocalized": "Choose localized edition (optional)",
    "importExport.sdbh.parsingLexicon": "Parsing lexicon…",
    "importExport.sdbh.uploadingSource": "Uploading source",
    "importExport.sdbh.prefillingTranslations": "Pre-filling translations",
    "importExport.sdbh.fileProgress": "file {index} / {count}",
    "importExport.sdbh.cellsProgress": "{enqueued} / {total} cells",

    // — Biblica Study Bible Notes (IDML) panel —
    "importExport.biblica.description":
      "Upload the InDesign (.idml) package for a Biblica study Bible. Only the study " +
      "notes are imported — the Bible text is skipped, because it comes from the " +
      "published scripture files rather than being retyped here. Each note keeps its " +
      "InDesign formatting locked, and the notes carry the book and chapter range they " +
      "belong to so they stay in step with the passage. Lists that InDesign holds in a " +
      "single paragraph — cross-references, glossaries, outlines — always arrive as one " +
      "cell per line. Optionally, longer note blocks can also be split into one cell per " +
      "sentence; export puts each block back together as InDesign set it.",
    "importExport.biblica.chooseFile": "Choose study Bible IDML file",
    "importExport.biblica.splitSentencesLabel": "Split long notes into one cell per sentence",
    "importExport.biblica.splitSentencesAriaLabel": "Split long notes into one cell per sentence",
    "importExport.biblica.splitSentencesHint":
      "Leave unchecked to import each note line as one larger cell. Lists still split per line either way.",
    "importExport.biblica.readingPackage": "Reading the InDesign package…",
    "importExport.biblica.readingPackageWithProgress": "Reading the InDesign package… ({completed} / {total})",
    "importExport.biblica.uploadingNotes": plural(
      { one: "Uploading: {enqueued} / {total} note", other: "Uploading: {enqueued} / {total} notes" },
      "total",
    ),
    "importExport.biblica.paragraphsSkipped": plural({
      one: "{count} scripture paragraph skipped.",
      other: "{count} scripture paragraphs skipped.",
    }),

    // — Door43 (DCS) panel —
    "importExport.dcs.importingResource": "Importing {resource}{ref}…",
    "importExport.dcs.genericResource": "resource",
    "importExport.dcs.filesProgress": "{uploaded} / {total} files",
    "importExport.dcs.fetchingAndParsing": "Fetching & parsing from Door43…",
    "importExport.dcs.importComplete": "Import complete",
    "importExport.dcs.filesCount": plural({ one: "{count} file", other: "{count} files" }),
    "importExport.dcs.cellsCount": plural({ one: "{count} cell", other: "{count} cells" }),
    "importExport.dcs.pinnedToRelease": "Pinned to release {ref}",
    "importExport.dcs.couldNotPin":
      "Imported, but couldn't pin the release — you may lack maintainer rights on this project.",

    // — Import landing screen (format picker) —
    "importExport.landing.intro": "Choose the format that matches your files.",
    "importExport.landing.popularSection": "Most popular",
    "importExport.landing.specializedSection": "Specialized",
    "importExport.landing.filterPlaceholder": "Filter importers…",
    "importExport.landing.filterAriaLabel": "Filter specialized importers",
    "importExport.landing.noMatches": "No importer matches “{filter}”.",
    "importExport.landing.badgeSoon": "Soon",
    "importExport.landing.badgeBeta": "Beta",
    "importExport.landing.comingSoonTooltip": "Coming soon — {title} import is tracked for a later release",

    "importExport.landing.upload.title": "Upload files",
    "importExport.landing.upload.description":
      "USFM, DOCX, PPTX, IDML, TXT, subtitles, spreadsheets, audio/video, or a Paratext project.",
    "importExport.landing.ebible.title": "eBible Corpus",
    "importExport.landing.ebible.hint": "public library",
    "importExport.landing.ebible.description": "Openly-licensed Bible translations, imported directly — no download.",
    "importExport.landing.helloao.title": "Bible API",
    "importExport.landing.helloao.hint": "helloao.org",
    "importExport.landing.helloao.description":
      "1,000+ translations — the whole Bible, one testament, or just the books you pick.",
    "importExport.landing.spreadsheet.title": "Spreadsheet",
    "importExport.landing.spreadsheet.hint": "CSV / XLSX",
    "importExport.landing.spreadsheet.description": "Map which columns are source, target, label, cast, or timestamp.",
    "importExport.landing.macula.title": "Macula Hebrew + Greek",
    "importExport.landing.macula.description":
      "Original-language OT/NT with per-word lemma, morphology, and Strong's.",
    "importExport.landing.paired.title": "Paired translation",
    "importExport.landing.paired.description": "Source + target pairs from a spreadsheet to fill the target column.",
    "importExport.landing.labels.title": "Cell labels / cast",
    "importExport.landing.labels.description": "Re-upload a template to label existing cells with cast names.",
    "importExport.landing.tn.title": "Translation Notes",
    "importExport.landing.tn.hint": "TSV",
    "importExport.landing.tn.description": "unfoldingWord notes, shown beside the matching verse as you translate.",
    "importExport.landing.biblica.title": "Biblica Study Bible Notes",
    "importExport.landing.biblica.hint": "IDML",
    "importExport.landing.biblica.description":
      "Study notes from an InDesign study Bible — imports the notes only and leaves the scripture untouched.",
    "importExport.landing.obs.title": "Open Bible Stories",
    "importExport.landing.obs.hint": "door43",
    "importExport.landing.obs.description": "Narrative stories with reference images, from unfoldingWord/door43.",
    "importExport.landing.dcs.title": "Door43 (DCS)",
    "importExport.landing.dcs.hint": "upstream",
    "importExport.landing.dcs.description":
      "Import any released Door43 resource as source and pin it to a release — pull upstream changes later.",
    "importExport.landing.sdbh.title": "SDBH Hebrew Lexicon",
    "importExport.landing.sdbh.hint": "UBS MARBLE",
    "importExport.landing.sdbh.description":
      "Semantic Dictionary of Biblical Hebrew — localize definitions and glosses by semantic domain, with lossless export back to the MARBLE XML.",
    "importExport.landing.tm.title": "Translation Memory",
    "importExport.landing.tm.hint": "TMX",
    "importExport.landing.tm.description": "Import source/target pairs from a TMX memory file.",

    // — Re-import collision panel —
    "importExport.collision.intro": plural({
      one: "The following {count} file already exists in this project. Choose what to do with it.",
      other: "The following {count} files already exist in this project. Choose what to do with each one.",
    }),
    "importExport.collision.updateHint":
      "Updating matches stable units and keeps translations, language lanes, comments, audio, and units missing from the new file.",
    "importExport.collision.ambiguousWarning":
      "Some files have multiple matches. Choose Skip or Import as duplicate for those files.",
    "importExport.collision.applyToAll": "Apply to all:",
    "importExport.collision.updateAll": "Update all",
    "importExport.collision.skipAll": "Skip all",
    "importExport.collision.duplicateAll": "Import all as duplicates",
    "importExport.collision.existing": "Existing: {name}",
    "importExport.collision.updateExisting": "Update existing",
    "importExport.collision.skip": "Skip",
    "importExport.collision.duplicate": "Import as duplicate",
    "importExport.collision.continuing": "Continuing…",
    "importExport.collision.continue": "Continue",

    // — Bible API (helloao.org) panel —
    "importExport.helloao.description":
      "Import a Bible translation from the {link} — over 1,000 versions with section " +
      "headings and formatting. You can import the whole bible, a single testament, or individual books.",
    "importExport.helloao.apiLinkText": "Free Use Bible API",
    "importExport.helloao.searchPlaceholder": "Search by language, name, or id (e.g. 'eng', 'BSB')",
    "importExport.helloao.searchAriaLabel": "Search Bible translations",
    "importExport.helloao.failedToLoadList": "Failed to load list: {error}",
    "importExport.helloao.loadingTranslations": "Loading translations...",
    "importExport.helloao.languageAndBookCount": plural(
      { one: "{language} · {count} book", other: "{language} · {count} books" },
      "count",
    ),
    "importExport.helloao.backToList": "Back to translation list",
    "importExport.helloao.license": "license",
    "importExport.helloao.failedToLoadBooks": "Failed to load books: {error}",
    "importExport.helloao.loadingBooks": "Loading books…",
    "importExport.helloao.presetAriaLabel": "Book selection preset",
    "importExport.helloao.presetWholeBible": "Whole bible",
    "importExport.helloao.presetOldTestament": "Old Testament",
    "importExport.helloao.presetNewTestament": "New Testament",
    "importExport.helloao.booksSelected": "{checked} of {total} books",
    "importExport.helloao.downloading": "Downloading {id}… {progress}",
    "importExport.helloao.parsingVerses": "Parsing verses…",
    "importExport.helloao.uploadingVerses": "Uploading verses: {enqueued} / {total}",
    "importExport.helloao.approxVerseCount": plural(
      { one: "~{count} verse", other: "~{count} verses" },
      "count",
    ),

    // — Shared —
    "importExport.action.working": "Working…",

    // — eBible corpus panel —
    "importExport.ebible.modeTabsAriaLabel": "eBible import mode",
    "importExport.ebible.modeSource": "New source file",
    "importExport.ebible.modeTarget": "Into target column",
    "importExport.ebible.sourceDescription":
      "Import a Bible translation directly from the {link}. Only redistributable translations are included.",
    "importExport.ebible.corpusLinkText": "BibleNLP/ebible corpus",
    "importExport.ebible.targetDescription":
      "Match eBible verses to existing source cells by canonical reference (e.g. GEN 1:1) and " +
      "fill the target column. A review step lets you keep or replace any existing target content.",
    "importExport.ebible.searchPlaceholder": "Search by language, title, or id (e.g. 'eng', 'KJV')",
    "importExport.ebible.searchAriaLabel": "Search eBible translations",
    "importExport.ebible.otBooks": "{count} OT",
    "importExport.ebible.ntBooks": "{count} NT",
    "importExport.ebible.noCopyrightInfo": "No copyright info.",
    "importExport.ebible.downloading": "Downloading {id}… {progress}",
    "importExport.ebible.matchingVerses": "Matching verses to source cells…",
    "importExport.ebible.preparing": "Preparing…",
    "importExport.ebible.nextReviewMatches": "Next: Review matches",
    "importExport.ebible.preparationFailed": "Preparation failed",
    "importExport.ebible.applyFailed": "Apply failed",
    "importExport.ebible.committingVerses": "Committing {enqueued} / {total} verses…",
    "importExport.ebible.committingVersesIndeterminate": "Committing verses…",
    "importExport.ebible.targetCommitted": "Target verses committed.",
    "importExport.ebible.targetCommittedHint": "The target column will update as the server projection lands.",

    // — Paratext project preview/choice panel —
    "importExport.paratext.couldNotReadProject": "Couldn't read the project",
    "importExport.paratext.bookProgressLabel": "{book} · book {done} of {total}",
    "importExport.paratext.booksProgressLabel": "{done} / {total} books",
    "importExport.paratext.uploadingBook": "Uploading {book}…",
    "importExport.paratext.uploading": "Uploading…",
    "importExport.paratext.couldNotLoadSourceList": "Couldn't load the source list",
    "importExport.paratext.fetchingSource": "Fetching source: {title}…",
    "importExport.paratext.cellsProgress": "{count} / {total} cells · {bookLabel}",
    "importExport.paratext.pickSourceTitle": "Pick a source Bible to align against",
    "importExport.paratext.pickSourceHint":
      "It just needs to be close — verses align by reference (e.g. MAT 1:1). Verses missing on either side stay blank.",
    "importExport.paratext.searchTranslationsPlaceholder": "Search translations (language, name, code)…",
    "importExport.paratext.searchTranslationsAriaLabel": "Search translations",
    "importExport.paratext.loadingSourceList": "Loading source list…",
    "importExport.paratext.projectDetected": plural({
      one: "Paratext project detected — {count} book",
      other: "Paratext project detected — {count} books",
    }),
    "importExport.paratext.languageLabel": "Language: {language}",
    "importExport.paratext.cellsParsedHint": "{count} cells parsed in your browser — review, then choose how to bring it in.",
    "importExport.paratext.readingProject": "Reading project…",
    "importExport.paratext.includeBookAriaLabel": "Include {book}",
    "importExport.paratext.showParsedCellsAriaLabel": "Show the first parsed cells",
    "importExport.paratext.bookCellsCount": "{bookId} · {count} cells",
    "importExport.paratext.duplicateRefsCount": plural({
      one: "{count} duplicate ref",
      other: "{count} duplicate refs",
    }),
    "importExport.paratext.moreCells": "… {count} more",
    "importExport.paratext.howToBringIn": "How should we bring it in?",
    "importExport.paratext.sourceTextTitle": "Source text",
    "importExport.paratext.sourceTextDescription": "A reference Bible to translate from. Books import as source cells.",
    "importExport.paratext.translationInProgressTitle": "Translation in progress",
    "importExport.paratext.translationInProgressDescription":
      "Your team's target text. We'll pair it with a source Bible by verse.",

    // — Upload files panel (the main drag-and-drop importer) —
    "importExport.upload.idmlChecking": "Checking",
    "importExport.upload.idmlOpening": "Opening",
    "importExport.upload.idmlReading": "Reading",
    "importExport.upload.idmlCountSuffix": " ({completed}/{total})",
    "importExport.upload.idmlPhase": "{action} {fileName}{count}…",
    "importExport.upload.oneSpreadsheetAtATime": "Import one spreadsheet at a time so its columns can be mapped safely.",
    "importExport.upload.readingFile": "Reading {fileName}…",
    "importExport.upload.analyzingFile": "Analyzing {fileName}…",
    "importExport.upload.parseFailed": "Parse failed",
    "importExport.upload.finishingUp": "Finishing up…",
    "importExport.upload.finalizationFailed": "Import finalization failed",
    "importExport.upload.uploadingFile": "Uploading {fileName}…",
    "importExport.upload.notAttempted": "not attempted after an earlier file failed",
    "importExport.upload.castAssignmentsLabel": "Cast assignments",
    "importExport.upload.importFinalizationLabel": "Import finalization",
    "importExport.upload.cellsProgress": "{count} / {total} cells",
    "importExport.upload.dragDropHint": "Drag & drop files here, or",
    "importExport.upload.chooseFiles": "Choose Files",
    "importExport.upload.chooseFolder": "Choose Folder",
    "importExport.upload.categoryScripture": "Scripture",
    "importExport.upload.categoryTranslation": "Translation",
    "importExport.upload.categoryDocuments": "Documents",
    "importExport.upload.categoryLocalization": "Localization",
    "importExport.upload.categorySubtitles": "Subtitles",
    "importExport.upload.categoryParatextProject": "Paratext project",
    "importExport.upload.zipOrFolder": ".zip or folder",
    "importExport.upload.categoryOtherFormats": "Other formats",
    "importExport.upload.otherFormatsHint": "AI-assisted when configured, always reviewed before import",

    // — Main ImportDialog shell (title bar + top-level error frames) —
    "importExport.dialog.titleImport": "Import",
    "importExport.dialog.titleDirection": "Set translation direction",
    "importExport.dialog.titleResult": "Import complete — some items skipped",
    "importExport.dialog.titleCollision": "Re-import detected",
    "importExport.dialog.titlePreview": "Preview",
    "importExport.dialog.backToFileSelection": "Back to file selection",
    "importExport.dialog.backToImportTypes": "Back to import types",
    "importExport.dialog.titleUpload": "Upload Files",
    "importExport.dialog.titleHelloao": "Bible API (helloao.org)",
    "importExport.dialog.titleObs": "Open Bible Stories",
    "importExport.dialog.titleDcs": "Door43 (DCS)",
    "importExport.dialog.titleMacula": "Macula Hebrew + Greek",
    "importExport.dialog.titleTn": "Translation Notes (TSV)",
    "importExport.dialog.titleBiblica": "Biblica Study Bible Notes",
    "importExport.dialog.titleSpreadsheet": "Spreadsheet (CSV / XLSX)",
    "importExport.dialog.titleLabels": "Cell Labels / Cast",
    "importExport.dialog.titlePaired": "Paired Translation Import",
    "importExport.dialog.titleSdbh": "SDBH Hebrew Lexicon",
    "importExport.dialog.titleEbible": "eBible Corpus",
    "importExport.dialog.finishSaveFailed": "Couldn't finish saving your import — please try again. ({message})",
    "importExport.dialog.saveFailed": "Couldn't save your import — please try again. ({message})",
    "importExport.dialog.labelsNeedSourceFile":
      "Cell labels require an existing source file in this project. Import source files first, then return here.",
    "importExport.dialog.pairedNeedsSourceCells":
      "Paired translation import requires existing source cells in this project. Import source files first.",
  },
  context: {
    _context: {
      description:
        'Importing a source document into a project and exporting a translation back out — the format pickers, per-format hints, upload progress, collision handling and failure messages. Importing is the very first action a translator takes in Aquilla, so these strings are read before any other working surface.',
    },
    keys: {
      "importExport.result.reportImportedCount": {
        description:
          "Plain-text clipboard report: how many items imported successfully, interpolated into reportHeader.",
        placeholders: { count: "Number of items successfully imported." },
      },
      "importExport.result.reportSkippedCount": {
        description:
          "Plain-text clipboard report: how many items were skipped, interpolated into reportHeader.",
        placeholders: { count: "Number of items skipped during import." },
      },
      "importExport.result.reportHeader": {
        description:
          "First line of the plain-text import report copied to the clipboard. {imported} and {skipped} are the already-pluralized phrases from reportImportedCount/reportSkippedCount — do not re-translate the numbers inside them, just place the two phrases in the sentence.",
        placeholders: {
          imported: "Pre-rendered '<n> item(s) imported' phrase.",
          skipped: "Pre-rendered '<n> item(s) skipped' phrase.",
        },
      },
      "importExport.result.summaryImported": {
        description:
          "On-screen result summary, first clause: how many items imported. {count} is rendered as a bold styled number by the caller (RichMessage) — the string still needs the plural form for the surrounding words. Ends with a semicolon because it is immediately followed by summarySkipped in the same sentence.",
        placeholders: { count: "Bold-styled count of successfully imported items." },
      },
      "importExport.result.summarySkipped": {
        description:
          "On-screen result summary, second clause, immediately after summaryImported in the same sentence. {count} is rendered as a bold styled number by the caller (RichMessage).",
        placeholders: { count: "Bold-styled count of items that could not be imported." },
      },
      "importExport.direction.changeLaterHint": {
        description:
          "Hint below the source/target language fields on the post-import direction prompt. {path} is a bold-styled literal breadcrumb naming where to change this later, rendered by RichMessage.",
        placeholders: { path: "Bold-styled settings breadcrumb ('Project Settings → Project Info')." },
      },
      "importExport.macula.description": {
        description:
          "Intro paragraph on the Macula Hebrew/Greek import panel, explaining what a Macula TSV file is and where to get one. {link} is a hyperlink to the Macula GitHub repo, rendered by RichMessage.",
        placeholders: { link: "Hyperlink reading 'Clear Bible's Macula project'." },
      },
      "importExport.macula.uploadingCells": {
        description: "Upload progress line on the Macula panel: how many cells have been enqueued so far.",
        placeholders: {
          enqueued: "Number of cells enqueued so far, already locale-formatted.",
          total: "Total cell count; also governs the plural form.",
        },
      },
      "importExport.tn.description": {
        description:
          "Intro paragraph on the Translation Notes import panel. {link} is a hyperlink to the unfoldingWord TN catalog entry, rendered by RichMessage.",
        placeholders: { link: "Hyperlink reading 'unfoldingWord-style Translation Notes'." },
      },
      "importExport.tn.uploadingNotes": {
        description: "Upload progress line on the Translation Notes panel: how many note cells have been enqueued.",
        placeholders: {
          enqueued: "Number of note cells enqueued so far, already locale-formatted.",
          total: "Total note count; also governs the plural form.",
        },
      },
      "importExport.tn.rowsSkipped": {
        description:
          "Warning shown on the Translation Notes panel when some TSV rows lacked a canonical reference and were skipped.",
        placeholders: { count: "Number of skipped rows." },
      },
      "importExport.obs.description": {
        description:
          "Intro paragraph on the Open Bible Stories import panel. {link} is a hyperlink to the unfoldingWord/door43 OBS repo, rendered by RichMessage.",
        placeholders: { link: "Hyperlink reading 'unfoldingWord/door43'." },
      },
      "importExport.obs.downloading": {
        description:
          "Download-phase progress line on the OBS panel. {progress} is a pre-formatted byte-transfer string (e.g. '12.4 / 40.0 MB (31%)') from the shared byte-progress formatter — do not re-format the number inside it.",
        placeholders: { progress: "Pre-formatted byte transfer progress string." },
      },
      "importExport.obs.uploadingFrames": {
        description: "Upload-phase progress line on the OBS panel: how many story frames have been enqueued.",
        placeholders: {
          enqueued: "Number of frames enqueued so far, already locale-formatted.",
          total: "Total frame count, already locale-formatted.",
        },
      },
      "importExport.sdbh.description": {
        description:
          "Intro paragraph on the SDBH Hebrew lexicon import panel. {dictName} is the bold-styled dictionary name, {masterFile} and {localizedFile} are monospaced example filenames — all three rendered by RichMessage, and the filenames are literal data, not translated.",
        placeholders: {
          dictName: "Bold-styled dictionary name ('Semantic Dictionary of Biblical Hebrew').",
          masterFile: "Monospaced example master filename ('SDBH-en.JSON') — not translated.",
          localizedFile: "Monospaced example localized filename ('SDBH-es.JSON') — not translated.",
        },
      },
      "importExport.sdbh.fileProgress": {
        description: "Fragment appended to the SDBH upload phase label naming which multi-file step is in progress.",
        placeholders: { index: "1-based index of the file currently processing.", count: "Total file count for this phase." },
      },
      "importExport.sdbh.cellsProgress": {
        description: "Fragment appended to the SDBH upload phase label showing cell upload progress.",
        placeholders: {
          enqueued: "Number of cells enqueued so far, already locale-formatted.",
          total: "Total cell count, already locale-formatted.",
        },
      },
      "importExport.biblica.splitSentencesAriaLabel": {
        description: "Accessible name for the checkbox that splits long Biblica study notes into one cell per sentence.",
      },
      "importExport.biblica.readingPackageWithProgress": {
        description: "Parse-phase progress line on the Biblica panel while unpacking the IDML package, once a file count is known.",
        placeholders: {
          completed: "Number of internal IDML parts processed so far.",
          total: "Total number of internal IDML parts.",
        },
      },
      "importExport.biblica.uploadingNotes": {
        description: "Upload-phase progress line on the Biblica panel: how many note cells have been enqueued.",
        placeholders: {
          enqueued: "Number of note cells enqueued so far, already locale-formatted.",
          total: "Total note count; also governs the plural form.",
        },
      },
      "importExport.biblica.paragraphsSkipped": {
        description: "Notice on the Biblica panel: how many scripture (non-note) paragraphs were intentionally skipped.",
        placeholders: { count: "Number of scripture paragraphs skipped, already locale-formatted." },
      },
      "importExport.dcs.importingResource": {
        description:
          "In-progress heading on the Door43 (DCS) panel while a resource is being imported. {ref} is a literal ' @ <release>' suffix or empty string, not independently translated.",
        placeholders: {
          resource: "Full name of the Door43 resource being imported, or a generic fallback noun.",
          ref: "Literal ' @ <release tag>' suffix, or empty string when no release is pinned.",
        },
      },
      "importExport.dcs.filesProgress": {
        description: "Upload progress line on the Door43 (DCS) panel while importing.",
        placeholders: {
          uploaded: "Number of files uploaded so far, already locale-formatted.",
          total: "Total file count, already locale-formatted.",
        },
      },
      "importExport.dcs.filesCount": {
        description: "First half of the Door43 (DCS) import-complete summary — how many files landed. Joined with cellsCount by ' · '.",
        placeholders: { count: "Number of files imported, already locale-formatted." },
      },
      "importExport.dcs.cellsCount": {
        description: "Second half of the Door43 (DCS) import-complete summary — how many cells landed. Joined with filesCount by ' · '.",
        placeholders: { count: "Number of cells imported, already locale-formatted." },
      },
      "importExport.dcs.pinnedToRelease": {
        description:
          "Confirmation on the Door43 (DCS) import-complete screen that the project was pinned to a release. {ref} is a bold-styled release tag, rendered by RichMessage.",
        placeholders: { ref: "Bold-styled release tag the project was pinned to." },
      },
      "importExport.landing.noMatches": {
        description: "Shown on the import landing screen when the specialized-importer filter matches nothing.",
        placeholders: { filter: "The user's current filter text, echoed back verbatim." },
      },
      "importExport.landing.filterAriaLabel": {
        description: "Accessible name for the specialized-importer filter search field on the import landing screen.",
      },
      "importExport.landing.comingSoonTooltip": {
        description:
          "Tooltip on a disabled (not-yet-available) import format card on the landing screen. {title} is that format's own translated title.",
        placeholders: { title: "The disabled option's translated title." },
      },
      "importExport.collision.intro": {
        description: "Heading of the re-import collision panel, above the per-file resolution list.",
        placeholders: { count: "Number of colliding files detected." },
      },
      "importExport.collision.existing": {
        description: "Names the existing file a detected collision matches, inside one collision row.",
        placeholders: { name: "Name of the existing file in the project." },
      },
      "importExport.helloao.description": {
        description:
          "Intro paragraph on the Bible API (helloao.org) translation picker. {link} is a hyperlink to the API docs, rendered by RichMessage.",
        placeholders: { link: "Hyperlink reading 'Free Use Bible API'." },
      },
      "importExport.helloao.failedToLoadList": {
        description: "Error shown when the helloao.org translations list fails to load.",
        placeholders: { error: "Raw error message." },
      },
      "importExport.helloao.languageAndBookCount": {
        description: "Second line of a translation row in the helloao.org picker list: language name and book count.",
        placeholders: {
          language: "The translation's language name, as supplied by the API — not translated.",
          count: "Number of books the translation contains.",
        },
      },
      "importExport.helloao.failedToLoadBooks": {
        description: "Error shown when the book list for a chosen helloao.org translation fails to load.",
        placeholders: { error: "Raw error message." },
      },
      "importExport.helloao.booksSelected": {
        description: "Selection counter above the book checklist on the helloao.org book-selection step.",
        placeholders: { checked: "Number of books currently checked.", total: "Total number of books available." },
      },
      "importExport.helloao.downloading": {
        description:
          "Download-phase progress line on the helloao.org book-selection step. {progress} is a pre-formatted byte-transfer string — do not re-format the number inside it.",
        placeholders: { id: "The translation's short id (e.g. 'BSB').", progress: "Pre-formatted byte transfer progress string." },
      },
      "importExport.helloao.uploadingVerses": {
        description: "Upload-phase progress line on the helloao.org book-selection step.",
        placeholders: {
          enqueued: "Number of verse cells enqueued so far, already locale-formatted.",
          total: "Total verse cell count, already locale-formatted.",
        },
      },
      "importExport.helloao.searchAriaLabel": {
        description: "Accessible name for the translation search field on the helloao.org picker step.",
      },
      "importExport.helloao.presetAriaLabel": {
        description: "Accessible name for the Whole bible / Old Testament / New Testament segmented preset control.",
      },
      "importExport.helloao.approxVerseCount": {
        description: "Approximate verse-count badge shown once books are selected on the helloao.org book-selection step.",
        placeholders: { count: "Approximate number of verses across the selected books, already locale-formatted." },
      },
      "importExport.ebible.modeTabsAriaLabel": {
        description: "Accessible name for the New source file / Into target column mode toggle on the eBible panel.",
      },
      "importExport.ebible.searchAriaLabel": {
        description: "Accessible name for the translation search field on the eBible panel.",
      },
      "importExport.ebible.sourceDescription": {
        description:
          "Intro paragraph on the eBible corpus panel, source-file mode. {link} is a hyperlink to the eBible GitHub repo, rendered by RichMessage.",
        placeholders: { link: "Hyperlink reading 'BibleNLP/ebible corpus'." },
      },
      "importExport.ebible.otBooks": {
        description: "Old Testament book count badge on an eBible translation row ('OT' stays an untranslated abbreviation).",
        placeholders: { count: "Number of Old Testament books the translation contains." },
      },
      "importExport.ebible.ntBooks": {
        description: "New Testament book count badge on an eBible translation row ('NT' stays an untranslated abbreviation).",
        placeholders: { count: "Number of New Testament books the translation contains." },
      },
      "importExport.ebible.downloading": {
        description:
          "Download-phase progress line on the eBible panel (source or target mode). {progress} is a pre-formatted byte-transfer string — do not re-format the number inside it.",
        placeholders: { id: "The translation's short id (e.g. 'KJV').", progress: "Pre-formatted byte transfer progress string." },
      },
      "importExport.ebible.committingVerses": {
        description: "Progress line while target-mode verse matches are being committed to the project.",
        placeholders: {
          enqueued: "Number of verses committed so far, already locale-formatted.",
          total: "Total verse count to commit, already locale-formatted.",
        },
      },
      "importExport.paratext.bookProgressLabel": {
        description: "Upload-progress label naming the book currently uploading, on the Paratext import-in-progress screen.",
        placeholders: {
          book: "Name of the book currently uploading.",
          done: "1-based position of this book among the ones being uploaded.",
          total: "Total number of books being uploaded.",
        },
      },
      "importExport.paratext.booksProgressLabel": {
        description: "Fallback upload-progress label when no single book is in focus, on the Paratext import-in-progress screen.",
        placeholders: { done: "Number of books uploaded so far.", total: "Total number of books being uploaded." },
      },
      "importExport.paratext.uploadingBook": {
        description: "In-progress heading naming the book currently uploading, on the Paratext import screen.",
        placeholders: { book: "Name of the book currently uploading." },
      },
      "importExport.paratext.fetchingSource": {
        description: "In-progress heading while fetching the chosen source Bible corpus, on the Paratext target-import flow.",
        placeholders: { title: "Title of the source translation being fetched." },
      },
      "importExport.paratext.cellsProgress": {
        description: "Progress detail line on the Paratext import-in-progress screen.",
        placeholders: {
          count: "Number of cells uploaded so far, already locale-formatted.",
          total: "Total cell count, already locale-formatted.",
          bookLabel: "Pre-rendered book-progress label (bookProgressLabel or booksProgressLabel).",
        },
      },
      "importExport.paratext.projectDetected": {
        description: "Heading on the Paratext preview screen, above the book checklist.",
        placeholders: { count: "Number of books detected in the Paratext project." },
      },
      "importExport.paratext.languageLabel": {
        description: "Language name prefix in the Paratext preview screen's parse summary line.",
        placeholders: { language: "The detected project language, as written in the Paratext project settings — not translated." },
      },
      "importExport.paratext.cellsParsedHint": {
        description: "Parse-summary line on the Paratext preview screen, after the optional languageLabel prefix.",
        placeholders: { count: "Number of cells parsed, already locale-formatted." },
      },
      "importExport.paratext.includeBookAriaLabel": {
        description: "Accessible name for the per-book include/exclude checkbox on the Paratext preview screen.",
        placeholders: { book: "Display name of the book this checkbox controls." },
      },
      "importExport.paratext.showParsedCellsAriaLabel": {
        description: "Accessible name for the per-book expand-to-preview-cells toggle on the Paratext preview screen.",
      },
      "importExport.paratext.bookCellsCount": {
        description: "Per-book cell-count badge on the Paratext preview screen.",
        placeholders: { bookId: "Three-letter USFM book id (e.g. 'GEN') — not translated.", count: "Number of cells this book contains, already locale-formatted." },
      },
      "importExport.paratext.searchTranslationsAriaLabel": {
        description: "Accessible name for the source-translation search field on the Paratext target-import source picker.",
      },
      "importExport.paratext.duplicateRefsCount": {
        description: "Warning badge on a Paratext preview book row when the same verse reference appears more than once.",
        placeholders: { count: "Number of duplicate references found in this book." },
      },
      "importExport.paratext.moreCells": {
        description: "Truncation notice below a book's first few previewed cells on the Paratext preview screen.",
        placeholders: { count: "Number of additional cells not shown, already locale-formatted." },
      },
      "importExport.upload.idmlCountSuffix": {
        description:
          "Parenthesized progress fragment appended to idmlPhase when an IDML package has more than one internal part — e.g. ' (2/5)'. Keep the leading space and parentheses.",
        placeholders: { completed: "Number of internal parts processed so far.", total: "Total number of internal parts." },
      },
      "importExport.upload.idmlPhase": {
        description:
          "In-progress phase label while parsing an uploaded IDML package on the main Upload files panel. {action} is one of idmlChecking/idmlOpening/idmlReading, already translated; {count} is the optional idmlCountSuffix fragment or an empty string.",
        placeholders: {
          action: "Pre-translated verb (Checking/Opening/Reading).",
          fileName: "Name of the file being processed — not translated.",
          count: "Optional pre-rendered '(n/m)' progress suffix, or empty string.",
        },
      },
      "importExport.upload.readingFile": {
        description: "Parse-phase progress label on the Upload files panel for a file whose format is recognized.",
        placeholders: { fileName: "Name of the file being read — not translated." },
      },
      "importExport.upload.analyzingFile": {
        description: "Parse-phase progress label on the Upload files panel for a file needing AI-assisted format detection.",
        placeholders: { fileName: "Name of the file being analyzed — not translated." },
      },
      "importExport.upload.uploadingFile": {
        description: "Upload-phase progress label on the Upload files panel, naming the file currently uploading.",
        placeholders: { fileName: "Name of the file currently uploading — not translated." },
      },
      "importExport.upload.cellsProgress": {
        description: "Upload progress detail line on the main Upload files panel.",
        placeholders: {
          count: "Number of cells uploaded so far, already locale-formatted.",
          total: "Total cell count, already locale-formatted.",
        },
      },
      "importExport.dialog.finishSaveFailed": {
        description:
          "Inline retryable error shown when the final project handoff after an import fails (e.g. closing the dialog, or dismissing the partial-import result screen).",
        placeholders: { message: "Raw underlying error message." },
      },
      "importExport.dialog.saveFailed": {
        description: "Inline retryable error shown when confirming the post-import direction prompt fails to save.",
        placeholders: { message: "Raw underlying error message." },
      },
    },
  },
  surfaces: [],
})
