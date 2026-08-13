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
    "importExport.upload.formatsDocuments": "DOCX, TXT, MD, HTML, JSON/ARB, PPTX, IDML (InDesign)",
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
    "importExport.dialog.titleHelloao": "Bible API (helloao.org)",
    "importExport.dialog.titleTn": "Translation Notes (TSV)",
    "importExport.dialog.titleSpreadsheet": "Spreadsheet (CSV / XLSX)",
    "importExport.dialog.titlePaired": "Paired Translation Import",
    "importExport.dialog.finishSaveFailed": "Couldn't finish saving your import — please try again. ({message})",
    "importExport.dialog.saveFailed": "Couldn't save your import — please try again. ({message})",
    "importExport.dialog.labelsNeedSourceFile":
      "Cell labels require an existing source file in this project. Import source files first, then return here.",
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
    "importExport.format.audioByCharacter.label": "Audio by character",
    "importExport.format.audioByCharacter.description":
      "One WAV per cast member — each character's clips concatenated, best-available audio " +
      "(recording → generated). Concatenated order = document order. Trim-honoring deferred; clips " +
      "export full-length.",
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
    "importExport.dialog.filenameLegend": "Filename",
    "importExport.dialog.filenameAriaLabel": "Export filename (without extension)",
    "importExport.dialog.projectScopeUsesProjectName": "Project-scope exports use the project name.",
    "importExport.dialog.appendTimestamp": "Append timestamp",
    "importExport.dialog.appendLangTag": "Append language tag",
    "importExport.dialog.noCellsWithAudio": "No cells with audio found in this file.",
    "importExport.dialog.clipCount": plural({ one: "{count} clip", other: "{count} clips" }),
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

    // — Thrown-error triage: src/lib/sync/source-upload.ts —
    "importExport.errors.sourceUploadEmpty": "Source upload failed: the original file is empty.",
    "importExport.errors.sourceUploadTooLarge": "Source upload failed: the original file exceeds the {maxSize} limit.",
    "importExport.errors.couldNotGetUploadToken": "Couldn't get an upload token — sign in and try again.",
    "importExport.errors.sourceUploadNetworkFailed": "Source upload failed: {detail}",
    "importExport.errors.sourceUploadFailed": "Source upload failed",
    "importExport.errors.artifactBindingNetworkFailed": "Artifact binding failed: {detail}",
    "importExport.errors.artifactBindingFailed": "Artifact binding failed",
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
      "importExport.biblica.splitSentencesLabel": {
        description:
          "Visible label AND the checkbox's own accessible name (identical text, reused directly rather than duplicated as a separate aria-label key) for splitting long Biblica study notes into one cell per sentence.",
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
      "importExport.dialog.downloadFile": {
        description: "Label of the primary download button on the Export dialog, naming the exact file it will produce.",
        placeholders: { fileName: "Filename (with extension) the download will produce — not translated." },
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
      "importExport.dialog.filenameAriaLabel": {
        description: "Accessible name for the export filename input.",
      },
      "importExport.dialog.clipCount": {
        description: "Clip count in the audio-by-character export preview, per cast member.",
        placeholders: { count: "Number of audio clips for this cast member." },
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
    },
  },
  surfaces: [],
})
