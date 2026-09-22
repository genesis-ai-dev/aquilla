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
    "importExport.result.closing": "Closing…",

    // — Direction panel (post-import prompt to confirm source/target language) —
    "importExport.direction.intro":
      "We detected the source language from the imported project. Please confirm the " +
      "source and set the target language so back-translation and QA rules work correctly.",
    "importExport.direction.sourcePlaceholder": "e.g. English, arb, hbo",
    "importExport.direction.targetLabel": "Target language",
    "importExport.direction.targetPlaceholder": "e.g. Spanish, fra, swh",
    "importExport.direction.changeLaterHint": "You can change these later in {path}.",
    "importExport.direction.settingsBreadcrumb": "Project Settings → Project Info",
    "importExport.direction.setting": "Setting…",
    "importExport.direction.setDirection": "Set direction",

    // — Shared across format panels —
    "importExport.action.importing": "Importing…",
    "importExport.errors.importFailed": "Import failed",

    // — Google Drive import panel (AQU-823) —
    "importExport.googleDrive.notConfigured":
      "Google Drive import isn't configured for this deployment (missing VITE_GOOGLE_CLIENT_ID / VITE_GOOGLE_API_KEY).",
    "importExport.googleDrive.description":
      "Pick files or a whole folder from your Google Drive. Only the items you pick are shared with Aquilla. Google Docs import as DOCX.",
    "importExport.googleDrive.waiting": "Waiting for Google…",
    "importExport.googleDrive.chooseButton": "Choose from Google Drive",
    "importExport.googleDrive.willImportCount": "Will import ({count})",
    "importExport.googleDrive.skippedCount": "Skipped ({count})",
    "importExport.googleDrive.importButton": plural({
      one: "Import {count} file",
      other: "Import {count} files",
    }),
    "importExport.googleDrive.downloadingProgress": "Downloading {done}/{total} from Google Drive…",

    // — Macula Hebrew/Greek panel —
    "importExport.macula.description":
      "Upload a Macula TSV file obtained from {link}. Each TSV file represents one " +
      "biblical book. The Hebrew and Greek word-level morphology (lemma, morph code, " +
      "Strong's) will be preserved alongside the verse text.",
    "importExport.macula.linkText": "Clear Bible's Macula project",
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
    "importExport.tn.linkText": "unfoldingWord-style Translation Notes",
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
    "importExport.sdbh.dictionaryName": "Semantic Dictionary of Biblical Hebrew",
    "importExport.sdbh.chooseMaster": "Choose master edition (SDBH-en.JSON)",
    "importExport.sdbh.chooseLocalized": "Choose localized edition (optional)",
    "importExport.sdbh.parsingLexicon": "Parsing lexicon…",
    "importExport.sdbh.uploadingSource": "Uploading source",
    "importExport.sdbh.prefillingTranslations": "Pre-filling translations",
    "importExport.sdbh.fileProgress": "file {index} / {count}",
    "importExport.sdbh.cellsProgress": "{enqueued} / {total} cells",
    "importExport.sdbh.notImported.title": "Some reference lists will not be imported",
    "importExport.sdbh.notImported.body": plural({
      one:
        "{count} contextual meaning lists more than {max} verse references. Its reference list is " +
        "too large to store on the cell, so the cell will be marked “Not imported” for that field.",
      other:
        "{count} contextual meanings list more than {max} verse references. Their reference lists " +
        "are too large to store on the cells, so those cells will be marked “Not imported” for that field.",
    }),
    "importExport.sdbh.notImported.exportNote":
      "The lexicon text itself imports in full. Exports rebuild from the preserved edition file, " +
      "so the original reference data is unchanged.",
    "importExport.sdbh.notImported.item": "{lemma} — {count} references",
    "importExport.sdbh.notImported.more": "+{count} more",
    "importExport.sdbh.notImported.cancel": "Cancel import",
    "importExport.sdbh.notImported.proceed": "Import anyway",

    // — Biblica Study Bible Notes (IDML) panel —
    "importExport.biblica.description":
      "Upload the InDesign (.idml) package for a Biblica study Bible. Only the study " +
      "notes are imported — the Bible text is skipped, because it comes from the " +
      "published scripture files rather than being retyped here. Each note keeps its " +
      "InDesign formatting locked, and the notes carry the book and chapter range they " +
      "belong to so they stay in step with the passage. Lists that InDesign holds in a " +
      "single paragraph — cross-references, glossaries, outlines — always arrive as one " +
      "cell per line. Optionally, longer note blocks can also be split into one cell per " +
      "sentence; export puts each block back together as InDesign set it. The study " +
      "Bible's front and back matter — contents, “how to use”, the Bible Dictionary, " +
      "the timelines, the maps, the cover — imports here too: those volumes hold no " +
      "Bible text, so all of their text is imported, grouped by their headings.",
    "importExport.biblica.descriptionTreasureHunt":
      "Upload the InDesign (.idml) package for a Treasure Hunt Bible volume. " +
      "Everything set around the Bible text is imported — the fact and hunt blocks, " +
      "the book introductions, and the front matter — while the Bible text itself is " +
      "skipped, because it comes from the published scripture files rather than being " +
      "retyped here. Each note keeps its InDesign formatting locked, and the facts and " +
      "hunts carry the book and chapter they belong to so they stay in step with the " +
      "passage. Lists that InDesign holds in a single paragraph — hunt steps, fact " +
      "bullets, contents entries — always arrive as one cell per line. Optionally, " +
      "longer blocks can also be split into one cell per sentence; export puts each " +
      "block back together as InDesign set it.",
    "importExport.biblica.descriptionReach4Life":
      "Upload the InDesign (.idml) package for a Reach 4 Life section or scripture " +
      "volume. The workbook around the Bible text is imported — the lessons and " +
      "journeys, the hot topics, the book introductions, and the front and back " +
      "matter — while the continuous Bible text is skipped, because it comes from the " +
      "published scripture files rather than being retyped here. Verses quoted inside " +
      "a lesson stay with the lesson. Each cell keeps its InDesign formatting locked " +
      "and carries the section it belongs to, so the workbook stays navigable. Lists " +
      "that InDesign holds in a single paragraph — contents entries, journey steps, " +
      "bullet advice — always arrive as one cell per line. Optionally, longer " +
      "paragraphs can also be split into one cell per sentence; export puts each one " +
      "back together as InDesign set it.",
    "importExport.biblica.descriptionEbl":
      "Upload the InDesign (.idml) package for an Equipping Biblical Leaders " +
      "facilitator or participant guide. Every text-bearing paragraph is imported — " +
      "the guide is written material throughout rather than a Bible with notes around " +
      "it — and each cell keeps its InDesign formatting locked. The guide's own " +
      "headings become the file's sections, so the navigator moves a topic or a lesson " +
      "at a time. Lists that InDesign holds in a single paragraph — objectives, " +
      "materials, contents entries — always arrive as one cell per line. Optionally, " +
      "longer paragraphs can also be split into one cell per sentence; export puts " +
      "each one back together as InDesign set it.",
    "importExport.biblica.chooseFile": "Choose study Bible IDML file",
    "importExport.biblica.chooseFileTreasureHunt": "Choose Treasure Hunt IDML file",
    "importExport.biblica.chooseFileReach4Life": "Choose Reach 4 Life IDML file",
    "importExport.biblica.chooseFileEbl": "Choose EBL IDML file",
    "importExport.biblica.editionQuestion": "Which Biblica title is this?",
    "importExport.biblica.editionQuestionHint":
      "Each title uses its own InDesign template, and nothing in the package says " +
      "which one it is. Tick at most one. Leave all three unticked to read the " +
      "package as Biblica Study Bible notes.",
    "importExport.biblica.treasureHuntLabel": "This is a Treasure Hunt Bible file",
    "importExport.biblica.treasureHuntHint":
      "The Treasure Hunt Bible uses a different InDesign template. Tick this to " +
      "import its facts, hunts, book introductions and front matter instead of " +
      "looking for study notes.",
    "importExport.biblica.reach4lifeLabel": "This is a Reach 4 Life file",
    "importExport.biblica.reach4lifeHint":
      "Reach 4 Life uses a third InDesign template. Tick this to import its " +
      "lessons, journeys, hot topics, book introductions and front matter instead " +
      "of looking for study notes.",
    "importExport.biblica.eblLabel": "This is an EBL file",
    "importExport.biblica.eblHint":
      "Equipping Biblical Leaders guides use a fourth InDesign template. Tick this " +
      "to import the whole guide, split into sections by its own topic and lesson " +
      "headings, instead of looking for study notes.",
    "importExport.biblica.splitSentencesLabel": "Split long notes into one cell per sentence",
    "importExport.biblica.splitSentencesHint":
      "Leave unchecked to import each note line as one larger cell. Lists still split per line either way.",
    "importExport.biblica.readingPackage": "Reading the InDesign package…",
    "importExport.biblica.readingPackageWithProgress": "Reading the InDesign package… ({completed} / {total})",
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
    "importExport.landing.tn.title": "Translation Notes",
    "importExport.landing.tn.hint": "TSV",
    "importExport.landing.tn.description": "unfoldingWord notes, shown beside the matching verse as you translate.",
    "importExport.landing.biblica.title": "Biblica Study Bible Notes",
    "importExport.landing.biblica.hint": "IDML",
    "importExport.landing.biblica.description":
      "Notes from an InDesign study Bible, Treasure Hunt Bible or Reach 4 Life package — imports the notes only and leaves the scripture untouched.",
    "importExport.landing.obs.title": "Open Bible Stories",
    "importExport.landing.obs.hint": "door43",
    "importExport.landing.obs.description": "Narrative stories with reference images, from unfoldingWord/door43.",
    "importExport.landing.dcs.title": "Door43 (DCS)",
    "importExport.landing.dcs.hint": "upstream",
    "importExport.landing.dcs.description":
      "Import any released Door43 resource as source and pin it to a release — pull upstream changes later.",
    "importExport.landing.gdrive.title": "Google Drive",
    "importExport.landing.gdrive.hint": "cloud",
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
    "importExport.upload.formatsTranslation": "XLIFF/XLF, TMX, CSV/TSV",
    "importExport.upload.categoryDocuments": "Documents",
    "importExport.upload.formatsDocuments": "DOCX, TXT, MD, HTML, EPUB, JSON/ARB, PPTX, IDML (InDesign)",
    "importExport.upload.categoryLocalization": "Localization",
    "importExport.upload.formatsLocalization": "PO/POT, Java properties",
    "importExport.upload.categorySubtitles": "Subtitles",
    "importExport.upload.formatsSubtitles": "VTT, SRT, SBV",
    "importExport.upload.categoryParatextProject": "Paratext project",
    "importExport.upload.zipOrFolder": ".zip or folder",
    "importExport.upload.categoryOtherFormats": "Other formats",
    "importExport.upload.otherFormatsHint": "AI-assisted when configured, always reviewed before import",

    // — Main ImportDialog shell (title bar + top-level error frames) —
    "importExport.dialog.titleDirection": "Set translation direction",
    "importExport.dialog.titleResult": "Import complete — some items skipped",
    "importExport.dialog.titleCollision": "Re-import detected",
    "importExport.dialog.backToFileSelection": "Back to file selection",
    "importExport.dialog.backToImportTypes": "Back to import types",
    "importExport.dialog.titlePreview": "Import preview",
    "importExport.dialog.titleHelloao": "Bible API (helloao.org)",
    "importExport.dialog.titleTn": "Translation Notes (TSV)",
    "importExport.dialog.titleSpreadsheet": "Spreadsheet (CSV / XLSX)",
    "importExport.dialog.titlePaired": "Paired Translation Import",
    "importExport.dialog.titleFileTarget": "Import target translations",
    "importExport.dialog.finishSaveFailed": "Couldn't finish saving your import — please try again. ({message})",
    "importExport.dialog.saveFailed": "Couldn't save your import — please try again. ({message})",
    "importExport.dialog.pairedNeedsSourceCells":
      "Paired translation import requires existing source cells in this project. Import source files first.",

    // — IDML export format copy (src/lib/idml/release-gate.ts rollout stages) —
    "importExport.idml.labelNative": "InDesign (.idml)",
    "importExport.idml.descriptionNative":
      "Adobe-validated native IDML round-trip. Protected translations are written only into their " +
      "original text slots; layout reflow and overset remain possible when translated text length " +
      "or font coverage changes.",
    "importExport.idml.labelBeta": "InDesign IDML (beta)",
    "importExport.idml.descriptionBeta":
      "Protected IDML round-trip beta. Export is blocked if any locator or anchor cannot be proven, " +
      "and Adobe validation evidence is required for every release.",
    "importExport.idml.labelInternal": "InDesign IDML (internal preview)",
    "importExport.idml.descriptionInternal": "Internal protected-content preview. Native formatting fidelity is not claimed.",
    "importExport.idml.labelExperimental": "InDesign IDML (experimental)",
    "importExport.idml.descriptionExperimental":
      "Protected translations are written only into their original text slots while the rest of the " +
      "IDML package stays unchanged. Export is blocked if any locator or protected anchor cannot be " +
      "proven. Adobe-native fidelity is not claimed until the automated InDesign gate passes.",

    // — Export dialog: format list (BASE_FORMAT_OPTIONS) —
    "importExport.format.usfm.label": "USFM",
    "importExport.format.usfm.description":
      "Round-trip USFM with translations injected back into the original markup. Requires the " +
      "original file data on the server (re-import to enable for older files).",
    "importExport.format.docx.label": "Word (.docx)",
    "importExport.format.docx.description":
      "Translations injected back into the original Word document. Paragraph/heading structure is " +
      "preserved; per-run bold/italic inside translated paragraphs is not preserved. Requires the " +
      "original file to have been imported after round-trip export support was added — files " +
      "imported before then may lack a stored original (re-import to enable).",
    "importExport.format.pptx.label": "PowerPoint (.pptx)",
    "importExport.format.pptx.description":
      "Translations injected back into the original slide deck. Slide/shape/paragraph structure is " +
      "preserved; mixed per-run formatting inside a translated paragraph keeps the first run's " +
      "styling. Requires the original file to have been imported after round-trip export support " +
      "was added — re-import older files to enable.",
    "importExport.format.sdbhXml.label": "SDBH XML (MARBLE)",
    "importExport.format.sdbhXml.description":
      "Localized lexicon reinjected into the original MARBLE XML edition — pick the original " +
      "SDBH-<lang>.XML as the skeleton. Whole-project export across all lexicon files.",
    "importExport.format.txt.label": "Plain text",
    "importExport.format.txt.description":
      "Round-trip plain text: paragraph structure preserved; untranslated paragraphs keep source " +
      "(media lines use their transcription).",
    "importExport.format.md.label": "Markdown",
    "importExport.format.md.description":
      "Round-trip markdown: headings, ordered/unordered lists and quotes reconstructed; untranslated " +
      "blocks keep source (media lines use their transcription).",
    "importExport.format.tsv.label": "Bilingual TSV",
    "importExport.format.tsv.description": "id/source/target tab-separated, one row per segment.",
    "importExport.format.csv.label": "Bilingual CSV",
    "importExport.format.csv.description": "RFC 4180 id/source/target, one row per segment.",
    "importExport.format.xlf.label": "XLIFF 1.2",
    "importExport.format.xlf.description":
      "Bilingual XLIFF for CAT tools — schema-valid, segment states mapped, imported inline tags " +
      "preserved for unedited segments.",
    "importExport.format.tmx.label": "TMX 1.4b",
    "importExport.format.tmx.description":
      "Translation memory exchange — DTD-valid, imported inline tags preserved for unedited pairs.",
    "importExport.format.srt.label": "SRT (subtitles)",
    "importExport.format.srt.description":
      "SubRip subtitles: numbered cues with millisecond timecodes; translated text per cue, source " +
      "kept for untranslated cues (media lines use their transcription).",
    "importExport.format.vtt.label": "WebVTT (subtitles)",
    "importExport.format.vtt.description":
      "Subtitle file with timed cues. Cast-assigned cells are wrapped in <v Name> voice tags for " +
      "round-trip speaker identity.",
    // AQU-646: the character export is the one long enough that you close the
    // dialog and do something else, so it reports through a toast as well.
    "importExport.status.preparingCharacterExport": "Preparing the character export…",
    "importExport.status.decodingPercent": "Decoding recordings — {pct}%",
    "importExport.status.buildingArchive": "Building the archive…",
    "importExport.format.audioByCharacter.label": "Audio by character",
    // AQU-646: rewritten from "clips concatenated" — the export no longer
    // butts takes end to end. Each one is placed at its own second on a track
    // of silence, so the files drop onto a DAW already aligned.
    "importExport.format.audioByCharacter.description":
      "One WAV per character, with every take at its own place on the timeline and silence in " +
      "between. All files start at 0:00, so they drop onto a DAW already aligned with each other " +
      "and with the film.",
    "importExport.format.audioByLine.label": "Audio by line",
    "importExport.format.audioByLine.description":
      "One file per recording, numbered in playing order and named by character. Each WAV carries " +
      "a broadcast timestamp a DAW can place from, and a manifest.csv lists every file with its " +
      "timecode. For reviewing and re-recording individual lines.",
    "importExport.format.characterSheets.label": "Character sheets (corrected)",
    "importExport.format.characterSheets.description":
      "Both character spreadsheets back — subtitle and audio — in her own columns, with every " +
      "resolved disagreement applied. Lines still in dispute go back exactly as they came.",
    "importExport.format.projectReport.label": "Project report",
    "importExport.format.projectReport.description":
      "One document for the whole project: open disagreements, what is recorded and what is not, " +
      "cues with no subtitle behind them, the timing correction each episode was imported with, " +
      "characters spelled more than one way, and any episode that could not be read.",
    "importExport.format.plainTextDump.label": "Plain-text dump",
    "importExport.format.plainTextDump.description": "Every translated segment, one per line. Quick content extraction only.",
    "importExport.format.metadataCsv.label": "Metadata spreadsheet",
    "importExport.format.metadataCsv.description":
      "Cast (voice/character), camera angle, and cell ref — one row per cell. Export only; the " +
      "project remains the source of truth.",

    // — Export dialog shell —
    "importExport.dialog.downloadFile": "Download {fileName}",
    "importExport.dialog.nativeFormatHint": "{label} — your file in its original format, with current translations.",
    "importExport.dialog.someFormattingMayNotCarryOver": "Some inline formatting may not carry over.",
    // AQU-1068 (rewritten 2026-09-09): shown beside a native round-trip format
    // when this file has cells somebody added or removed in the app. These
    // exports put translations back into the client's OWN file, so what happens
    // to that content differs per format and is worth saying plainly rather
    // than warning about.
    //
    // Its predecessor said added cells could never be included. That is no
    // longer true for USFM, Word or PowerPoint, and it was never true for the
    // rendered formats it also reached (csv, tsv, xliff, tmx, md, txt all carry
    // added lines fine — see exporters/added-lines.test.ts).
    "importExport.dialog.structuralNoteUsfm":
      "Content added here is written into the verse it follows, with no new verse number. " +
      "Content removed here is left out.",
    "importExport.dialog.structuralNoteDocx":
      "Content added here becomes a new paragraph after the one it follows. " +
      "Content removed here is left out.",
    "importExport.dialog.structuralNotePptx":
      "Content added here becomes a new paragraph after the one it follows, and a slide may " +
      "overflow. Content removed here is left out.",
    "importExport.dialog.structuralNoteUnplaceable":
      "Cells can\u2019t be added or removed on this kind of file, so this export matches the original.",
    "importExport.dialog.structuralNoteLegacy":
      "This file was imported before we recorded where each paragraph came from, so content " +
      "added or removed here can\u2019t be placed in it.",
    "importExport.dialog.formatOptionAriaLabel": "{label} ({ext})",
    "importExport.dialog.lossyBadge": "lossy",
    "importExport.dialog.permissionRequiredAriaLabel": "Export permission required",
    "importExport.dialog.noExportPermission": "You don't have export permission",
    "importExport.dialog.permissionExplanation":
      "An organization owner has restricted exporting to higher roles. Ask an owner to raise your " +
      "role, or read how roles and permissions work.",
    "importExport.dialog.permissionsLinkText": "Roles & permissions — help.aquilla.app",
    "importExport.dialog.validationDoesNotBlockAriaLabel": "Validation flags do not block export",
    "importExport.dialog.outstandingFlagsNote": plural({
      one: "This file has {count} outstanding validation flag (terminology, HTML/markup, punctuation, etc.). These {wontBlock} — download now and resolve them anytime.",
      other: "This file has {count} outstanding validation flags (terminology, HTML/markup, punctuation, etc.). These {wontBlock} — download now and resolve them anytime.",
    }),
    "importExport.dialog.wontBlockExport": "won't block your export",
    "importExport.dialog.exportToAnotherFormat": "Export to another format",
    "importExport.dialog.formatLegend": "Format",
    "importExport.dialog.formatGroupAriaLabel": "Export format",
    "importExport.dialog.scopeLegend": "Scope",
    "importExport.dialog.scopeGroupAriaLabel": "Export scope",
    "importExport.dialog.scopeProject": "Whole project",
    "importExport.dialog.scopeNotSupportedHint": "Project scope not supported for this format.",
    "importExport.dialog.scopeAlwaysProjectHint": "This format always exports the whole project.",
    "importExport.dialog.chooseSdbhSkeleton": "Choose skeleton (SDBH-<lang>.XML)",
    "importExport.dialog.sdbhSkeletonHint":
      "Usually the same edition you imported — its structure is preserved byte-for-byte; only the " +
      "localized definition, gloss, comment, and domain-label text is replaced.",
    "importExport.dialog.voiceLegend": "Voice",
    "importExport.dialog.voiceFilterAriaLabel": "Filter export by voice",
    "importExport.dialog.allVoices": "All voices",
    "importExport.dialog.voiceFilterHint": "Export will include only cells assigned to {voice}, across all camera angles.",
    // — AQU-1148: what the exported file is allowed to contain. The hints say
    //   exactly what lands in the file, because "approved text" was being
    //   claimed for output that mixed validated text, unreviewed drafts and
    //   untranslated source. —
    "importExport.dialog.contentLegend": "Content",
    "importExport.dialog.contentModeAriaLabel": "What the exported file contains",
    "importExport.dialog.contentModeCurrent": "Current translations",
    "importExport.dialog.contentModeValidatedOnly": "Validated translations only",
    "importExport.dialog.contentModeCurrentHint":
      "Every cell's current text — validated, unvalidated draft and AI draft alike. " +
      "Untranslated cells are filled with the source text, so the file will not show " +
      "which parts are approved.",
    "importExport.dialog.contentModeValidatedOnlyHint":
      "Only cells that meet this project's validation threshold. Everything else is left " +
      "out — no unreviewed drafts and no source-language filler.",
    "importExport.dialog.contentModeValidatedOnlyRoundTripHint":
      "Only cells that meet this project's validation threshold are written into your " +
      "original document. Anything else keeps the words already in the file you uploaded.",
    "importExport.dialog.contentModeValidatedCount":
      plural({
        one: "{validated} of {count} cell in this file is validated.",
        other: "{validated} of {count} cells in this file are validated.",
      }),
    "importExport.dialog.chapterFilterAriaLabel": "Filter export by chapter",
    "importExport.dialog.allChapters": "All chapters",
    "importExport.dialog.chapterFilterHint": "Export will include only the cells in {chapter}.",
    "importExport.dialog.filenameLegend": "Filename",
    "importExport.dialog.filenameAriaLabel": "Export filename (without extension)",
    "importExport.dialog.projectScopeUsesProjectName": "Project-scope exports use the project name.",
    "importExport.dialog.appendTimestamp": "Append timestamp",
    "importExport.dialog.appendLangTag": "Append language tag",
    "importExport.dialog.noCellsWithAudio": "No cells with audio found in this file.",
    "importExport.dialog.clipCount": plural({ one: "{count} clip", other: "{count} clips" }),

    // — Export dialog: subtitle-shape checkboxes (rendered on the dubbing
    //   file's own card, and in the fold for anything converting to VTT) —
    "importExport.dialog.subtitleFileHeading": "Subtitle file",
    "importExport.dialog.vttSplitCues": "Split overlapping cues",
    "importExport.dialog.vttSplitCuesHint":
      "Where two characters speak at once, both lines share one cue instead of overlapping — the " +
      "shape some subtitle tools require.",
    "importExport.dialog.vttIncludeSource": "Include the source text",
    "importExport.dialog.vttIncludeSourceHint":
      "Each cue carries the original line above the translation — for playing against the film " +
      "and checking the two line by line.",
    "importExport.dialog.vttExcludeLabels": "Leave out character names",
    "importExport.dialog.vttExcludeLabelsHint":
      "For a tool that would show the speaker tags as literal text.",

    // — Export dialog: who is recorded and who is not (audio export preview) —
    "importExport.dialog.characterPreviewHeading": "Preview",
    "importExport.dialog.noCharactersInFile": "No characters found in this file.",
    "importExport.dialog.characterLineCount": plural({
      one: "{count} line",
      other: "{count} lines",
    }),
    "importExport.dialog.stillToRecordCount": "{count} still to record",
    "importExport.dialog.untimedClipCount": "{count} untimed",
    "importExport.dialog.nothingRecordedYet": "Nothing is recorded yet, so there is nothing to export.",
    "importExport.dialog.nothingOnMainTrack": plural({
      one: "Nothing is recorded on the main Target audio track — {count} take is on an added track. Export by line to include it.",
      other: "Nothing is recorded on the main Target audio track — {count} takes are on added tracks. Export by line to include them.",
    }),
    "importExport.dialog.unrecordedCharacterCount": plural({
      one: "{count} character with nothing recorded yet",
      other: "{count} characters with nothing recorded yet",
    }),
    "importExport.dialog.untimedRecordingsNote": plural({
      one: "{count} recording has no timing and cannot be placed.",
      other: "{count} recordings have no timing and cannot be placed.",
    }),

    // — Export dialog: the per-section cards a dubbing file gets —
    "importExport.dialog.audioSectionTitle": "Audio",
    "importExport.dialog.audioShapeGroupAriaLabel": "Audio export shape",
    "importExport.dialog.audioAddedTracksNote":
      "Only the main Target audio track is included. Export by line to get the tracks you have added.",
    "importExport.dialog.exportAudio": "Export audio",
    "importExport.dialog.srtExportSectionTitle": "SRT export",
    "importExport.dialog.vttExportSectionTitle": "VTT export",
    "importExport.dialog.subtitleTargetGroupAriaLabel": "Which subtitles to export",
    "importExport.dialog.lossyWarningAriaLabel": "Lossy format warning",
    "importExport.dialog.lossyWarningText":
      "This format is lossy — inline markup, paragraph structure, and some metadata will not " +
      "round-trip back to the original format.",
    "importExport.dialog.advanced": "Advanced",
    "importExport.dialog.advancedFormatsAriaLabel": "Advanced export formats",
    "importExport.dialog.whatThisLoses": "What this loses:",
    "importExport.dialog.plainTextDumpDetail":
      "Every translated segment, one per line — for quick content extraction. {whatThisLoses} " +
      "footnotes, cross-references, poetry layout, headings, paragraph markers, bold/italic " +
      "character markup, back-translations, validation state, and untranslated segments. Not " +
      "suitable for re-import.",
    "importExport.dialog.prefixWithRef": "Prefix each line with canonical ref (e.g. {example})",
    "importExport.dialog.downloadOriginalUnchanged": "Download original unchanged",
    "importExport.dialog.repairByReimporting": "Repair by re-importing",
    "importExport.dialog.lossyVerseCount": plural({
      one: "{count} verse contained footnotes, poetry, or character markers in the source USFM — its structure is replaced by plain translated text.",
      other: "{count} verses contained footnotes, poetry, or character markers in the source USFM — their structure is replaced by plain translated text.",
    }),
    "importExport.dialog.fidelityWarningsHeader": plural({
      one: "{count} segment lost inline formatting in this export",
      other: "{count} segments lost inline formatting in this export",
    }),
    "importExport.dialog.andMore": "…and {count} more",
    "importExport.dialog.exportAgain": "Export again",

    // — Export dialog: handleExport status messages —
    "importExport.status.exporting": "Exporting…",
    "importExport.status.downloadingCount": "Downloading {done}/{total}…",
    "importExport.status.exportedFilesCount": plural({ one: "Exported {count} file", other: "Exported {count} files" }),
    "importExport.status.skippedOlderImports": "skipped {count} (older imports — re-import to enable)",
    "importExport.status.exportedFile": "Exported {fileName}",
    "importExport.status.fetchingOriginalDocument": "Fetching original document…",
    "importExport.status.fetchingOriginalPresentation": "Fetching original presentation…",
    "importExport.status.injectingTranslations": "Injecting translations…",
    "importExport.status.downloadedNoTranslations": "Downloaded {fileName} (no translations to inject — download original structure)",
    "importExport.status.downloadedParagraphsTranslated": plural({
      one: "Downloaded {fileName} ({count} paragraph translated)",
      other: "Downloaded {fileName} ({count} paragraphs translated)",
    }),
    "importExport.status.validatingProtectedTranslations": "Validating protected translations…",
    "importExport.status.downloadedIdmlUnchanged": "Downloaded {fileName} (no translations — original bytes returned unchanged)",
    "importExport.status.decodingAudio": "Decoding audio…",
    "importExport.status.decodingCount": "Decoding {done}/{total}…",
    "importExport.status.exportedAudioByCharacter": "Exported audio by character",
    "importExport.status.exportedAudioByCharacterWithSkipped": plural({
      one: "Exported audio by character ({count} clip skipped)",
      other: "Exported audio by character ({count} clips skipped)",
    }),
    "importExport.status.chooseSkeletonFirst": "Choose the original SDBH-<lang>.XML file as the skeleton first.",
    "importExport.status.stillLoadingCells": "Still loading file cells, please wait…",
    "importExport.status.couldNotLoadProject": "Couldn't load the complete project: {message}",
    "importExport.status.noLexMeaningEntries": "No LEXMeaning entries found — is that file a MARBLE SDBH XML edition?",
    "importExport.status.reinjectedTranslations": "Reinjected {translations} translations into {senses} senses",
    "importExport.status.glossWarnings": plural({
      one: " — {count} gloss warning, check semicolons",
      other: " — {count} gloss warnings, check semicolons",
    }),
    "importExport.status.downloadedMetadataCsvRows": plural({
      one: "Downloaded {fileName} ({count} row)",
      other: "Downloaded {fileName} ({count} rows)",
    }),
    "importExport.status.buildingZip": "Building zip for {count} files…",
    "importExport.status.downloadedFilesCount": plural({ one: "Downloaded {count} file", other: "Downloaded {count} files" }),
    "importExport.status.downloadedFile": "Downloaded {fileName}",
    "importExport.status.exportFailed": "Export failed.",
    "importExport.errors.originalMissing":
      "Original isn't in storage. Re-import to restore it.",

    // — Thrown-error triage: src/lib/import.ts (AQU-832 wave 3 error sweep) —
    // These are messages parser/upload helpers throw that reach the user
    // verbatim via a panel's `catch (err) { setError(err.message) }`. Keyed
    // via the standalone t() since import.ts runs outside React.
    "importExport.errors.ebibleEmptyCorpus":
      "\"{title}\" is not available for download. The eBible corpus file exists but contains no " +
      "text — this translation may be restricted due to copyright.",
    "importExport.errors.noImportableContent": "{fileName} did not contain any content the {fileType} adapter could import.",
    "importExport.errors.sandboxFallbackFailed": "{primary}. Sandbox fallback also failed: {fallback}",
    "importExport.errors.importCouldNotPublish": "Import could not publish any files: {reason}",
    "importExport.errors.emptyFile": "{fileName} is empty.",
    "importExport.errors.unsupportedFileTypeSignIn": "Unsupported file type: {fileName}. Sign in to use AI-assisted format detection.",
    "importExport.errors.obsListFailed": "Failed to list Open Bible Stories content.",
    "importExport.errors.importCancelled": "Import cancelled",
    "importExport.errors.obsDownloadIncomplete": "Open Bible Stories download was incomplete: {files}. Nothing was imported.",
    "importExport.errors.obsNoFilesDownloaded": "No OBS story files could be downloaded",
    "importExport.errors.obsNoFrames": "Open Bible Stories downloaded but produced no frames — check the source.",
    "importExport.errors.helloaoNoVerses": "\"{title}\" downloaded but produced no verses — check the book selection and try again.",
    "importExport.errors.maculaNoVerses": "Macula file parsed but no verses were found — check the file format.",
    "importExport.errors.tnNoValidRows":
      "TN file parsed but no valid note rows were found — check that the first three columns are book, chapter, and verse.",
    "importExport.errors.tnNoValidRowsWithSkipped": plural({
      one:
        "TN file parsed but no valid note rows were found — check that the first three columns are " +
        "book, chapter, and verse. ({count} row skipped due to missing canonical reference)",
      other:
        "TN file parsed but no valid note rows were found — check that the first three columns are " +
        "book, chapter, and verse. ({count} rows skipped due to missing canonical reference)",
    }),
    "importExport.errors.biblicaExpectsIdml": "Biblica study notes import expects an InDesign .idml package.",
    "importExport.errors.biblicaNoStudyNotes":
      "{fileName} parsed successfully but contained no study notes. Biblica notes live in `intro:*` " +
      "paragraph styles — check that this is the notes document.",
    "importExport.errors.invalidIdmlPackage": "{fileName} is not a valid IDML package. IDML files are ZIP archives and start with \"PK\".",
    "importExport.errors.mediaFileTooLarge": "{fileName} exceeds the 95 MB media import limit.",
    "importExport.errors.couldNotDecodeAudio":
      "Couldn't decode {fileName} — the file may be corrupt or in an unsupported codec. Try " +
      "re-exporting it as mp3 or wav.",
    "importExport.errors.notAParatextProject":
      "That doesn't look like a Paratext project — no Settings.xml (or .ssf) with USFM books was found.",

    // — Import preview notices: src/lib/import.ts — non-fatal, shown in the
    //   PreviewPanel's "Review before importing" list alongside the row count
    //   badge. Keyed via the standalone t() since import.ts runs outside React.
    "importExport.notices.basicParserFallback":
      "Aquilla could not verify this structured layout with AI, so it used the basic parser. Check " +
      "the preview carefully before importing.",

    // — Manifest normalization warnings: src/lib/import/normalized-manifest.ts —
    //   Per-unit diagnostics attached to NormalizedImportFile.warnings. Not
    //   yet surfaced by any panel (the array is currently read only for its
    //   `.code` tallies) — keyed now via the standalone t() so the text is
    //   ready the moment a review UI reads `.message`, and so it never drifts
    //   from the catalog like every other lib-authored diagnostic here.
    "importExport.manifestWarnings.emptySource": "The unit has no source text.",
    "importExport.manifestWarnings.missingVerseReference":
      "A verse unit has no parseable canonical Scripture reference.",
    "importExport.manifestWarnings.duplicateCanonicalRef":
      "Canonical reference {ref} occurs more than once.",
    "importExport.manifestWarnings.invalidTiming": "Cue end time must be after its start time.",

    // — Thrown-error triage: src/lib/sync/source-upload.ts —
    "importExport.errors.sourceUploadEmpty": "Source upload failed: the original file is empty.",
    "importExport.errors.sourceUploadTooLarge": "Source upload failed: the original file exceeds the {maxSize} limit.",
    "importExport.errors.couldNotGetUploadToken": "Couldn't get an upload token — sign in and try again.",
    "importExport.errors.sourceUploadNetworkFailed": "Source upload failed: {detail}",
    "importExport.errors.sourceUploadFailed": "Source upload failed",
    "importExport.errors.artifactBindingNetworkFailed": "Artifact binding failed: {detail}",
    "importExport.errors.artifactBindingFailed": "Artifact binding failed",

    // — Thrown-error triage: src/lib/import/cell-size.ts (AQU-990) —
    "importExport.errors.oversizedCells": plural({
      one:
        "Import failed: {count} cell in {fileName} is larger than the {maxSize} per-cell " +
        "limit ({cells}). Split that section in the source document and import again.",
      other:
        "Import failed: {count} cells in {fileName} are larger than the {maxSize} per-cell " +
        "limit ({cells}). Split those sections in the source document and import again.",
    }),
    "importExport.errors.oversizedCellSource": "{label} — source text, {size}",
    "importExport.errors.oversizedCellTarget": "{label} — translation, {size}",
    // No inflected noun to agree with the count, so a single form is correct
    // here rather than a plural() whose English forms would be identical.
    "importExport.errors.oversizedCellsMore": "and {count} more",

    // — Door43 (DCS) sync badge, catalog browser and upstream panel —
    // (importExport.linked.* below is the linked-project upstream-changes
    //  review surface, which is not Door43-specific.)
    "importExport.dcs.anyOwner": "Any owner",
    "importExport.dcs.anySubject": "Any subject",
    "importExport.dcs.applyResyncCheckbox": "I understand removed cells hide their translations.",
    "importExport.dcs.applyResyncConfirmLabel": "Apply re-sync",
    "importExport.dcs.applyResyncConfirmRemovals": plural({
      one: "{count} cell will be removed — translations attached to removed cells will be hidden.",
      other: "{count} cells will be removed — translations attached to removed cells will be hidden.",
    }),
    "importExport.dcs.applyResyncConfirmRepairs": plural({
      one: "{count} cell will be repaired and {created} created.",
      other: "{count} cells will be repaired and {created} created.",
    }),
    "importExport.dcs.applyResyncConfirmTitle": "Apply re-sync?",
    "importExport.dcs.applyResyncEllipsis": "Apply re-sync…",
    "importExport.dcs.badgeAriaLabel": "Door43 source link — open Project Settings",
    "importExport.dcs.catalogIntro": "Browse released resources on {link}. Importing pins the project to the " +
      "chosen release; you can pull later changes from the project's settings. " +
      "Bible (USFM) resources import today; more resource types are rolling " +
      "out.",
    "importExport.dcs.catalogSearchFailed": "Catalog search failed",
    "importExport.dcs.checkFailed": "Could not check for updates: {message}",
    "importExport.dcs.checkForUpdates": "Check for updates",
    "importExport.dcs.customOwnerAriaLabel": "Custom owner",
    "importExport.dcs.customOwnerPlaceholder": "…or type any owner (overrides the picker)",
    "importExport.dcs.detachButton": "Detach from upstream",
    "importExport.dcs.detachConfirmCheckbox": "I understand this permanently unlinks the project.",
    "importExport.dcs.detachConfirmDescription": "This project will stop receiving updates from {repo}. Source cells " +
      "become editable. This cannot be undone from here — relinking requires a " +
      "fresh import.",
    "importExport.dcs.detachConfirmTitle": "Detach from upstream?",
    "importExport.dcs.detachFailed": "Detach failed: {message}",
    "importExport.dcs.detachHint": "Permanently unlink this project from {repo} and make source cells " +
      "editable again.",
    "importExport.dcs.importAdvancesNote": "Importing advances the source cells to {ref}. Downstream linked projects " +
      "will show stale flags for the affected cells so translators can review " +
      "them.",
    "importExport.dcs.importChanges": "Import changes",
    "importExport.dcs.importFailed": "Import failed: {message}",
    "importExport.dcs.importRoleRequired": "Maintainer or above required to import upstream changes.",
    "importExport.dcs.importSummary": "Imported: {created} created, {updated} updated, {removed} removed. " +
      "Downstream linked projects will now show stale flags for the changed " +
      "cells.",
    "importExport.dcs.languageCodeAriaLabel": "Language code",
    "importExport.dcs.languageFilterLabel": "Language",
    "importExport.dcs.loadingCatalog": "Loading catalog…",
    "importExport.dcs.noResults": "No released resources match these filters.",
    "importExport.dcs.noResultsHint": "Try a broader language, owner, or subject.",
    "importExport.dcs.notYetSupportedBadge": "Not yet supported",
    "importExport.dcs.ownerFilterLabel": "Owner",
    "importExport.dcs.panelDescription": "This project mirrors a Door43 resource. Check for a newer published " +
      "release and import upstream changes into the source lane.",
    "importExport.dcs.pinnedRefBadge": "pinned {ref}",
    "importExport.dcs.pinTooltip": "Source synced from {repo} ({subject}) @ {ref} · imported {imported}. " +
      "Source cells are managed by this link — update or detach in Project " +
      "Settings.",
    "importExport.dcs.repairStaleCursorError": "the upstream link changed while confirming (detached or re-imported in " +
      "another tab). Nothing was applied — run the scan again.",
    "importExport.dcs.resyncButton": "Re-sync content",
    "importExport.dcs.resyncFailed": "Re-sync failed: {message}",
    "importExport.dcs.resyncHint": "Scans the source at the pinned version for cells that were imported " +
      "incorrectly. Nothing is changed until you confirm.",
    "importExport.dcs.resyncNoChanges": "Everything already matches the pinned source.",
    "importExport.dcs.resyncRemovalWarning": plural({
      one: "{count} cell will be removed — translations attached to them will be hidden.",
      other: "{count} cells will be removed — translations attached to them will be hidden.",
    }),
    "importExport.dcs.resyncRepaired": plural({
      one: "Repaired {count} cell.",
      other: "Repaired {count} cells.",
    }),
    "importExport.dcs.resyncScanSummary": "Scan complete: {repair} to repair, {created} new, {removed} to remove.",
    "importExport.dcs.settingsBlocked": "blocked ({reason})",
    "importExport.dcs.settingsConflict": "conflict — settings changed elsewhere; try again",
    "importExport.dcs.stageFilterLabel": "Stage",
    "importExport.dcs.stageLatest": "Latest (HEAD)",
    "importExport.dcs.stagePreprod": "Pre-release",
    "importExport.dcs.stageProd": "Released (prod)",
    "importExport.dcs.subjectFilterLabel": "Subject",
    "importExport.dcs.syncTokenError": "Could not mint a sync token for this project.",
    "importExport.dcs.trackingHead": "tracking HEAD",
    "importExport.dcs.trackingRelease": "tracking release",
    "importExport.dcs.unsupportedResourceTooltip": "Aquilla can't import this resource type yet (tracked in AQU-615)",
    "importExport.dcs.updateAvailable": plural({
      one: "{oldRef} → {newRef}, {count} file changed",
      other: "{oldRef} → {newRef}, {count} files changed",
    }),
    "importExport.dcs.upToDateWith": "Up to date with {ref}.",
    "importExport.linked.acceptAllButton": "Accept as-is ({count})",
    "importExport.linked.acceptButton": "Accept as-is",
    "importExport.linked.awaitingTranslationBadge": "awaiting upstream translation",
    "importExport.linked.checking": "Checking for upstream changes…",
    "importExport.linked.flaggedCount": "{count} flagged",
    "importExport.linked.loadError": "Couldn't load upstream changes right now.",
    "importExport.linked.nothingFlagged": "Nothing flagged — this project is current with its upstream source.",
    "importExport.linked.removedUpstreamBadge": "removed upstream",
    "importExport.linked.repinRoleRequired": "Reviewer or above required to accept a change; project lead required to " +
      "accept in bulk.",
    "importExport.linked.selectForBulkAriaLabel": "Select {cell} for bulk repin",
    "importExport.linked.skippedRetranslatedBadge": "skipped — retranslated since",
    "importExport.linked.syncBatchHeading": "Sync batch — {date}",
    "importExport.linked.syncTokenError": "could not obtain a sync token",
    "importExport.linked.tombstonedLine": "This line was removed upstream.",
    "importExport.linked.tombstonedTranslationKept": "Its translation is kept: {translation}",

    // — import-panels batch —
    "importExport.columnMapping.castColumnLabel": "Cast / character",
    "importExport.columnMapping.columnFallbackName": "Column {index}",
    "importExport.columnMapping.createModeHint": "Tell us which column contains each piece of data. Only \"Source text\" is " +
      "required.",
    "importExport.columnMapping.endColumnLabel": "End timestamp",
    "importExport.columnMapping.firstRowIsHeader": "First row is a header",
    "importExport.columnMapping.ignoreOption": "— ignore —",
    "importExport.columnMapping.labelColumnLabel": "Cell label / ref",
    "importExport.columnMapping.mapColumns": "Map columns",
    "importExport.columnMapping.previewRowsHeading": plural({
      one: "Preview (first {count} data row)",
      other: "Preview (first {count} data rows)",
    }),
    "importExport.columnMapping.sourceColumnLabel": "Source text",
    "importExport.columnMapping.startColumnLabel": "Start timestamp",
    "importExport.columnMapping.targetColumnLabel": "Target translation",
    "importExport.columnMapping.targetModeHint": "Pick the column with the translations. Map a ref column to match by " +
      "reference; leave it unmapped to match rows to cells in order.",
    "importExport.columnMapping.typeColumnLabel": "Content type",
    "importExport.errors.failedToParseFile": "Failed to parse file",
    "importExport.fileTarget.acceptedFormats": "USFM, CSV, TSV, XLSX, VTT, SRT, or SBV",
    "importExport.fileTarget.description": "Fills this file's target column from a USFM file, spreadsheet, or " +
      "subtitle file. Source text is never changed. You'll review every match " +
      "before anything is saved.",
    "importExport.fileTarget.dropZoneHint": "Drop a file here, or",
    "importExport.fileTarget.noCuesInSubtitle": "No subtitle cues found in this file.",
    "importExport.fileTarget.noCuesInVtt": "No cues found in this VTT file.",
    "importExport.fileTarget.noVersesInUsfm": "No verses found in this USFM file.",
    "importExport.fileTarget.title": "Import target translations into \"{fileName}\"",
    "importExport.fileTarget.unsupportedFileType": "Unsupported file type. Use USFM (.usfm/.sfm), a spreadsheet " +
      "(.csv/.tsv/.xlsx), or a subtitle file (.vtt/.srt/.sbv).",
    "importExport.paired.applyingTargets": "Applying target translations to cells.",
    "importExport.paired.description": "Upload a CSV or XLSX file where each row has both source and target " +
      "text. Rows are matched to existing source cells by canonical reference.",
    "importExport.paired.title": "Import paired source + target",
    "importExport.preview.aiAssistedStructure": "AI-assisted structure",
    "importExport.preview.commitFailed": "Import failed: {error}",
    "importExport.preview.confidencePercent": "{percent}% confidence",
    "importExport.preview.confirmImport": "Confirm import",
    "importExport.preview.epubChaptersTitle": "Chapters in this book",
    "importExport.preview.epubRoleChapter": "Chapter",
    "importExport.preview.epubRoleNavigation": "Table of contents",
    "importExport.preview.epubRoleCover": "Cover",
    "importExport.preview.epubRoleNotes": "Notes",
    "importExport.preview.epubRoleEmpty": "No text",
    "importExport.preview.includeEpubMember": "Include {title}",
    "importExport.preview.headerSummary": "Preview — {cells} across {files}",
    "importExport.preview.instructions": "Review what will be imported, then click Confirm to upload.",
    "importExport.preview.needsCarefulReview": "Needs careful review",
    "importExport.preview.recipeNote": "Recipe: {name}. The original is preserved; translated round-trip is not " +
      "yet verified.",
    "importExport.preview.reviewBeforeImporting": "Review before importing",
    "importExport.preview.structuralContentAriaLabel": "Structural content",
    "importExport.review.alreadyThereCount": plural({
      one: "{count} already there",
      other: "{count} already there",
    }),
    "importExport.review.brokenTimecodeCount": plural({
      one: "{count} broken timecode",
      other: "{count} broken timecodes",
    }),
    "importExport.review.conflictCount": plural({
      one: "{count} conflict",
      other: "{count} conflicts",
    }),
    "importExport.review.contestedWarning": plural({
      one: "{count} row competed with another cue for the same line and was left unticked. " +
        "Check it before importing.",
      other: "{count} rows competed with another cue for the same line and were left " +
        "unticked. Check them before importing.",
    }),
    "importExport.review.deselectAll": "Deselect all",
    "importExport.review.importCellCount": plural({
      one: "Import {count} cell",
      other: "Import {count} cells",
    }),
    "importExport.review.looseFitWarning": "Many cues only partly overlap the lines they were paired with. The file may be " +
      "offset in time, or cut into different lines than this one. Check the pairings " +
      "before importing.",
    "importExport.review.matchedCount": "{count} matched",
    "importExport.review.orderMatchWarning": "Incoming rows carry no reference, so they were matched to cells in " +
      "order. Check the source text next to each row to confirm alignment " +
      "before importing.",
    "importExport.review.reasonBackwardsTimecode": "Timecode ends before it starts",
    "importExport.review.reasonLostItsLine": "Lost its line to another cue",
    "importExport.review.reasonNoLineInReach": "No line within reach",
    "importExport.review.replacesExisting": "Replaces: {text}",
    "importExport.review.rowAlreadyThere": "Already there",
    "importExport.review.rowContested": "Competed for the same line, check both",
    "importExport.review.rowSharedTiming": "Same timing as another cue, check which is which",
    "importExport.review.sharedTimingWarning": plural({
      one: "{count} row has exactly the same timing as another cue, so only file order " +
        "decided its line. It was left unticked.",
      other: "{count} rows have exactly the same timing as another cue, so only file order " +
        "decided their lines. They were left unticked.",
    }),
    "importExport.review.skippedCueCount": plural({
      one: "{count} cue skipped (empty or unreadable)",
      other: "{count} cues skipped (empty or unreadable)",
    }),
    "importExport.review.timebaseNamed": plural({
      one: "Timings in the uploaded file were adjusted from {fromFps} to {toFps} frames per " +
        "second, which lined up {count} more line.",
      other: "Timings in the uploaded file were adjusted from {fromFps} to {toFps} frames per " +
        "second, which lined up {count} more lines.",
    }),
    "importExport.review.timebaseUnnamed": plural({
      one: "Timings in the uploaded file were adjusted by {percent}, which lined up {count} " +
        "more line.",
      other: "Timings in the uploaded file were adjusted by {percent}, which lined up {count} " +
        "more lines.",
    }),
    "importExport.review.timingNote": "Translations keep this file's timings. Timings in the uploaded file are only used " +
      "to find each line.",
    "importExport.review.title": "Review matches",
    "importExport.review.uncoveredCellCount": plural({
      one: "{count} cell not covered",
      other: "{count} cells not covered",
    }),
    "importExport.review.uncoveredListTitle": "Lines left without a translation",
    "importExport.review.uncoveredSourceCellCount": plural({
      one: "{count} source cell not covered",
      other: "{count} source cells not covered",
    }),
    "importExport.review.unmatchedListTitle": "Cues that didn't find a line",
    "importExport.review.unmatchedRowCount": plural({
      one: "{count} unmatched row",
      other: "{count} unmatched rows",
    }),
    "importExport.spreadsheet.acceptedFormats": "CSV, TSV, or XLSX",
    "importExport.spreadsheet.description": "Upload a CSV or XLSX file. You will map columns (source, target, ref, " +
      "cast, timestamps) before importing.",
    "importExport.spreadsheet.dropZoneHint": "Drop a CSV or XLSX file here, or",
    "importExport.spreadsheet.legacyXlsUnsupported": "Legacy .xls workbooks are not supported. Save the file as .xlsx or CSV " +
      "and try again.",
    "importExport.spreadsheet.noDataRows": "No data rows found after applying the mapping. Check that the source " +
      "column is not empty.",
    "importExport.spreadsheet.noSheetsFound": "No sheets found in XLSX file.",
    "importExport.spreadsheet.selectSheetHint": "This XLSX has multiple sheets. Pick one to import.",
    "importExport.spreadsheet.selectSheetTitle": "Select a sheet",
    "importExport.spreadsheet.selectSheetUnitHint": "This XLSX has multiple sheets — each sheet is one importable unit.",
    "importExport.spreadsheet.sendingCells": "Sending cells to the server.",
    "importExport.spreadsheet.sheetRowCount": plural({
      one: "{count} row",
      other: "{count} rows",
    }),
    "importExport.spreadsheet.sourceUnavailable": "The selected spreadsheet is no longer available",
    "importExport.spreadsheet.title": "Spreadsheet import",
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
        description: "Upload progress line on the Translation Notes and Biblica panels: how many note cells have been enqueued.",
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
      "importExport.sdbh.notImported.body": {
        description:
          "Warning shown on the SDBH panel before upload when some contextual meanings have verse-reference lists too long to store in cell metadata. The user can cancel or proceed.",
        placeholders: {
          count: "Number of affected contextual meanings.",
          max: "The reference-count threshold above which a list is not imported, already locale-formatted.",
        },
      },
      "importExport.sdbh.notImported.item": {
        description: "One row in the list of affected contextual meanings under the not-imported warning.",
        placeholders: {
          lemma: "Hebrew headword of the affected entry — literal data, not translated.",
          count: "How many verse references that meaning lists, already locale-formatted.",
        },
      },
      "importExport.sdbh.notImported.more": {
        description: "Trailing row when the affected-meanings list is truncated to its first few entries.",
        placeholders: { count: "Number of additional affected meanings not listed." },
      },
      "importExport.biblica.splitSentencesLabel": {
        description:
          "Visible label AND the checkbox's own accessible name (identical text, reused directly rather than duplicated as a separate aria-label key) for splitting long Biblica study notes into one cell per sentence.",
      },
      "importExport.biblica.treasureHuntLabel": {
        description:
          "Visible label AND the checkbox's own accessible name (identical text, reused directly) for switching the Biblica importer to the Treasure Hunt Bible InDesign template. 'Treasure Hunt Bible' is a product title — keep it recognizable.",
      },
      "importExport.biblica.reach4lifeLabel": {
        description:
          "Visible label AND the checkbox's own accessible name (identical text, reused directly) for switching the Biblica importer to the Reach 4 Life InDesign template. 'Reach 4 Life' is a product title — keep it recognizable.",
      },
      "importExport.biblica.eblLabel": {
        description:
          "Visible label AND the checkbox's own accessible name (identical text, reused directly) for switching the Biblica importer to the Equipping Biblical Leaders InDesign template. 'EBL' is the programme's own abbreviation of 'Equipping Biblical Leaders' and is how Biblica names these files — keep the abbreviation rather than expanding or translating it. Note the article agrees with the abbreviation, not the expansion.",
      },
      "importExport.biblica.editionQuestion": {
        description:
          "Caption above the three mutually exclusive Biblica title checkboxes (Treasure Hunt Bible, Reach 4 Life, EBL). It also names the group for screen readers, so it must read as a question about the file being imported, not as a command.",
      },
      "importExport.biblica.editionQuestionHint": {
        description:
          "Hint under that caption. Explains why the person importing has to answer — the package does not identify its own title — that at most one box applies, and that leaving all three clear reads the file as a Biblica Study Bible notes package (the importer's default).",
      },
      "importExport.biblica.readingPackageWithProgress": {
        description: "Parse-phase progress line on the Biblica panel while unpacking the IDML package, once a file count is known.",
        placeholders: {
          completed: "Number of internal IDML parts processed so far.",
          total: "Total number of internal IDML parts.",
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
          "Download-phase progress line, shared by the eBible panel (source or target mode) and the helloao.org panel. {progress} is a pre-formatted byte-transfer string — do not re-format the number inside it.",
        placeholders: { id: "The translation's short id (e.g. 'KJV' or 'BSB').", progress: "Pre-formatted byte transfer progress string." },
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
      "importExport.dialog.titleFileTarget": {
        description:
          "Title of the dialog that fills in the translated column of the file the reader currently has open, from a document or spreadsheet they upload. A heading naming what the dialog does, not a button. 'Target' here means the translated side of the file, as opposed to the original text being translated from.",
      },
      "importExport.dialog.downloadFile": {
        description: "Label of the primary download button on the Export dialog, naming the exact file it will produce.",
        placeholders: { fileName: "Filename (with extension) the download will produce — not translated." },
      },
      "importExport.dialog.structuralNoteUsfm": {
        description:
          "Appended to the USFM format's hint in the Export dialog, when this file has cells " +
          "somebody added or removed in the app. Says exactly what the export does with them. " +
          "'The verse it follows' matters: an added cell gets no verse number of its own, so " +
          "the client's numbering never changes.",
      },
      "importExport.dialog.structuralNoteDocx": {
        description:
          "The same note for a Word export: an added cell becomes its own paragraph after the " +
          "one it follows, and a removed cell's paragraph is dropped from the document.",
      },
      "importExport.dialog.structuralNotePptx": {
        description:
          "The same note for a PowerPoint export, plus the caveat that a text box has a fixed " +
          "size and does not reflow, so added content can push past the edge of a slide and " +
          "need the box resizing by hand.",
      },
      "importExport.dialog.structuralNoteUnplaceable": {
        description:
          "Shown for a format where cells cannot be added or removed at all — InDesign today, " +
          "whose layout is addressed by position so new or missing paragraphs cannot be " +
          "expressed. Reassures the reader that the export matches their original.",
      },
      "importExport.dialog.structuralNoteLegacy": {
        description:
          "Shown for a Word or PowerPoint file imported before we recorded a locator for each " +
          "paragraph. Those files are matched to the document by POSITION, where inserting or " +
          "dropping a paragraph would shift every later one onto the wrong text, so added and " +
          "removed content cannot be carried at all.",
      },
      "importExport.dialog.nativeFormatHint": {
        description: "Caption below the primary download button, naming the file's own format.",
        placeholders: { label: "The native format's own translated label (e.g. 'USFM')." },
      },
      "importExport.dialog.formatOptionAriaLabel": {
        description: "Accessible name for one radio option in the export-format list.",
        placeholders: { label: "The format's translated label.", ext: "The format's file extension — not translated." },
      },
      "importExport.dialog.permissionRequiredAriaLabel": {
        description: "Accessible name for the permission-gate note shown when org policy forbids export.",
      },
      "importExport.dialog.validationDoesNotBlockAriaLabel": {
        description: "Accessible name for the note reassuring users that outstanding validation flags do not block export.",
      },
      "importExport.dialog.outstandingFlagsNote": {
        description:
          "Body of the non-blocking validation-flags note on the Export dialog. {wontBlock} is a bold-styled phrase rendered by RichMessage.",
        placeholders: {
          count: "Number of outstanding validation flags on the active file.",
          wontBlock: "Bold-styled phrase reading 'won't block your export'.",
        },
      },
      "importExport.dialog.formatGroupAriaLabel": {
        description: "Accessible name for the export-format radio group.",
      },
      "importExport.dialog.scopeGroupAriaLabel": {
        description: "Accessible name for the file/project scope toggle.",
      },
      "importExport.dialog.voiceFilterAriaLabel": {
        description: "Accessible name for the voice-filter select on the Export dialog.",
      },
      "importExport.dialog.voiceFilterHint": {
        description: "Hint below the voice filter once a specific voice is chosen. {voice} is bold-styled, rendered by RichMessage.",
        placeholders: { voice: "Bold-styled name of the selected cast voice." },
      },
      "importExport.dialog.contentModeAriaLabel": {
        description:
          "Accessible name for the content-mode select on the Export dialog — the control that chooses between every current translation and validated translations only (AQU-1148).",
      },
      "importExport.dialog.contentModeValidatedCount": {
        description:
          "Count shown under the content-mode select once 'Validated translations only' is chosen, so the user knows how much of the file will actually be written. 'Validated' means a cell that has met this project's validation threshold.",
        placeholders: {
          validated: "Number of cells in the current file that are validated.",
          count: "Total number of cells in the current file — the number the plural form agrees with.",
        },
      },
      "importExport.dialog.chapterFilterAriaLabel": {
        description: "Accessible name for the chapter-scope select on the Export dialog.",
      },
      "importExport.dialog.chapterFilterHint": {
        description: "Hint below the chapter scope once a single chapter is chosen. {chapter} is bold-styled, rendered by RichMessage.",
        placeholders: { chapter: "Bold-styled label of the selected chapter, e.g. 'GEN 1'." },
      },
      "importExport.dialog.filenameAriaLabel": {
        description: "Accessible name for the export filename input.",
      },
      "importExport.dialog.clipCount": {
        description: "Clip count in the audio-by-character export preview, per cast member.",
        placeholders: { count: "Number of audio clips for this cast member." },
      },
      "importExport.dialog.characterLineCount": {
        description:
          "How many lines one character has recorded, shown next to that character's name in the list of who is recorded on the Export dialog.",
        placeholders: { count: "Number of recorded lines for this character." },
      },
      "importExport.dialog.stillToRecordCount": {
        description:
          "Trailing clause on a character's row in the Export dialog's list of who is recorded, after a bullet separator: how many of that character's lines still have no recording. Reads in place as ' · 4 still to record'.",
        placeholders: { count: "Number of this character's lines that have no recording yet." },
      },
      "importExport.dialog.untimedClipCount": {
        description:
          "Trailing clause on a character's row in the Export dialog's list of who is recorded, after a bullet separator: how many of that character's recordings carry no timing. Reads in place as ' · 2 untimed'.",
        placeholders: { count: "Number of this character's recordings that carry no timing." },
      },
      "importExport.dialog.unrecordedCharacterCount": {
        description:
          "Clickable summary line on the Export dialog that opens the folded-away list of characters nobody has recorded a single line for yet.",
        placeholders: { count: "Number of characters with no recordings at all." },
      },
      "importExport.dialog.untimedRecordingsNote": {
        description:
          "Warning under the Export dialog's list of who is recorded: recordings with no timing cannot be positioned in the exported audio and will be left out.",
        placeholders: { count: "Total number of recordings across all characters that carry no timing." },
      },
      "importExport.dialog.audioShapeGroupAriaLabel": {
        description:
          "Accessible name for the radio group choosing the shape of an audio export — one track per character, or one file per recorded line.",
      },
      "importExport.dialog.nothingOnMainTrack": {
        description:
          "Shown in the by-character preview when the default Target audio row " +
          "holds no recordings but added tracks do. The preview describes the " +
          "by-character deliverable, which reads the default row only, so the " +
          "plain 'nothing is recorded yet' was false on exactly these files — " +
          "and sat beside an Export button that refused for the same reason. " +
          "Names the count and where to find them.",
        placeholders: { count: "How many takes are on added tracks. Always 1 or more." },
      },
      "importExport.dialog.audioAddedTracksNote": {
        description:
          "Shown under the by-character audio export option when the file has " +
          "audio tracks beyond the four it starts with. That export writes one " +
          "track per CHARACTER off the main dub row only, so takes recorded " +
          "onto tracks the user added are not in it — this says so before they " +
          "export, and points at the by-line shape, which does carry them. A " +
          "notice, not a restriction: by character remains selectable.",
      },
      "importExport.dialog.subtitleTargetGroupAriaLabel": {
        description:
          "Accessible name for the radio group choosing which subtitles to export: the translated lines, or the lines heard in the recorded audio.",
      },
      "importExport.dialog.lossyWarningAriaLabel": {
        description: "Accessible name for the lossy-format warning banner on the Export dialog.",
      },
      "importExport.dialog.advancedFormatsAriaLabel": {
        description: "Accessible name for the Advanced section's export-format radio group.",
      },
      "importExport.dialog.plainTextDumpDetail": {
        description:
          "Extended description of the plain-text-dump export format in the Advanced section. {whatThisLoses} is a bold-styled lead-in phrase, rendered by RichMessage.",
        placeholders: { whatThisLoses: "Bold-styled phrase reading 'What this loses:'." },
      },
      "importExport.dialog.prefixWithRef": {
        description:
          "Label for the 'include canonical ref' checkbox under the plain-text-dump option. {example} is a monospaced example reference, rendered by RichMessage.",
        placeholders: { example: "Monospaced example canonical reference ('GEN 1:1') — not translated." },
      },
      "importExport.dialog.lossyVerseCount": {
        description: "Detail line shown after a USFM export when some verses could not round-trip losslessly.",
        placeholders: { count: "Number of affected verses." },
      },
      "importExport.dialog.fidelityWarningsHeader": {
        description: "Heading of the inline-style fidelity report shown after a successful export.",
        placeholders: { count: "Number of segments that lost inline formatting." },
      },
      "importExport.dialog.andMore": {
        description: "Truncation notice at the end of the fidelity-warnings list.",
        placeholders: { count: "Number of additional warnings not shown." },
      },
      "importExport.status.downloadingCount": {
        description: "Busy-status message while downloading a project-scope USFM zip, file by file.",
        placeholders: { done: "Number of files downloaded so far.", total: "Total number of files to download." },
      },
      "importExport.status.exportedFilesCount": {
        description: "Success-status message after a project-scope USFM export, or a single-file-scope USFM export whose count is 1.",
        placeholders: { count: "Number of files exported." },
      },
      "importExport.status.skippedOlderImports": {
        description: "Second half of the USFM project-export success message, appended after exportedFilesCount when some files were skipped.",
        placeholders: { count: "Number of files skipped because they predate round-trip export support." },
      },
      "importExport.status.exportedFile": {
        description: "Success-status message after a single-file USFM export.",
        placeholders: { fileName: "Name of the exported file — not translated." },
      },
      "importExport.status.downloadedNoTranslations": {
        description: "Success-status message after a DOCX/PPTX round-trip export that had no translations to inject.",
        placeholders: { fileName: "Name of the downloaded file — not translated." },
      },
      "importExport.status.downloadedParagraphsTranslated": {
        description: "Success-status message after a DOCX/PPTX/IDML round-trip export that injected at least one translated paragraph.",
        placeholders: { fileName: "Name of the downloaded file — not translated.", count: "Number of paragraphs translated." },
      },
      "importExport.status.downloadedIdmlUnchanged": {
        description: "Success-status message after an IDML export with no translations — the original bytes were returned unchanged.",
        placeholders: { fileName: "Name of the downloaded file — not translated." },
      },
      "importExport.status.decodingPercent": {
        description:
          "Progress line in the toast that runs while the per-character audio " +
          "export decodes an episode's recordings. Shown instead of the counted " +
          "form once the run is long enough to be worth a percentage; the dash " +
          "separates the activity from the number.",
        placeholders: {
          pct: "Whole-number percentage of recordings decoded so far, 0-100.",
        },
      },
      "importExport.status.decodingCount": {
        description: "Busy-status message while decoding audio clips for the audio-by-character export.",
        placeholders: { done: "Number of clips decoded so far.", total: "Total number of clips to decode." },
      },
      "importExport.status.exportedAudioByCharacterWithSkipped": {
        description: "Success-status message after an audio-by-character export where some clips were skipped (missing audio).",
        placeholders: { count: "Number of clips skipped." },
      },
      "importExport.status.couldNotLoadProject": {
        description: "Error-status message when loading all project files for a project-scope export fails.",
        placeholders: { message: "Raw underlying error message." },
      },
      "importExport.status.reinjectedTranslations": {
        description: "First half of the SDBH XML export success message, naming how many translations and senses were reinjected.",
        placeholders: {
          translations: "Number of translated cells reinjected, already locale-formatted.",
          senses: "Number of lexicon senses touched, already locale-formatted.",
        },
      },
      "importExport.status.glossWarnings": {
        description: "Optional second half of the SDBH XML export success message, appended after reinjectedTranslations when gloss warnings occurred.",
        placeholders: { count: "Number of gloss warnings." },
      },
      "importExport.status.downloadedMetadataCsvRows": {
        description: "Success-status message after a project-scope metadata-CSV export.",
        placeholders: { fileName: "Name of the downloaded file — not translated.", count: "Number of data rows in the CSV." },
      },
      "importExport.status.buildingZip": {
        description: "Busy-status message while building a project-scope export zip.",
        placeholders: { count: "Number of files being zipped." },
      },
      "importExport.status.downloadedFilesCount": {
        description: "Success-status message after a project-scope client-side (non-USFM) export.",
        placeholders: { count: "Number of files exported." },
      },
      "importExport.status.downloadedFile": {
        description: "Success-status message after a single-file client-side export (txt/md/tsv/csv/xlf/tmx/vtt/srt/plain-text-dump/metadata-csv).",
        placeholders: { fileName: "Name of the downloaded file — not translated." },
      },
      "importExport.errors.originalMissing": {
        description:
          "Toast when Download original fails because the stored blob pointer exists but the bytes are gone from storage. Tells the user to re-import.",
      },
      "importExport.errors.ebibleEmptyCorpus": {
        description: "Thrown when a chosen eBible translation's corpus file downloads but contains no text (often copyright-restricted).",
        placeholders: { title: "Title of the eBible translation the user chose — not translated." },
      },
      "importExport.errors.noImportableContent": {
        description: "Thrown when a parsed file produced zero usable content for its detected format.",
        placeholders: { fileName: "Name of the file — not translated.", fileType: "Detected format name (e.g. 'usfm') — not translated." },
      },
      "importExport.errors.sandboxFallbackFailed": {
        description:
          "Thrown when both the primary parse attempt and the AI-assisted sandbox fallback fail. {primary} and {fallback} are raw upstream error messages, interpolated as data, not translated.",
        placeholders: { primary: "Raw message from the primary parse failure.", fallback: "Raw message from the sandbox fallback failure." },
      },
      "importExport.errors.importCouldNotPublish": {
        description: "Thrown when every file in a batch failed to publish; {reason} is the first failure's raw reason, interpolated as data.",
        placeholders: { reason: "Raw failure reason for the first file — not translated." },
      },
      "importExport.errors.emptyFile": {
        description: "Thrown when a selected file has zero bytes.",
        placeholders: { fileName: "Name of the empty file — not translated." },
      },
      "importExport.errors.unsupportedFileTypeSignIn": {
        description: "Thrown when a file's format can't be detected and the user isn't signed in for AI-assisted detection.",
        placeholders: { fileName: "Name of the file — not translated." },
      },
      "importExport.errors.obsDownloadIncomplete": {
        description: "Thrown when some Open Bible Stories files failed to download. {files} is a raw '<name> (<status>)' data list, interpolated as-is.",
        placeholders: { files: "Comma-separated list of failed filenames with their HTTP status — not translated." },
      },
      "importExport.errors.helloaoNoVerses": {
        description: "Thrown when a helloao.org translation downloads but the selected books produced no verses.",
        placeholders: { title: "Title of the translation the user chose — not translated." },
      },
      "importExport.errors.tnNoValidRowsWithSkipped": {
        description: "Thrown when a Translation Notes TSV parsed to zero valid rows, and some rows were skipped for a known reason (missing reference).",
        placeholders: { count: "Number of rows skipped for missing a canonical reference." },
      },
      "importExport.errors.biblicaNoStudyNotes": {
        description: "Thrown when a Biblica IDML package parses successfully but contains no study-note paragraphs.",
        placeholders: { fileName: "Name of the file — not translated." },
      },
      "importExport.errors.invalidIdmlPackage": {
        description: "Thrown when an uploaded file claiming to be IDML doesn't have a ZIP header.",
        placeholders: { fileName: "Name of the file — not translated." },
      },
      "importExport.errors.mediaFileTooLarge": {
        description: "Thrown when an audio/video file exceeds the media import size ceiling.",
        placeholders: { fileName: "Name of the file — not translated." },
      },
      "importExport.errors.couldNotDecodeAudio": {
        description: "Thrown when the browser's Web Audio API fails to decode an uploaded audio/video file.",
        placeholders: { fileName: "Name of the file — not translated." },
      },
      "importExport.errors.sourceUploadTooLarge": {
        description: "Thrown when a source artifact upload exceeds the server-side size ceiling.",
        placeholders: { maxSize: "The size limit, already formatted (e.g. '95.0 MB') — not translated." },
      },
      "importExport.errors.oversizedCells": {
        description:
          "Thrown before any upload when one or more parsed cells exceed the server's " +
          "per-cell text ceiling, so the user learns which sections are too big instead " +
          "of waiting out a full upload that ends in a raw HTTP 413. The closing " +
          "sentence is the remedy: break the oversized section up in the original " +
          "document and re-import.",
        placeholders: {
          count: "Number of oversized cells found.",
          fileName: "Name of the file being imported — not translated.",
          maxSize: "The per-cell limit, already formatted (e.g. '256 KB') — not translated.",
          cells:
            "Pre-joined list of the offending cells, each already rendered by " +
            "oversizedCellSource / oversizedCellTarget — not translated.",
        },
      },
      "importExport.errors.oversizedCellSource": {
        description:
          "One entry in the oversized-cell list, for a cell whose SOURCE text is too " +
          "big. Reads as a label followed by which side is at fault and how large it " +
          "is; a fragment inside a sentence, so it takes no closing full stop.",
        placeholders: {
          label: "Canonical Scripture reference, or '#12' for the cell's position — not translated.",
          size: "The cell's size, already formatted (e.g. '412 KB') — not translated.",
        },
      },
      "importExport.errors.oversizedCellTarget": {
        description:
          "One entry in the oversized-cell list, for a cell whose pre-filled TRANSLATION " +
          "is too big (paired imports carry both sides). Same shape as the source " +
          "variant; a fragment inside a sentence, so it takes no closing full stop.",
        placeholders: {
          label: "Canonical Scripture reference, or '#12' for the cell's position — not translated.",
          size: "The cell's size, already formatted (e.g. '412 KB') — not translated.",
        },
      },
      "importExport.errors.oversizedCellsMore": {
        description:
          "Final entry in the oversized-cell list when more cells are oversized than the " +
          "message names individually. A fragment appended after the listed ones, so it " +
          "takes no closing full stop.",
        placeholders: { count: "How many oversized cells are not listed individually." },
      },
      "importExport.errors.sourceUploadNetworkFailed": {
        description:
          "Thrown when the source-upload PUT fails at the network level (offline, DNS, etc.), before any HTTP response. {detail} is the raw underlying error, interpolated as data.",
        placeholders: { detail: "Raw network-error message — not translated." },
      },
      "importExport.errors.artifactBindingNetworkFailed": {
        description:
          "Thrown when binding an already-uploaded artifact to another file fails at the network level. {detail} is the raw underlying error, interpolated as data.",
        placeholders: { detail: "Raw network-error message — not translated." },
      },
      "importExport.manifestWarnings.duplicateCanonicalRef": {
        description:
          "Per-unit manifest-normalization warning when the same canonical Scripture " +
          "reference (e.g. 'GEN 1:1') is assigned to more than one imported unit — not " +
          "yet surfaced by any panel, see the section note above `keys.importExport." +
          "manifestWarnings.emptySource`.",
        placeholders: { ref: "The duplicated canonical reference (e.g. 'GEN 1:1') — not translated." },
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
      "importExport.googleDrive.willImportCount": {
        description: "Heading above the accepted-files list on the Google Drive picker's pre-import summary screen.",
        placeholders: { count: "Number of files that will be imported." },
      },
      "importExport.googleDrive.skippedCount": {
        description:
          "Heading above the skipped-files list on the Google Drive picker's pre-import summary screen, shown only when at least one item was skipped.",
        placeholders: { count: "Number of files that were skipped." },
      },
      "importExport.googleDrive.importButton": {
        description: "Primary button on the Google Drive picker's pre-import summary screen that starts the download.",
        placeholders: { count: "Number of files that will be downloaded and imported." },
      },
      "importExport.googleDrive.downloadingProgress": {
        description: "Progress line shown while files picked from Google Drive are being downloaded into the browser.",
        placeholders: {
          done: "Number of files downloaded so far.",
          total: "Total number of files being downloaded.",
        },
      },
      "importExport.dcs.anyOwner": {
        description:
          "Option in the publisher picker for the Door43 catalog, and the picker's " +
          "own placeholder text, meaning the search should not be narrowed to one " +
          "publishing organisation. Sits in a list beside individual organisation " +
          "names.",
      },
      "importExport.dcs.anySubject": {
        description:
          "Option in the resource-category picker for the Door43 catalog, and the " +
          "picker's own placeholder text, meaning the search should not be narrowed " +
          "to one category. Sits in a list beside individual category names.",
      },
      "importExport.dcs.applyResyncCheckbox": {
        description:
          "Label of the tick box the reader must select before the re-sync " +
          "confirmation dialog will let them proceed. Written in the first person " +
          "as an acknowledgement the reader makes about the consequence.",
      },
      "importExport.dcs.applyResyncConfirmLabel": {
        description:
          "Confirming button in the footer of the re-sync confirmation dialog, " +
          "sitting beside the cancel button. Imperative verb phrase with no " +
          "ellipsis, because pressing it performs the action immediately.",
      },
      "importExport.dcs.applyResyncConfirmRemovals": {
        description:
          "Second sentence of the confirmation dialog's body text, warning that the " +
          "re-sync would take lines away and that translated work hanging off them " +
          "disappears from view. A complete sentence in the future tense, following " +
          "the sentence about repairs in the same paragraph.",
        placeholders: {
          count: "Number of source lines that would be taken away.",
        },
      },
      "importExport.dcs.applyResyncConfirmRepairs": {
        description:
          "First sentence of the confirmation dialog's body text, stating how many " +
          "source lines the re-sync would correct and how many it would add. A " +
          "complete sentence in the future tense; a second sentence about removals " +
          "follows it in the same paragraph.",
        placeholders: {
          count: "Number of existing source lines whose text would be corrected.",
          created: "Number of source lines that would be added.",
        },
      },
      "importExport.dcs.applyResyncConfirmTitle": {
        description:
          "Heading of the confirmation dialog that opens before a re-sync is " +
          "carried out. A short question asking the reader to confirm the action " +
          "named on the button they just pressed.",
      },
      "importExport.dcs.applyResyncEllipsis": {
        description:
          "Red button inside the re-sync scan notice that opens the confirmation " +
          "dialog. Imperative verb phrase; the trailing ellipsis is the convention " +
          "meaning a dialog will open rather than the action running immediately.",
      },
      "importExport.dcs.badgeAriaLabel": {
        description:
          "Accessible name, read aloud by screen readers, for the header badge that " +
          "can be clicked to jump to the settings page where the upstream link is " +
          "managed. Names the thing first and then the action the click performs.",
      },
      "importExport.dcs.catalogIntro": {
        description:
          "Introductory paragraph above the list of resources published on the " +
          "Door43 sharing service, shown while the reader is choosing something to " +
          "import. Three short statements of explanatory prose: what the list is, " +
          "what importing commits them to, and which kinds of material can be " +
          "imported so far.",
        placeholders: {
          link: "A hyperlink to the Door43 service whose visible text is the service's " +
            "own name. Do not translate the substituted value.",
        },
      },
      "importExport.dcs.catalogSearchFailed": {
        description:
          "Short error line shown in place of results when the request to the " +
          "Door43 catalog could not be completed and the service gave no reason of " +
          "its own. A statement of fact, not an instruction, and not a full " +
          "sentence.",
      },
      "importExport.dcs.checkFailed": {
        description:
          "Red error line shown when the request asking whether a newer release " +
          "exists did not complete. A complete sentence followed by a colon and the " +
          "underlying reason.",
        placeholders: {
          message: "The underlying failure reason as reported by the service or the network. " +
            "Do not translate the substituted value.",
        },
      },
      "importExport.dcs.checkForUpdates": {
        description:
          "Button in the upstream card that asks the Door43 service whether a newer " +
          "release of the linked resource exists. Imperative verb phrase; it only " +
          "looks, it does not change anything.",
      },
      "importExport.dcs.customOwnerAriaLabel": {
        description:
          "Accessible name, read aloud by screen readers, for the free-text box " +
          "where a publishing organisation can be typed instead of chosen from the " +
          "picker. A short noun phrase; the box has no visible label of its own.",
      },
      "importExport.dcs.customOwnerPlaceholder": {
        description:
          "Grey hint text inside an empty text box, below the Door43 catalog " +
          "filters, where the reader can type a publishing organisation that the " +
          "picker above does not list. The leading ellipsis continues from that " +
          "picker; the parenthesis warns that typing here wins.",
      },
      "importExport.dcs.detachButton": {
        description:
          "Destructive button at the bottom of the upstream card that permanently " +
          "breaks this project's link to the published resource. Imperative verb " +
          "phrase; it opens a confirmation dialog rather than acting at once.",
      },
      "importExport.dcs.detachConfirmCheckbox": {
        description:
          "Label of the tick box the reader must select before the detach " +
          "confirmation dialog will let them proceed. Written in the first person " +
          "as an acknowledgement the reader makes about the consequence.",
      },
      "importExport.dcs.detachConfirmDescription": {
        description:
          "Body text of the confirmation dialog for breaking the upstream link. " +
          "Three short sentences: what is lost, what is gained, and that the step " +
          "cannot be reversed from this screen.",
        placeholders: {
          repo: "Owner and repository name of the upstream resource, joined by a slash. " +
            "Do not translate the substituted value.",
        },
      },
      "importExport.dcs.detachConfirmTitle": {
        description:
          "Heading of the confirmation dialog that opens before the upstream link " +
          "is broken. A short question echoing the button the reader just pressed.",
      },
      "importExport.dcs.detachFailed": {
        description:
          "Small red line shown when breaking the upstream link did not complete " +
          "and the project is still linked. A short statement followed by a colon " +
          "and the underlying reason.",
        placeholders: {
          message: "The underlying failure reason as reported by the service or the network. " +
            "Do not translate the substituted value.",
        },
      },
      "importExport.dcs.detachHint": {
        description:
          "Small explanatory line directly beneath the detach button, describing " +
          "both consequences of pressing it. One sentence joining the loss of the " +
          "link to the gain of being able to edit the source lines by hand.",
        placeholders: {
          repo: "Owner and repository name of the upstream resource, joined by a slash. " +
            "Do not translate the substituted value.",
        },
      },
      "importExport.dcs.importAdvancesNote": {
        description:
          "Explanatory paragraph under the headline of the amber update notice, " +
          "warning what importing will do before the reader presses the button. Two " +
          "sentences: the first states the direct effect on this project, the " +
          "second the knock-on effect on projects that translate from it.",
        placeholders: {
          ref: "The newer release tag the source lines would be moved to. Do not " +
            "translate the substituted value.",
        },
      },
      "importExport.dcs.importChanges": {
        description:
          "Primary button inside the amber update notice that pulls the newer " +
          "upstream release into this project's source lines. Imperative verb " +
          "phrase; this is the action that actually writes.",
      },
      "importExport.dcs.importFailed": {
        description:
          "Red error line shown when pulling the newer upstream release did not " +
          "complete. A short statement followed by a colon and the underlying " +
          "reason.",
        placeholders: {
          message: "The underlying failure reason as reported by the service or the network. " +
            "Do not translate the substituted value.",
        },
      },
      "importExport.dcs.importRoleRequired": {
        description:
          "Line shown in place of the import button when the reader's permission " +
          "level on this project is too low to run the import. A complete sentence " +
          "naming the minimum permission level, which is a rung on this product's " +
          "permission ladder.",
      },
      "importExport.dcs.importSummary": {
        description:
          "Green confirmation shown after an upstream import finishes: a tally of " +
          "how the source lines changed, then a reminder of the effect on projects " +
          "that translate from this one. The tally is a label, a colon, and three " +
          "counted items; a full sentence follows.",
        placeholders: {
          created: "Number of source lines newly added by the import.",
          updated: "Number of existing source lines whose text changed.",
          removed: "Number of source lines that no longer exist upstream.",
        },
      },
      "importExport.dcs.languageCodeAriaLabel": {
        description:
          "Accessible name, read aloud by screen readers, for the same box the " +
          "visible Language label sits above. It is more specific than the visible " +
          "label because the box takes a short standard language code rather than a " +
          "language name.",
      },
      "importExport.dcs.languageFilterLabel": {
        description:
          "Visible field label above the box where the reader types the language of " +
          "the resources they want to find in the Door43 catalog. A noun naming " +
          "what the box filters on, not an instruction and not the language of the " +
          "interface.",
      },
      "importExport.dcs.loadingCatalog": {
        description:
          "Status line beside a spinner filling the results area while the first " +
          "list of Door43 resources is being fetched. Present-tense progress " +
          "wording, shown only before any result has ever arrived.",
      },
      "importExport.dcs.noResults": {
        description:
          "First line of the empty state filling the results area when the Door43 " +
          "catalog returned nothing for the chosen filters. A complete sentence " +
          "stating the outcome; a shorter hint line follows beneath it.",
      },
      "importExport.dcs.noResultsHint": {
        description:
          "Second, smaller line of the empty state in the Door43 catalog results " +
          "area, suggesting how to get results. An imperative sentence naming the " +
          "three filters above the list.",
      },
      "importExport.dcs.notYetSupportedBadge": {
        description:
          "Small badge on a greyed-out row in the Door43 catalog listing, marking a " +
          "resource this product cannot import yet. A very short adjectival phrase " +
          "that must fit inside a chip beside the resource's name.",
      },
      "importExport.dcs.ownerFilterLabel": {
        description:
          "Visible field label above the picker that narrows the Door43 catalog to " +
          "resources published by one organisation, and reused as that picker's " +
          "accessible name. A noun meaning the publishing account a resource " +
          "belongs to.",
      },
      "importExport.dcs.panelDescription": {
        description:
          "Explanatory paragraph at the top of the settings card for a project " +
          "whose source text comes from the Door43 sharing service. Two sentences: " +
          "the first states the situation, the second says what the buttons below " +
          "the paragraph let the reader do.",
      },
      "importExport.dcs.pinnedRefBadge": {
        description:
          "Small badge in a row of badges summarising the upstream link, stating " +
          "which published version the project is currently fixed to. Lower-case " +
          "and telegraphic by design; it sits beside a badge holding the repository " +
          "name.",
        placeholders: {
          ref: "The release tag or branch the project is fixed to. Do not translate the " +
            "substituted value.",
        },
      },
      "importExport.dcs.pinTooltip": {
        description:
          "Tooltip on the small badge in the workspace header that tells the reader " +
          "this project's source text is kept in step with a published resource on " +
          "the Door43 sharing service. Two sentences of explanatory prose: the " +
          "first states what is synced and from where, the second says the source " +
          "lines are owned by that link and points to where the link is managed.",
        placeholders: {
          repo: "Owner and repository name of the upstream resource, joined by a slash. " +
            "Do not translate the substituted value.",
          subject: "The upstream resource's category as published by the service, for " +
            "example an aligned Bible or a set of translation notes. Do not translate " +
            "the substituted value.",
          ref: "The release tag or branch the project is pinned to. Do not translate the " +
            "substituted value.",
          imported: "The date the resource was imported, already formatted for the reader's " +
            "language.",
        },
      },
      "importExport.dcs.repairStaleCursorError": {
        description:
          "Reason text appended after 'Re-sync failed:' when the upstream link was " +
          "altered somewhere else between the scan and the confirmation, so the " +
          "planned work was abandoned. Begins lower-case because it continues that " +
          "line; reassures the reader nothing was written and tells them what to do " +
          "next.",
      },
      "importExport.dcs.resyncButton": {
        description:
          "Secondary button in the upstream card that re-reads the already-pinned " +
          "upstream version to find source lines that were brought in incorrectly. " +
          "Imperative verb phrase; pressing it only scans, it does not change " +
          "anything yet.",
      },
      "importExport.dcs.resyncFailed": {
        description:
          "Small red line shown when a re-sync scan or its application did not " +
          "complete. A short statement followed by a colon and the underlying " +
          "reason.",
        placeholders: {
          message: "The underlying failure reason as reported by the service or the network. " +
            "Do not translate the substituted value.",
        },
      },
      "importExport.dcs.resyncHint": {
        description:
          "Small explanatory paragraph directly beneath the re-sync button. Two " +
          "sentences describing what the button does and reassuring the reader that " +
          "a confirmation step comes first.",
      },
      "importExport.dcs.resyncNoChanges": {
        description:
          "Small green line shown after a re-sync scan that found nothing to fix. A " +
          "complete sentence reporting that this project's source lines already " +
          "agree with the upstream version it is fixed to.",
      },
      "importExport.dcs.resyncRemovalWarning": {
        description:
          "Warning under the re-sync scan headline, shown only when the scan would " +
          "take lines away, telling the reader that translated work hanging off " +
          "those lines disappears from view. A complete sentence in the future " +
          "tense.",
        placeholders: {
          count: "Number of source lines that would be taken away.",
        },
      },
      "importExport.dcs.resyncRepaired": {
        description:
          "Small green line shown after a re-sync has been carried out, reporting " +
          "how many source lines were corrected. A complete sentence in the past " +
          "tense.",
        placeholders: {
          count: "Number of source lines that were corrected.",
        },
      },
      "importExport.dcs.resyncScanSummary": {
        description:
          "Bold headline of the amber notice reporting what a re-sync scan found, " +
          "before anything is applied. A label, a colon, and three counted items " +
          "describing the work that would be done.",
        placeholders: {
          repair: "Number of existing source lines whose text would be corrected.",
          created: "Number of source lines that would be added.",
          removed: "Number of source lines that would be taken away.",
        },
      },
      "importExport.dcs.settingsBlocked": {
        description:
          "Reason text appended after 'Detach failed:' when the server refused the " +
          "change outright. Begins lower-case because it continues that line; a " +
          "single word with the server's own explanation in parentheses.",
        placeholders: {
          reason: "The server's short machine-readable explanation for refusing. Do not " +
            "translate the substituted value.",
        },
      },
      "importExport.dcs.settingsConflict": {
        description:
          "Reason text appended after 'Detach failed:' when someone else changed " +
          "this project's settings at the same time, so the change was not saved. " +
          "Begins lower-case because it continues that line, and ends with an " +
          "instruction to retry.",
      },
      "importExport.dcs.stageFilterLabel": {
        description:
          "Visible field label above the picker that chooses how finished the " +
          "resources in the Door43 catalog listing must be, and reused as that " +
          "picker's accessible name. A noun meaning the point a resource has " +
          "reached in its publishing cycle.",
      },
      "importExport.dcs.stageLatest": {
        description:
          "Option in the publishing-stage picker for the Door43 catalog: show the " +
          "newest state of each resource, including work not yet released. The " +
          "parenthesised word is the standard version-control term for the newest " +
          "state and is not translated.",
      },
      "importExport.dcs.stagePreprod": {
        description:
          "Option in the publishing-stage picker for the Door43 catalog: show " +
          "resources their publisher has prepared but not yet formally released. " +
          "Sits between the released and the unreviewed-latest options in the same " +
          "list.",
      },
      "importExport.dcs.stageProd": {
        description:
          "Option in the publishing-stage picker for the Door43 catalog: show only " +
          "resources their publisher has formally released for use. The default " +
          "choice. The parenthesised word is the short technical name the service " +
          "itself uses for this stage.",
      },
      "importExport.dcs.subjectFilterLabel": {
        description:
          "Visible field label above the picker that narrows the Door43 catalog to " +
          "one kind of resource, and reused as that picker's accessible name. A " +
          "noun meaning the category of material, such as a Bible or a set of " +
          "translation notes.",
      },
      "importExport.dcs.syncTokenError": {
        description:
          "Reason text appended after 'Import failed:' or 'Re-sync failed:' when " +
          "the permission needed to read this project's lines could not be " +
          "obtained. A complete sentence; 'token' here is the short-lived " +
          "credential the app requests before reading.",
      },
      "importExport.dcs.trackingHead": {
        description:
          "Small badge in the row summarising the upstream link, stating that the " +
          "project follows the newest state of the upstream resource rather than a " +
          "formal release. Lower-case and telegraphic; the capitalised word is the " +
          "standard version-control term for that newest state and is not " +
          "translated.",
      },
      "importExport.dcs.trackingRelease": {
        description:
          "Small badge in the row summarising the upstream link, stating that the " +
          "project follows formal published releases rather than day-to-day " +
          "upstream work. Lower-case and telegraphic; the alternative badge in the " +
          "same position says the project follows the newest state instead.",
      },
      "importExport.dcs.unsupportedResourceTooltip": {
        description:
          "Tooltip on a greyed-out row in the Door43 catalog listing, explaining " +
          "why that resource cannot be chosen. A statement of a current product " +
          "limitation; the parenthesis cites the internal work item and its code is " +
          "not translated.",
      },
      "importExport.dcs.updateAvailable": {
        description:
          "Bold headline of the amber notice shown after the check finds a newer " +
          "release: which version the project is on, which one is available, and " +
          "how many files differ between them. A telegraphic summary line, not a " +
          "sentence; the arrow shows the move from the old version to the new one.",
        placeholders: {
          oldRef: "The release tag the project is currently fixed to. Do not translate the " +
            "substituted value.",
          newRef: "The newer release tag available upstream. Do not translate the " +
            "substituted value.",
          count: "Number of files that differ between the two releases.",
        },
      },
      "importExport.dcs.upToDateWith": {
        description:
          "Green confirmation line shown after the check finds no newer release. A " +
          "complete sentence reporting that the project already holds the newest " +
          "published version.",
        placeholders: {
          ref: "The newest published release tag, which the project already matches. Do " +
            "not translate the substituted value.",
        },
      },
      "importExport.linked.acceptAllButton": {
        description:
          "Button in the bar that appears once rows are ticked, confirming every " +
          "ticked translation should stand unchanged against the new source text. " +
          "Imperative verb phrase with the number of ticked rows in parentheses.",
        placeholders: {
          count: "Number of rows currently ticked.",
        },
      },
      "importExport.linked.acceptButton": {
        description:
          "Button on one row of the upstream-changes list, confirming that the " +
          "existing translation should stand unchanged against the new source text. " +
          "Imperative verb phrase; it clears the row without opening the editor.",
      },
      "importExport.linked.awaitingTranslationBadge": {
        description:
          "Badge on a row of the upstream-changes list, marking a line that has " +
          "changed but has no translation here yet, so there is nothing to accept. " +
          "Lower-case and telegraphic; it must fit inside a chip beside the line's " +
          "identifier.",
      },
      "importExport.linked.checking": {
        description:
          "Status line beside a spinner filling the upstream-changes card while the " +
          "app works out which lines need review. Present-tense progress wording, " +
          "shown only before any result has arrived.",
      },
      "importExport.linked.flaggedCount": {
        description:
          "Small badge beside the upstream-changes heading, counting how many lines " +
          "are waiting to be reviewed. Telegraphic label, not a sentence, and it " +
          "must stay short enough to fit in a chip.",
        placeholders: {
          count: "Number of lines waiting to be reviewed.",
        },
      },
      "importExport.linked.loadError": {
        description:
          "Message filling the upstream-changes card when the list of lines needing " +
          "review could not be fetched. A complete sentence implying the problem " +
          "may be temporary; a retry link follows it on the same line.",
      },
      "importExport.linked.nothingFlagged": {
        description:
          "Message filling the upstream-changes card when no line needs review. A " +
          "reassuring complete sentence: the short verdict, then the reason for it.",
      },
      "importExport.linked.removedUpstreamBadge": {
        description:
          "Red badge on a row of the upstream-changes list, marking a line that no " +
          "longer exists in the source this project follows. Lower-case and " +
          "telegraphic; it must fit inside a chip beside the line's identifier.",
      },
      "importExport.linked.repinRoleRequired": {
        description:
          "Small line at the top of the upstream-changes card, shown when the " +
          "reader's permission level is too low to act on the listed lines. One " +
          "sentence naming two different minimum permission levels, which are rungs " +
          "on this product's permission ladder, for the single and the many-at-once " +
          "actions.",
      },
      "importExport.linked.selectForBulkAriaLabel": {
        description:
          "Accessible name, read aloud by screen readers, for the tick box on one " +
          "row of the upstream-changes list. Imperative phrase naming which line " +
          "the tick box belongs to and what ticking it prepares: accepting several " +
          "translations unchanged in one go.",
        placeholders: {
          cell: "The identifier of the line the tick box belongs to, such as a scripture " +
            "reference. Do not translate the substituted value.",
        },
      },
      "importExport.linked.skippedRetranslatedBadge": {
        description:
          "Badge that appears on a row after an accept attempt was deliberately not " +
          "carried out, because someone had already retranslated that line in the " +
          "meantime. Lower-case and telegraphic: the outcome, then the reason.",
      },
      "importExport.linked.syncBatchHeading": {
        description:
          "Heading of a collapsible group in the upstream-changes list. Lines are " +
          "grouped by the moment their upstream update arrived, so this names the " +
          "group by that moment. A short label, not a sentence.",
        placeholders: {
          date: "The date and time the group of upstream updates arrived, already " +
            "formatted for the reader's language.",
        },
      },
      "importExport.linked.syncTokenError": {
        description:
          "Reason shown in the red error line at the top of the upstream-changes " +
          "card when the permission needed to read this project's lines was not " +
          "granted, so an accept could not be carried out. A lower-case fragment, " +
          "not a sentence; 'token' here is the short-lived credential the app " +
          "requests before reading.",
      },
      "importExport.linked.tombstonedLine": {
        description:
          "Body text of a row in the upstream-changes list, shown in place of a " +
          "before-and-after comparison when the source line no longer exists. A " +
          "complete sentence; a second sentence about the kept translation may " +
          "follow it.",
      },
      "importExport.linked.tombstonedTranslationKept": {
        description:
          "Sentence following the notice that a line was removed from the source, " +
          "reassuring the reader that the work done here has not been thrown away. " +
          "Ends with a colon introducing the quoted text.",
        placeholders: {
          translation: "The existing translation of the removed line, shown in italics between " +
            "quotation marks. Do not translate the substituted value.",
        },
      },
      "importExport.columnMapping.castColumnLabel": {
        description:
          "Label of the dropdown on the column-mapping screen where the user says " +
          "which column names the person or character speaking each row. Field " +
          "label for a control; the slash offers two words for the same thing, so " +
          "keep both senses.",
      },
      "importExport.columnMapping.columnFallbackName": {
        description:
          "Stand-in name for a spreadsheet column that has no heading of its own, " +
          "used both in the column dropdowns and above the sample data table on the " +
          "column-mapping screen. The noun for a spreadsheet column plus its " +
          "position, counting from one.",
        placeholders: {
          index: "Position of the column in the sheet, counting from one.",
        },
      },
      "importExport.columnMapping.createModeHint": {
        description:
          "Instruction under the column-mapping heading when a spreadsheet is being " +
          "imported as a new file. Asks the user to say what each column holds, " +
          "then reassures them that only one choice is compulsory. The quoted " +
          "phrase must match the translation of the 'Source text' field label on " +
          "the same screen, since it names that field.",
      },
      "importExport.columnMapping.endColumnLabel": {
        description:
          "Label of the dropdown on the column-mapping screen where the user says " +
          "which column holds the time at which each row finishes in the " +
          "accompanying recording. Field label for a control, paired with the " +
          "start-time label above it.",
      },
      "importExport.columnMapping.firstRowIsHeader": {
        description:
          "Label of the tick box on the column-mapping screen that says the " +
          "spreadsheet's first row holds column names rather than real data, so it " +
          "should be used to name the columns instead of being imported. Statement " +
          "in the third person, not an instruction.",
      },
      "importExport.columnMapping.ignoreOption": {
        description:
          "First entry in every column dropdown on the column-mapping screen, " +
          "meaning that no column is assigned to this kind of data and nothing will " +
          "be read for it. A single verb framed by dashes to mark it as a special " +
          "choice rather than a column name; keep the dashes.",
      },
      "importExport.columnMapping.labelColumnLabel": {
        description:
          "Label of the dropdown on the column-mapping screen where the user says " +
          "which column identifies each line, either as a free label or as a formal " +
          "reference such as a book, chapter and verse. Field label for a control; " +
          "the slash offers two words for the same thing, so keep both senses.",
      },
      "importExport.columnMapping.mapColumns": {
        description:
          "Serves two places on the same screen with identical text: the heading of " +
          "the step where the user says what each spreadsheet column contains, and " +
          "the primary button in that step's footer which accepts those choices and " +
          "moves on. Imperative verb plus noun, and it must work as both a step " +
          "title and a button.",
      },
      "importExport.columnMapping.previewRowsHeading": {
        description:
          "Small heading above the sample table on the column-mapping screen, which " +
          "shows a handful of real rows so the user can check their choices against " +
          "actual content. A noun naming the sample, then a parenthesis saying how " +
          "many rows are shown and that the heading row is not among them.",
        placeholders: {
          count: "Number of sample rows shown, excluding any heading row.",
        },
      },
      "importExport.columnMapping.sourceColumnLabel": {
        description:
          "Label of the required dropdown on the column-mapping screen where the " +
          "user says which column holds the text to be translated. Field label for " +
          "a control, marked with an asterisk as compulsory. 'Source' here means " +
          "the original wording the translation is made from.",
      },
      "importExport.columnMapping.startColumnLabel": {
        description:
          "Label of the dropdown on the column-mapping screen where the user says " +
          "which column holds the time at which each row begins in the accompanying " +
          "recording. Field label for a control.",
      },
      "importExport.columnMapping.targetColumnLabel": {
        description:
          "Label of the dropdown on the column-mapping screen where the user says " +
          "which column holds the translated text. Field label for a control; " +
          "compulsory when the spreadsheet is filling in translations for existing " +
          "lines, optional otherwise. 'Target' here means the language being " +
          "translated into.",
      },
      "importExport.columnMapping.targetModeHint": {
        description:
          "Instruction under the column-mapping heading when the spreadsheet is " +
          "being used to fill in translations for lines that already exist. First " +
          "sentence names the one required choice. The rest explains the " +
          "consequence of the optional reference column: name one and rows are " +
          "paired by that reference, leave it out and rows are paired top to bottom " +
          "by position.",
      },
      "importExport.columnMapping.typeColumnLabel": {
        description:
          "Label of the dropdown on the column-mapping screen where the user says " +
          "which column tells the importer what kind of unit each row is — a " +
          "heading, a verse, a spoken cue, and so on. Field label for a control.",
      },
      "importExport.errors.failedToParseFile": {
        description:
          "Last-resort error shown when reading a chosen file threw a failure that " +
          "carried no message of its own. Appears in red under the file picker on " +
          "several import panels. Short statement, no closing full stop, and it " +
          "must stay generic because it covers any unexpected reading failure.",
      },
      "importExport.fileTarget.acceptedFormats": {
        description:
          "Caption in small grey text under the drag-and-drop area of the panel " +
          "that fills in the open file's translations, listing the file kinds it " +
          "accepts. Only the conjunction joining the format names is " +
          "translated; the format names themselves stay as they are.",
      },
      "importExport.fileTarget.description": {
        description:
          "Three short reassuring sentences under the heading of the panel that " +
          "fills in the open file's translations. They state where the translations " +
          "come from, promise that the original text is left untouched, and promise " +
          "a review step before anything is written. 'Target column' is where " +
          "translations live beside the original text.",
      },
      "importExport.fileTarget.dropZoneHint": {
        description:
          "Invitation inside the dashed drag-and-drop area on the panel that fills " +
          "in the open file's translations. Deliberately unfinished: the sentence " +
          "continues into the 'Choose file' button rendered directly beneath it, so " +
          "keep the trailing 'or' (or its equivalent) leading into that button.",
      },
      "importExport.fileTarget.noCuesInSubtitle": {
        description:
          "Error shown in red under the drop area when a subtitle file was read " +
          "successfully but contained no timed caption blocks, so there is nothing " +
          "to fill in. Single short statement of fact. 'Cues' are the individual " +
          "timed caption blocks of a subtitle file.",
      },
      "importExport.fileTarget.noCuesInVtt": {
        description:
          "Error shown in red under the drop area when a WebVTT subtitle file was " +
          "read successfully but contained no cues, so there is nothing to fill in. " +
          "Single short statement of fact. 'VTT' is the file extension and stays " +
          "untranslated.",
      },
      "importExport.fileTarget.noVersesInUsfm": {
        description:
          "Error shown in red under the drop area when a scripture markup file was " +
          "read successfully but contained no verses, so there is nothing to fill " +
          "in. Single short statement of fact.",
      },
      "importExport.fileTarget.title": {
        description:
          "Heading of the panel that fills in the translations of the file the user " +
          "currently has open, from an uploaded file. Names the destination file in " +
          "quotation marks so the user cannot mistake which file will be changed. " +
          "Imperative phrase; keep the quotation marks around the file name.",
        placeholders: {
          fileName: "Display name of the file being filled in — do not translate the " +
            "substituted value.",
        },
      },
      "importExport.fileTarget.unsupportedFileType": {
        description:
          "Error shown in red under the drop area when the chosen file is of a kind " +
          "this panel cannot read. A short statement followed by an imperative " +
          "sentence naming the acceptable alternatives. The bracketed file " +
          "extensions are literal and stay untranslated.",
      },
      "importExport.paired.applyingTargets": {
        description:
          "Reassurance line under the 'Importing…' heading while paired rows are " +
          "being saved, naming what is happening: the translations from the upload " +
          "are being written onto the project's existing lines.",
      },
      "importExport.paired.description": {
        description:
          "Explanatory sentences under the paired-import heading. The first states " +
          "what the uploaded file must look like: every row holds the original text " +
          "and its translation. The second explains that rows are paired with the " +
          "project's existing lines using the standard reference that identifies a " +
          "passage, such as a book, chapter and verse.",
      },
      "importExport.paired.title": {
        description:
          "Heading of the import panel for a spreadsheet in which every row carries " +
          "both the original text and its translation. Short noun phrase naming " +
          "what is being imported; 'source' is the original text and 'target' is " +
          "the translation of it.",
      },
      "importExport.preview.aiAssistedStructure": {
        description:
          "Bold label at the top of a notice on the preview screen, shown when the " +
          "shape of an unrecognised file had to be worked out automatically rather " +
          "than read from a known format. Short noun phrase naming what the notice " +
          "is about.",
      },
      "importExport.preview.commitFailed": {
        description:
          "Red alert above the buttons on the preview screen when committing the " +
          "import failed. A short statement followed by the underlying technical " +
          "reason. Both buttons stay available so the user can try again or back " +
          "out.",
        placeholders: {
          error: "Raw underlying failure message, often English and technical — do not " +
            "translate the substituted value.",
        },
      },
      "importExport.preview.confidencePercent": {
        description:
          "Grey figure inside the automatic-structure notice on the preview screen, " +
          "saying how sure the automatic analysis is about the shape it proposed. A " +
          "whole-number percentage followed by the noun for certainty; no verb.",
        placeholders: {
          percent: "Whole number from 0 to 100 giving how certain the automatic analysis is.",
        },
      },
      "importExport.preview.confirmImport": {
        description:
          "Primary button in the footer of the preview screen that commits the " +
          "previewed lines into the project and starts the upload. Imperative verb " +
          "plus noun; it is the point of no return, so it should read as decisive.",
      },
      "importExport.preview.epubChaptersTitle": {
        description:
          "Heading above the selectable EPUB spine members in import preview. " +
          "The list can include chapters as well as navigation, cover, and notes pages.",
      },
      "importExport.preview.epubRoleChapter": {
        description: "Short EPUB spine-member classification for a normal book chapter.",
      },
      "importExport.preview.epubRoleNavigation": {
        description: "Short EPUB spine-member classification for the table of contents.",
      },
      "importExport.preview.epubRoleCover": {
        description: "Short EPUB spine-member classification for a cover page.",
      },
      "importExport.preview.epubRoleNotes": {
        description: "Short EPUB spine-member classification for notes or end matter.",
      },
      "importExport.preview.epubRoleEmpty": {
        description: "Short EPUB spine-member classification for a member with no importable text.",
      },
      "importExport.preview.includeEpubMember": {
        description:
          "Accessible label for the checkbox that includes one EPUB spine member in the import.",
        placeholders: {
          title: "Title of the EPUB spine member; preserve it verbatim.",
        },
      },
      "importExport.preview.headerSummary": {
        description:
          "Heading of the screen that shows what an import will produce, before the " +
          "user commits to it. Frames two already-counted phrases: how many " +
          "individual translatable lines were found, and how many files they came " +
          "from. The word before the dash is a noun naming the screen, and the word " +
          "between the two figures relates them, in the sense of 'spread over'.",
        placeholders: {
          cells: "Already-rendered phrase counting the translatable lines found, for " +
            "example '124 cells' — place it, do not re-count it.",
          files: "Already-rendered phrase counting the files involved, for example '2 " +
            "files' — place it, do not re-count it.",
        },
      },
      "importExport.preview.instructions": {
        description:
          "Instruction under the preview heading, telling the user to check the " +
          "listed lines and then press the confirm button. The word standing for " +
          "the button should match the wording used on the 'Confirm import' button " +
          "itself so the two read as the same action.",
      },
      "importExport.preview.needsCarefulReview": {
        description:
          "Red badge inside the automatic-structure notice on the preview screen, " +
          "shown when the automatic analysis was not very sure of itself and the " +
          "user should check the result closely before importing. Short warning " +
          "phrase in the third person.",
      },
      "importExport.preview.recipeNote": {
        description:
          "Final line of the automatic-structure notice on the preview screen. The " +
          "word before the colon labels the named set of rules chosen for reading " +
          "the file. The sentence after it promises that the uploaded file is " +
          "stored untouched, but warns that exporting the translation back into the " +
          "same shape has not been proven to work yet.",
        placeholders: {
          name: "Name of the chosen set of reading rules, as generated by the analysis — " +
            "do not translate the substituted value.",
        },
      },
      "importExport.preview.reviewBeforeImporting": {
        description:
          "Bold label at the top of a notice on the preview screen that lists " +
          "warnings raised while the file was read, next to a badge counting them. " +
          "Short imperative instruction telling the user to read the list before " +
          "committing.",
      },
      "importExport.preview.structuralContentAriaLabel": {
        description:
          "Screen-reader name for the placeholder dash shown instead of a reference " +
          "on preview rows that hold structure rather than translatable prose, such " +
          "as a heading or a layout marker. Short noun phrase; sighted users see " +
          "only the dash.",
      },
      "importExport.review.alreadyThereCount": {
        description:
          "Figure in the summary strip under the 'Review matches' heading: how many " +
          "incoming rows carry exactly the text their line already holds, so there " +
          "is nothing to import for them. Count plus a short phrase meaning 'present " +
          "already'; sits beside sibling fragments, so keep it short.",
        placeholders: {
          count: "Number of incoming rows whose text the matched line already holds.",
        },
      },
      "importExport.review.brokenTimecodeCount": {
        description:
          "Amber figure in the summary strip under the 'Review matches' heading: how " +
          "many cues in the uploaded subtitle file have a timecode that ends before " +
          "it starts, so they could not be placed on any line. Count plus noun " +
          "phrase, no verb.",
        placeholders: {
          count: "Number of uploaded cues whose timecode runs backwards.",
        },
      },
      "importExport.review.conflictCount": {
        description:
          "Amber-coloured figure in the summary strip under the 'Review matches' " +
          "heading: how many of the pairings would overwrite a translation that " +
          "already exists. A count plus the noun for a clash; no verb, since it " +
          "sits beside sibling fragments.",
        placeholders: {
          count: "Number of pairings that would overwrite existing translated text.",
        },
      },
      "importExport.review.contestedWarning": {
        description:
          "Amber warning above the match-review list. Two cues from the uploaded " +
          "subtitle file both lay mostly on the same line of the open file, so one " +
          "of them ended up on a different line or none. From timing alone either " +
          "could be the right one, so the affected rows were left unticked and the " +
          "user is asked to check them.",
        placeholders: {
          count: "Number of review rows involved in such a contest.",
        },
      },
      "importExport.review.deselectAll": {
        description:
          "Small text button under the match-review list that clears every tick at " +
          "once. It swaps places with the 'Select all' button depending on whether " +
          "everything is already ticked, so the two should read as a matched pair " +
          "of opposite imperative commands.",
      },
      "importExport.review.importCellCount": {
        description:
          "Primary button in the footer of the match-review step, which saves the " +
          "ticked translations into the project. Imperative verb followed by how " +
          "many lines will be written, so the user can confirm the scale before " +
          "committing.",
        placeholders: {
          count: "Number of ticked lines that will be written into the project.",
        },
      },
      "importExport.review.looseFitWarning": {
        description:
          "Amber warning above the match-review list, shown when a large share of the " +
          "pairings between uploaded subtitle cues and the open file's lines barely " +
          "overlap in time. Usually the uploaded file's timings are shifted, or its " +
          "translator split the dialogue into different lines. Asks the user to check " +
          "the pairings before saving anything.",
      },
      "importExport.review.matchedCount": {
        description:
          "First figure in the summary strip under the 'Review matches' heading: " +
          "how many incoming rows were successfully paired with an existing line. " +
          "Terse count-plus-participle fragment sitting beside sibling fragments, " +
          "so it must stay short.",
        placeholders: {
          count: "Number of incoming rows that were paired with an existing line.",
        },
      },
      "importExport.review.orderMatchWarning": {
        description:
          "Amber warning above the match-review list, shown when no reference " +
          "identifying each line was available — either the user did not nominate " +
          "a spreadsheet column holding one, or the uploaded format (a subtitle " +
          "file) has none. It explains that rows were therefore paired top to " +
          "bottom by position, which is easy to get wrong, and asks the user to " +
          "eyeball the original text shown beside each row before committing.",
      },
      "importExport.review.reasonBackwardsTimecode": {
        description:
          "Reason shown next to one entry in the list of uploaded cues that were not " +
          "paired with any line: the cue's end time is earlier than its start time, a " +
          "mistake in the uploaded file itself. Short sentence fragment.",
      },
      "importExport.review.reasonLostItsLine": {
        description:
          "Reason shown next to one entry in the list of uploaded cues that were not " +
          "paired with any line: the cue lay mostly on a line that another uploaded " +
          "cue was paired with instead, typically the second half of a line the " +
          "translator split in two. Short sentence fragment.",
      },
      "importExport.review.reasonNoLineInReach": {
        description:
          "Reason shown next to one entry in the list of uploaded cues that were not " +
          "paired with any line: no line of the open file plays close enough in time " +
          "to this cue. Short sentence fragment.",
      },
      "importExport.review.replacesExisting": {
        description:
          "Amber warning line under one row of the match-review list, shown only " +
          "when accepting that row would overwrite a translation that is already " +
          "there. The word before the colon is a verb in the third person " +
          "describing what the incoming text would do; the existing translation " +
          "follows and is truncated if long.",
        placeholders: {
          text: "The translation currently stored for this line, shown so the user can " +
            "see what would be lost — do not translate the substituted value.",
        },
      },
      "importExport.review.rowAlreadyThere": {
        description:
          "Small grey tag on one row of the match-review list: the line already holds " +
          "exactly this text, so importing it would change nothing. Two or three words.",
      },
      "importExport.review.rowContested": {
        description:
          "Small amber tag on one row of the match-review list: this cue and another " +
          "one both lay mostly on the same line, so the user should look at both rows " +
          "before importing. Short phrase ending in an instruction.",
      },
      "importExport.review.rowSharedTiming": {
        description:
          "Small amber tag on one row of the match-review list: another uploaded cue " +
          "has exactly the same start and end time, as when two people speak at " +
          "once, so which line each went to was decided only by their order in the " +
          "file. Short phrase ending in an instruction.",
      },
      "importExport.review.sharedTimingWarning": {
        description:
          "Amber warning above the match-review list. Some uploaded cues share an " +
          "identical time range, as when two people speak at once, so timing could " +
          "not tell them apart and their order in the file decided which line each " +
          "went to. Those rows were left unticked for the user to check.",
        placeholders: {
          count: "Number of review rows sharing an identical time range with another cue.",
        },
      },
      "importExport.review.skippedCueCount": {
        description:
          "Amber figure in the summary strip under the 'Review matches' heading: how " +
          "many cues in the uploaded subtitle file never became rows at all, because " +
          "they had no text or a timing line that could not be read. The bracketed " +
          "part names those two causes.",
        placeholders: {
          count: "Number of cues in the uploaded file that produced no row.",
        },
      },
      "importExport.review.timebaseNamed": {
        description:
          "Note above the match-review list: the uploaded subtitle file was authored " +
          "at a different video frame rate than the open file, so every one of its " +
          "timings was rescaled before pairing. Names both frame rates and how many " +
          "more lines lined up as a result.",
        placeholders: {
          fromFps: "Frame rate the uploaded file's timings were authored at, e.g. \"25\". Keep as is.",
          toFps: "Frame rate the timings were moved onto, e.g. \"23.976\". Keep as is.",
          count: "How many more lines lined up after the adjustment.",
        },
      },
      "importExport.review.timebaseUnnamed": {
        description:
          "Note above the match-review list: every timing in the uploaded subtitle " +
          "file was stretched or shrunk by a small percentage before pairing, to undo " +
          "a frame-rate mismatch whose exact rates can't be named. Says by how much " +
          "and how many more lines lined up as a result.",
        placeholders: {
          percent: "Signed percentage the timings were scaled by, e.g. \"+0.1%\".",
          count: "How many more lines lined up after the adjustment.",
        },
      },
      "importExport.review.timingNote": {
        description:
          "Grey note above the match-review list when a subtitle file was paired by " +
          "time: importing fills in only the translated text, and each line keeps the " +
          "open file's own start and end times. The uploaded file's timings are used " +
          "only to work out which line each translation belongs to.",
      },
      "importExport.review.title": {
        description:
          "Heading of the step where the user checks which incoming rows were " +
          "paired with which existing lines of the project before any translation " +
          "is saved. Imperative instruction acting as a step title; 'matches' are " +
          "the pairings the system proposes.",
      },
      "importExport.review.uncoveredCellCount": {
        description:
          "Figure in the summary strip under the 'Review matches' heading when " +
          "filling the translations of the file the user currently has open: how " +
          "many lines of that file got no translation from the uploaded file. Count " +
          "plus noun phrase plus a past participle meaning 'left without a match'.",
        placeholders: {
          count: "Number of lines in the open file the upload did not supply a translation " +
            "for.",
        },
      },
      "importExport.review.uncoveredListTitle": {
        description:
          "Title of a collapsible list under the summary strip naming every line of " +
          "the open file that received no translation from the upload.",
      },
      "importExport.review.uncoveredSourceCellCount": {
        description:
          "Figure in the summary strip under the 'Review matches' heading when " +
          "importing paired original-and-translation rows: how many lines of " +
          "original text in the project got no translation from the uploaded file. " +
          "Count plus noun phrase plus a past participle meaning 'left without a " +
          "match'.",
        placeholders: {
          count: "Number of existing original-text lines the upload did not supply a " +
            "translation for.",
        },
      },
      "importExport.review.unmatchedListTitle": {
        description:
          "Title of a collapsible list under the summary strip naming every cue of " +
          "the uploaded subtitle file that was not paired with any line, each with " +
          "the reason.",
      },
      "importExport.review.unmatchedRowCount": {
        description:
          "Figure in the summary strip under the 'Review matches' heading: how many " +
          "rows of the uploaded file could not be paired with anything in the " +
          "project and will therefore be ignored. Count plus noun phrase, no verb.",
        placeholders: {
          count: "Number of uploaded rows that were not paired with anything.",
        },
      },
      "importExport.spreadsheet.acceptedFormats": {
        description:
          "Caption in small grey text under the drag-and-drop area, listing the " +
          "file kinds this importer accepts. Only the conjunction joining the three " +
          "format names is translated; the format names themselves are file-format " +
          "identifiers that stay as they are.",
      },
      "importExport.spreadsheet.description": {
        description:
          "Explanatory sentence under the spreadsheet import heading. Tells the " +
          "user which file kinds are accepted and promises that a column-mapping " +
          "step comes before anything is imported. The parenthesised list names the " +
          "kinds of data a column can hold: the original text, its translation, the " +
          "reference that identifies a line, the speaking character, and the " +
          "start/end times.",
      },
      "importExport.spreadsheet.dropZoneHint": {
        description:
          "Invitation inside the dashed drag-and-drop area on the spreadsheet and " +
          "paired-translation import panels. Deliberately unfinished: the sentence " +
          "continues into the 'Choose file' button rendered directly beneath it, so " +
          "keep the trailing 'or' (or its equivalent) leading into that button.",
      },
      "importExport.spreadsheet.legacyXlsUnsupported": {
        description:
          "Error shown in red under the drop area when the chosen file is an " +
          "old-style Excel workbook. Two sentences: a statement that the old " +
          "workbook format cannot be read, then the concrete remedy of re-saving in " +
          "a newer format. The file extensions are literal and stay untranslated.",
      },
      "importExport.spreadsheet.noDataRows": {
        description:
          "Error shown after the user confirms the column mapping on the general " +
          "spreadsheet importer but every row turned out to be empty in the column " +
          "they nominated as the original text. First sentence states the outcome, " +
          "second suggests what to check.",
      },
      "importExport.spreadsheet.noSheetsFound": {
        description:
          "Error shown in red under the drop area when an Excel workbook was read " +
          "successfully but turned out to contain no worksheets at all, so there is " +
          "nothing to import. Single short statement of fact.",
      },
      "importExport.spreadsheet.selectSheetHint": {
        description:
          "Sentence under the 'Select a sheet' heading, shown when importing paired " +
          "source-and-translation rows or filling an existing file's translations. " +
          "Explains why the extra step exists and asks the user to choose exactly " +
          "one worksheet.",
      },
      "importExport.spreadsheet.selectSheetTitle": {
        description:
          "Heading of the step that appears when an uploaded Excel workbook holds " +
          "more than one worksheet and the user must pick which one to import. " +
          "Imperative instruction acting as a step title.",
      },
      "importExport.spreadsheet.selectSheetUnitHint": {
        description:
          "Sentence under the 'Select a sheet' heading on the general spreadsheet " +
          "importer. Unlike the paired-import wording it explains the rule rather " +
          "than giving an instruction: one worksheet becomes one imported file, so " +
          "only one can be chosen at a time.",
      },
      "importExport.spreadsheet.sendingCells": {
        description:
          "Reassurance line under the 'Uploading…' heading while an imported " +
          "spreadsheet is being saved, naming what is happening. 'Cells' are the " +
          "individual translatable lines the spreadsheet was split into.",
      },
      "importExport.spreadsheet.sheetRowCount": {
        description:
          "Second line of a selectable worksheet card on the 'Select a sheet' step, " +
          "telling the user how big that worksheet is. A bare count plus the noun " +
          "for a spreadsheet row, with no verb.",
        placeholders: {
          count: "Number of rows the worksheet contains.",
        },
      },
      "importExport.spreadsheet.sourceUnavailable": {
        description:
          "Failure message shown when the import is committed but the browser can " +
          "no longer read the file the user picked earlier, for instance because it " +
          "was moved or renamed in the meantime. Statement of fact with no closing " +
          "full stop, since it is rendered as an error line.",
      },
      "importExport.spreadsheet.title": {
        description:
          "Heading at the top of the spreadsheet import panel, shown when the user " +
          "has chosen to import a comma- or tab-separated file or an Excel " +
          "workbook. Short noun phrase naming the panel, not an instruction.",
      },
    },
  },
  surfaces: [],
})
