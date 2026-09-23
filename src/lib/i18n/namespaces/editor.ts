/**
 * `editor.*` — the translation editor (AQU-511 fan-out).
 *
 * This is the screen a translator lives in all day: the source/target table,
 * the per-cell action rail and expansion tabs, the audio/timeline lenses, the
 * footnote tray, and the reference sidebars. Almost everything here is an
 * inline control or a status word squeezed next to translation content, so
 * length pressure is the dominant constraint — see the per-key `maxLength`.
 *
 * Shared verbs (Save, Cancel, Close, Delete, Dismiss, Retry, Loading…, Add,
 * Clear, None, Name) are NOT re-keyed here; they come from `common.*`.
 */

import { defineNamespace, plural } from "./types"

/**
 * Shared halves of the milestone-navigator context notes.
 *
 * The navigator keys one sentence per kind of division (chapters, slides,
 * stories…) so the noun is written into the sentence instead of being poured
 * into a frame — see the comment over those keys. That makes eight near-identical
 * notes per sentence, so the part describing the control is written once here and
 * each entry appends the clause naming which kind of file it serves. Every entry
 * is still an explicit literal key, so `tsc` keeps rejecting a note for a key
 * that does not exist.
 */
const MILESTONE_MOVE_BETWEEN =
  "Screen-reader name of the button group holding the previous/next arrows and " +
  "the division picker, in the editor header. Used when "
const MILESTONE_PREVIOUS =
  "Screen-reader name of the left-arrow button; it steps back one division (or " +
  "one cell range within a split division). Icon-only, so this string is the " +
  "only name it has. Used when "
const MILESTONE_NEXT =
  "Screen-reader name of the right-arrow button; it steps forward one division. " +
  "Icon-only, so this string is the only name it has. Used when "
const MILESTONE_CURRENT =
  "Screen-reader name of the picker button between the two arrows. It does " +
  "double duty: it states where the user currently is, then says what the button " +
  "does. Keep both halves. Used when "
const MILESTONE_CURRENT_WITH_CELLS =
  "The same picker name, for a division split into cell ranges, naming the range " +
  "the user is inside. Used when "
const MILESTONE_FIND_PLACEHOLDER =
  "Placeholder in the search field inside the open division picker. Ends with an " +
  "ellipsis glyph (…). It prompts typing, so it should read as an invitation " +
  "rather than a label. Used when "
const MILESTONE_FIND =
  "Screen-reader name of that same search field — the placeholder without its " +
  "trailing ellipsis, which a screen reader would otherwise announce as " +
  "punctuation. Used when "
const MILESTONE_EMPTY =
  "Message inside the picker when the typed query matches no division. Full " +
  "sentence with a period. Used when "

const MILESTONE_LABEL_PLACEHOLDER =
  "The division's own display label ('Matthew 1', a slide title). Content, so " +
  "never translate the substituted value."
const MILESTONE_CELLS_PLACEHOLDER =
  "The cell range within the division, already formatted, e.g. '101–117'. " +
  "Numbers only — do not translate."
const MILESTONE_RANGE_PLACEHOLDER =
  "The inclusive range as already formatted by the app, e.g. '101–117' (en " +
  "dash). Numbers only — do not translate."

/** Which kind of file each vocabulary serves, appended to the notes above. */
const MILESTONE_KIND_CHAPTER =
  "the file is scripture divided into the chapters of a book."
const MILESTONE_KIND_SLIDE =
  "the file is presentation-shaped and divided into slides."
const MILESTONE_KIND_STORY =
  "the file is an oral-Bible or story set divided into stories."
const MILESTONE_KIND_SECTION =
  "the file is a document divided into titled sections, the " +
  "chapter-equivalent for non-scripture."
const MILESTONE_KIND_TIME_RANGE =
  "the file is audio or video divided into spans of time on the " +
  "timeline."
const MILESTONE_KIND_PART =
  "the file is divided into numbered parts."
const MILESTONE_KIND_GROUP =
  "the divisions are arbitrary groupings of cells with no more specific " +
  "name."
const MILESTONE_KIND_MILESTONE =
  "the file mixes several kinds of division, so the catch-all word is " +
  "used."

export const editor = defineNamespace({
  keys: {
    // — Lens switch (text vs audio/media) ————————————————————————————
    "editor.lens.text": "Text",

    // — Batch AI translation banner ————————————————————————————————
    "editor.completion.translating": "Translating",
    "editor.completion.stop": "Stop translating",
    "editor.completion.failed": plural(
      {
        one: "{failed} of {total} cell failed.",
        other: "{failed} of {total} cells failed.",
      },
      "total",
    ),
    "editor.completion.failedPartial": plural(
      {
        one: "{failed} of {total} cell failed — {done} completed.",
        other: "{failed} of {total} cells failed — {done} completed.",
      },
      "total",
    ),

    // — Health / decay breakdown popover ——————————————————————————
    "editor.health.needsAttention": "{percent}% of cells need attention",
    "editor.health.noneNeedAttention": "No cells need attention.",
    "editor.health.biggestDrags": "Biggest drags",
    "editor.health.staleSource": plural({
      one: "{count} cell with stale source",
      other: "{count} cells with stale source",
    }),

    // — Per-cell action rail ————————————————————————————————————————
    "editor.rail.moreActions": "More actions",

    // — Per-cell audio: record / upload / playback ——————————————————
    "editor.audio.record": "Record audio",
    "editor.audio.recordingDisabled": "Recording disabled",
    "editor.audio.micBlockedTooltip": "Microphone access blocked — click for help",
    "editor.audio.micBlockedTitle": "Microphone blocked",
    "editor.audio.micBlockedHelp":
      "Open your browser's site settings (🔒 in the address bar) and allow " +
      "microphone access, then reload the page.",

    // — Per-cell actions menu (ellipsis popover) ——————————————————
    "editor.cell.addComment": "Add comment",
    "editor.cell.closeDetails": "Close cell details",

    // — Waveform strip under a translated cell ——————————————————————
    "editor.waveform.scrubber": "Audio scrubber",
    "editor.waveform.seekTooltip": "Click to seek",
    "editor.waveform.loading": "Loading waveform...",
    "editor.waveform.needsLoadTooltip":
      "Click to download and decode this clip's waveform",
    "editor.waveform.load": "Load waveform",
    "editor.waveform.decodeErrorTooltip": "Couldn't decode the waveform; click retry",
    "editor.waveform.retryTooltip": "Couldn't load this clip's waveform; click to retry",
    "editor.waveform.retry": "Retry waveform",

    // — Per-cell audio upload ————————————————————————————————————
    "editor.audio.upload": "Upload audio file",
    "editor.audio.uploadSignIn": "Sign in to upload recordings",

    // — Audio crop popover ————————————————————————————————————————
    "editor.crop.open": "Crop audio",
    "editor.crop.title": "Crop",
    "editor.crop.reset": "Reset to full clip",
    "editor.crop.start": "Crop start",
    "editor.crop.end": "Crop end",

    // — Empty / loading / error states where the table would be ——————
    "editor.file.loadErrorTitleNamed": "Couldn't load {fileName}",
    "editor.file.loadErrorTitle": "Couldn't load this file",
    "editor.file.loadErrorBody":
      "The file is still safe. Check your connection and try loading it again.",
    "editor.file.retryLoad": "Retry loading file",
    "editor.file.loadingFromCloud": "Loading file from the cloud",
    "editor.file.noneSelectedTitle": "No file selected",
    "editor.file.noneSelectedBody": "Pick a file from the sidebar to start translating.",
    "editor.file.noFilesTitle": "No files yet",
    "editor.file.noFilesBody": "Import a file to get started.",
    "editor.file.importFile": "Import a file",
    "editor.file.emptyNamedTitle": "{fileName} is empty",
    "editor.file.emptyTitle": "This file has no cells yet",
    "editor.file.emptyBody": "Import content, or start typing in the first cell.",
    "editor.file.importContent": "Import content",

    // — Stale-source badges in the cell rail ————————————————————————
    "editor.stale.directLabel": "Source changed since last revision",
    "editor.stale.directTooltip":
      "The source has changed since this translation was last revised.",
    "editor.stale.upstreamLabel": "Upstream ancestry changed",
    "editor.stale.upstreamTooltip":
      "Something further upstream in the translation chain has changed — this " +
      "cell's ancestry is stale.",

    // — Attaching media to a time-ordered file ——————————————————————
    "editor.media.emptyTitle": "No media on this file yet",
    "editor.media.dropHint": "Drag & drop an audio or video file here, or",
    "editor.media.choose": "Choose media file",
    "editor.media.adding": "Adding media to this file…",
    "editor.media.urlLabel": "Media URL",
    "editor.media.attach": "Attach",
    "editor.media.urlHint":
      "Or paste a direct media URL — the clip streams from its source; only " +
      "timing metadata is stored.",

    // — Footnotes: the inline strip, the bottom tray, and one note's row ——
    "editor.footnotes.label": "Footnotes",
    "editor.footnotes.trayRegion": "Visible footnotes",
    "editor.footnotes.trayHint": "Updates as the editor scrolls",
    "editor.footnotes.closeTray": "Close footnotes tray",
    "editor.footnotes.trayEmpty": "No footnotes in the visible rows.",
    "editor.footnotes.docxReadOnly": "read-only · DOCX round-trip not yet safe",
    "editor.footnotes.addTarget": "Add target footnote",
    "editor.footnotes.noTarget": "No target footnote",
    "editor.footnotes.noSource": "No source footnote",
    "editor.footnotes.emptyNote": "Empty footnote",
    "editor.footnotes.emptyTarget": "Empty target footnote",
    "editor.footnotes.targetRole": "Target footnote",
    "editor.footnotes.editPlaceholder": "Translate footnote...",
    "editor.footnotes.editLabel": "Edit footnote",
    "editor.footnotes.editMarker": "Edit footnote {label}",
    "editor.footnotes.clickToEdit": "Click to edit footnote",
    "editor.footnotes.translationLabel": "Footnote translation",
    "editor.footnotes.addTranslation": "Add translation...",
    "editor.footnotes.deleteConfirm": "I'm sure",
    "editor.footnotes.saveConflict":
      "Couldn't save — this footnote changed while you were editing. Copy your " +
      "text, cancel, and reopen it.",

    // — Add-footnote dialog ————————————————————————————————————————
    "editor.footnote.add": "Add footnote",
    "editor.footnote.addDescription":
      "Choose how the marker should appear, then add the note for this anchor.",
    "editor.footnote.markerStyle": "Marker style",
    "editor.footnote.markerStyleGroup": "Footnote marker style",
    "editor.footnote.markerNumbered": "Numbering",
    "editor.footnote.markerNumberedDesc": "Use automatic numeric markers.",
    "editor.footnote.markerLettered": "Lettering",
    "editor.footnote.markerLetteredDesc":
      "Use letter markers for a separate note sequence.",
    "editor.footnote.textLabel": "Footnote text",
    "editor.footnote.textPlaceholder": "Selected text: footnote text...",
    "editor.footnote.attachedTo": "Attached to {ref}.",
    "editor.footnote.textHint":
      "Include the selected word or phrase before a colon when it helps clarify " +
      "the note.",
    "editor.footnote.targetPreview": "Target preview",
    "editor.footnote.previewEmptyCell": "Empty cell",

    // — Milestone (chapter / slide / story / …) navigator in the header ——
    //
    // Every label this navigator renders names the file's kind of division, and
    // the first pass keyed them as frames with the noun poured in ("Previous
    // {singular}" + a separately translated "chapter"). No translator can fix
    // that: Arabic has to agree the noun with the frame around it, Burmese puts
    // it somewhere else in the sentence, and the app was lower-casing a
    // translated word with toLocaleLowerCase on top. So each sentence is keyed
    // once PER KIND with the noun written in, and the count of keys is the price
    // of sentences that can actually be translated.
    //
    // The plural heading a kind uses is still `vocab.<kind>Plural` below — those
    // keys are standalone nouns (a picker group heading, an assignment scope
    // option), so they interpolate into nothing and are shared with dialog.assign.
    "editor.milestone.region": "Milestone navigation",
    "editor.milestone.cellRange": "Cells {range}",
    "editor.milestone.percentTranslated": "{percent}% translated",
    "editor.milestone.percentValidated": "{percent}% validated",
    "editor.milestone.splitAria": "Split into milestones",
    "editor.milestone.splitHint":
      "Show only the cells in the current division. Use the arrows to move to the next one.",

    "editor.milestone.chapter.moveBetween": "Move between chapters",
    "editor.milestone.chapter.previous": "Previous chapter",
    "editor.milestone.chapter.next": "Next chapter",
    "editor.milestone.chapter.current": "Current chapter: {label}. Choose chapter",
    "editor.milestone.chapter.currentWithCells":
      "Current chapter: {label}, cells {cells}. Choose chapter",
    "editor.milestone.chapter.findPlaceholder": "Find a chapter…",
    "editor.milestone.chapter.find": "Find a chapter",
    "editor.milestone.chapter.empty": "No chapters found.",

    "editor.milestone.slide.moveBetween": "Move between slides",
    "editor.milestone.slide.previous": "Previous slide",
    "editor.milestone.slide.next": "Next slide",
    "editor.milestone.slide.current": "Current slide: {label}. Choose slide",
    "editor.milestone.slide.currentWithCells":
      "Current slide: {label}, cells {cells}. Choose slide",
    "editor.milestone.slide.findPlaceholder": "Find a slide…",
    "editor.milestone.slide.find": "Find a slide",
    "editor.milestone.slide.empty": "No slides found.",

    "editor.milestone.story.moveBetween": "Move between stories",
    "editor.milestone.story.previous": "Previous story",
    "editor.milestone.story.next": "Next story",
    "editor.milestone.story.current": "Current story: {label}. Choose story",
    "editor.milestone.story.currentWithCells":
      "Current story: {label}, cells {cells}. Choose story",
    "editor.milestone.story.findPlaceholder": "Find a story…",
    "editor.milestone.story.find": "Find a story",
    "editor.milestone.story.empty": "No stories found.",

    "editor.milestone.section.moveBetween": "Move between sections",
    "editor.milestone.section.previous": "Previous section",
    "editor.milestone.section.next": "Next section",
    "editor.milestone.section.current": "Current section: {label}. Choose section",
    "editor.milestone.section.currentWithCells":
      "Current section: {label}, cells {cells}. Choose section",
    "editor.milestone.section.findPlaceholder": "Find a section…",
    "editor.milestone.section.find": "Find a section",
    "editor.milestone.section.empty": "No sections found.",

    "editor.milestone.timeRange.moveBetween": "Move between time ranges",
    "editor.milestone.timeRange.previous": "Previous time range",
    "editor.milestone.timeRange.next": "Next time range",
    "editor.milestone.timeRange.current": "Current time range: {label}. Choose time range",
    "editor.milestone.timeRange.currentWithCells":
      "Current time range: {label}, cells {cells}. Choose time range",
    "editor.milestone.timeRange.findPlaceholder": "Find a time range…",
    "editor.milestone.timeRange.find": "Find a time range",
    "editor.milestone.timeRange.empty": "No time ranges found.",

    "editor.milestone.part.moveBetween": "Move between parts",
    "editor.milestone.part.previous": "Previous part",
    "editor.milestone.part.next": "Next part",
    "editor.milestone.part.current": "Current part: {label}. Choose part",
    "editor.milestone.part.currentWithCells":
      "Current part: {label}, cells {cells}. Choose part",
    "editor.milestone.part.findPlaceholder": "Find a part…",
    "editor.milestone.part.find": "Find a part",
    "editor.milestone.part.empty": "No parts found.",

    "editor.milestone.group.moveBetween": "Move between groups",
    "editor.milestone.group.previous": "Previous group",
    "editor.milestone.group.next": "Next group",
    "editor.milestone.group.current": "Current group: {label}. Choose group",
    "editor.milestone.group.currentWithCells":
      "Current group: {label}, cells {cells}. Choose group",
    "editor.milestone.group.findPlaceholder": "Find a group…",
    "editor.milestone.group.find": "Find a group",
    "editor.milestone.group.empty": "No groups found.",

    "editor.milestone.milestone.moveBetween": "Move between milestones",
    "editor.milestone.milestone.previous": "Previous milestone",
    "editor.milestone.milestone.next": "Next milestone",
    "editor.milestone.milestone.current": "Current milestone: {label}. Choose milestone",
    "editor.milestone.milestone.currentWithCells":
      "Current milestone: {label}, cells {cells}. Choose milestone",
    "editor.milestone.milestone.findPlaceholder": "Find a milestone…",
    "editor.milestone.milestone.find": "Find a milestone",
    "editor.milestone.milestone.empty": "No milestones found.",

    "editor.milestone.vocab.chapterPlural": "Chapters",
    "editor.milestone.vocab.slidePlural": "Slides",
    "editor.milestone.vocab.storyPlural": "Stories",
    "editor.milestone.vocab.sectionPlural": "Sections",
    "editor.milestone.vocab.timeRangePlural": "Time ranges",
    "editor.milestone.vocab.partPlural": "Parts",
    "editor.milestone.vocab.groupPlural": "Groups",
    "editor.milestone.vocab.milestonePlural": "Milestones",

    // — Milestone-navigator fallback labels (AQU-914) — assigned when a division
    // has no persisted label of its own (legacy imports, deterministic re-derive).
    "editor.milestone.vocab.startLabel": "Start",
    "editor.milestone.vocab.story": "Story",
    "editor.milestone.vocab.group": "Group",
    "editor.milestone.vocab.section": "Section",
    "editor.milestone.label.slide": "Slide {number}",
    "editor.milestone.label.story": "Story {number}",
    "editor.milestone.label.part": "Part {number}",

    // — Column names, reused wherever the two sides are named ——————————
    "editor.column.source": "Source",
    "editor.column.target": "Target",

    // — View-settings popover ————————————————————————————————————————
    "editor.view.settings": "Editor settings",
    "editor.view.showLineNumbers": "Show line numbers",
    "editor.view.showCellLabels": "Show cell labels",
    "editor.view.showTranslationNotes": "Show translation notes",
    "editor.view.showHealthIndicators": "Show health indicators",
    "editor.view.targetKeyTerms": "Target key terms",
    "editor.view.targetKeyTermsAlways": "Always",
    "editor.view.targetKeyTermsFocused": "Focused cell only",
    "editor.view.targetKeyTermsNever": "Never",
    "editor.view.footnotesHidden": "Hidden",
    "editor.view.footnotesInline": "Inline under cells",
    "editor.view.footnotesTray": "Bottom tray",
    "editor.view.textDirection": "Text Direction",
    "editor.view.fontSize": "Font Size",
    "editor.view.directionAuto": "Auto",
    "editor.view.directionOf": "{side} direction",
    "editor.view.decreaseFontSize": "Decrease {side} font size",
    "editor.view.increaseFontSize": "Increase {side} font size",
    "editor.view.useAppFontSize": "Use app font size for {side}",
    "editor.view.directionMismatch":
      "{side} is forced {forced}, but content looks {detected}",
    "editor.view.dismissDirectionWarning": "Dismiss direction warning",
    "editor.view.dirLtr": "left-to-right",
    "editor.view.dirRtl": "right-to-left",
    "editor.view.dirMixed": "mixed",

    // — Parallel-bibles reference sidebar ————————————————————————————
    "editor.bibles.openTooltip": "Parallel bibles: see this verse in other versions",
    "editor.bibles.show": "Show parallel bibles",
    "editor.bibles.hide": "Hide parallel bibles",
    "editor.bibles.edgeTab": "Bibles",
    "editor.bibles.title": "Parallel Bibles",
    "editor.bibles.noReferences": "No Bible references",
    "editor.bibles.noReferencesDescription":
      "The current cells have no Bible references with chapter and verse numbers. " +
      "Parallel Bibles needs these references to show matching text.",
    "editor.bibles.scrollHint":
      "Scroll the editor to a verse to see it in other bible versions.",
    "editor.bibles.noVersions":
      "No versions added yet. Add a bible version to read alongside your text.",
    "editor.bibles.removeVersion": "Remove {version}",
    "editor.bibles.scrollToVerse": "Scroll to a verse to see its text.",
    "editor.bibles.noTextForRef": "No text for {ref} in this version.",
    "editor.bibles.searchPlaceholder": "Search versions (e.g. 'eng', 'BSB')",
    "editor.bibles.searchLabel": "Search Bible versions",
    "editor.bibles.failedToLoad": "Failed to load: {error}",
    "editor.bibles.loadingVersions": "Loading versions…",
    "editor.bibles.noMatches": "No matches.",
    "editor.bibles.closePicker": "Close picker",
    "editor.bibles.addVersion": "Add version",
    "editor.bibles.attribution": "Text from the",

    // — Verse-resources reference sidebar (AQU-461) ————————————————————
    "editor.resources.openTooltip":
      "Verse resources: the people, places and terms this verse mentions",
    "editor.resources.show": "Show verse resources",
    "editor.resources.hide": "Hide verse resources",
    "editor.resources.edgeTab": "Helps",
    "editor.resources.title": "Verse Resources",
    "editor.resources.scrollHint":
      "Scroll the editor to a verse to see the people, places and terms it mentions.",
    "editor.resources.noneForRef": "No linked people, places or terms for {ref}.",
    "editor.resources.failedToLoad": "Couldn't load resources: {error}",
    "editor.resources.openMap": "Open map",
    "editor.resources.mapAria": "Map showing {place} at {coords}",
    "editor.resources.openExternal": "Open the full article",
    "editor.resources.openExternalAria": "Open the full article about {entity}",
    "editor.resources.attribution": "Reference data from the",

    // — Translation-notes reference sidebar ——————————————————————————
    "editor.tn.title": "Translation Notes",
    "editor.tn.hide": "Hide translation notes",
    "editor.tn.focusHint": "Focus a translation cell to see notes for that verse.",
    "editor.tn.noneForRef": "No translation notes for {ref}.",

    // — eBible target-import review panel ————————————————————————————
    "editor.ebible.matched": plural({
      one: "{count} verse matched",
      other: "{count} verses matched",
    }),
    "editor.ebible.conflicts": plural({
      one: "{count} conflict (existing target content)",
      other: "{count} conflicts (existing target content)",
    }),
    "editor.ebible.orphans": plural({
      one: "{count} orphan",
      other: "{count} orphans",
    }),
    "editor.ebible.selectedCount": "{selected} / {total} selected",
    "editor.ebible.willOverwrite": "({count} will overwrite existing content)",
    "editor.ebible.selectAll": "All",
    "editor.ebible.selectClean": "Clean only",
    "editor.ebible.noMatches":
      "No source cells matched — the eBible translation may use different book " +
      "references.",
    "editor.ebible.orphanSummary": plural({
      one: "{count} orphan verse (in eBible but no matching source cell)",
      other: "{count} orphan verses (in eBible but no matching source cell)",
    }),
    "editor.ebible.andMore": "…and {count} more",
    "editor.ebible.unmatched": plural({
      one: "{count} source cell had no matching eBible verse.",
      other: "{count} source cells had no matching eBible verse.",
    }),
    "editor.ebible.apply": plural({
      one: "Apply {count} verse",
      other: "Apply {count} verses",
    }),
    "editor.ebible.conflictBadge": "conflict",

    // — Cell validation state words, reused in badges and a11y names ————
    "editor.state.validated": "validated",
    "editor.state.unvalidated": "unvalidated",

    // — Per-cell edit-history drawer ————————————————————————————————
    "editor.history.title": "Edit history",
    "editor.history.close": "Close history",
    "editor.history.loading": "Loading history…",
    "editor.history.loadFailed": "Couldn't load edit history.",
    "editor.history.noEdits": "No edits yet.",
    "editor.history.refreshFailed":
      "Couldn't refresh from the server — showing local edits.",
    "editor.history.revisions": plural({
      one: "{count} significant revision",
      other: "{count} significant revisions",
    }),
    "editor.history.collapsedNote":
      "({total} total, {hidden} minor intermediate edits collapsed)",
    "editor.history.staleBadge": "stale branch",
    "editor.history.staleTooltip":
      "This edit lost the first-child-of-parent race for its slot. It was logged " +
      "but never applied to the cell's current value.",
    "editor.history.syncing": "syncing",
    "editor.history.syncFailed": "sync failed",
    "editor.history.syncFailedTooltip":
      "This edit is safe in this browser, but it could not sync to the server. " +
      "Use the sync indicator to retry or inspect the failure.",
    "editor.history.minorEdits": plural({
      one: "+{count} minor edit",
      other: "+{count} minor edits",
    }),
    "editor.history.author": "by {author}",
    "editor.history.currentMarker": "· current",
    "editor.history.bumpedMarker": "· bumped by a concurrent edit",
    "editor.history.examples": plural({
      one: "{count} example used",
      other: "{count} examples used",
    }),
    "editor.history.promote": "Promote to current",
    "editor.history.promoteConfirm": "Make this the current value?",
    "editor.history.restore": "Restore this version",
    "editor.history.restoreConfirm": "Replace the current text with this version?",
    "editor.history.showIntermediate": "Show intermediate edits",
    "editor.history.hideIntermediate": "Hide intermediate edits",

    // — Multi-cell selection toolbar ————————————————————————————————
    "editor.selection.actions": "Selection actions",
    "editor.selection.count": "{count} selected",
    "editor.selection.needTranslation": "({count} need translation)",
    "editor.selection.voiceTogether": "Voice together",
    "editor.selection.voiceUnavailable": "Voicing isn't available here",
    "editor.selection.voiceNeedTwo": "Select at least two translated lines",
    "editor.selection.voiceTooltip": "Voice {count} lines as one clip",
    "editor.selection.translate": "Translate",
    "editor.selection.translateNotConfigured":
      "Translation isn't configured for this project",
    "editor.selection.allTranslated": "All selected cells already have translations",
    "editor.selection.translateTooltip": "Translate {count} missing",
    "editor.selection.validate": "Validate",
    "editor.selection.validateText": "Validate text",
    "editor.selection.validateTooltip": plural({
      one: "Validate {count} cell",
      other: "Validate {count} cells",
    }),
    "editor.selection.validateOutOfScope":
      "Some selected cells are outside your assigned files or lanes",
    "editor.selection.validateAllMine": "All selected cells are already validated by you",
    "editor.selection.validateAiDrafts":
      "Nothing eligible — untouched AI drafts require individual review",
    "editor.selection.validateNeedTranslation": "Selected cells need a translation first",
    "editor.selection.validateNothingEligible": "Nothing eligible to validate",
    "editor.selection.removeMyValidations": "Remove my text validations",
    "editor.selection.validateAudio": "Validate audio",
    "editor.selection.validateAudioTooltip": plural({
      one: "Validate {count} take in the selection",
      other: "Validate {count} takes in the selection",
    }),
    "editor.selection.validateAudioNoTakes": "Nothing recorded in the selection",
    "editor.selection.validateAudioAllMine": "You have validated every take in the selection",
    "editor.selection.validateAudioNothingEligible": "No takes here are yours to validate",
    "editor.selection.removeMyAudioValidations": "Remove my audio validations",
    "editor.selection.noAudioValidations": "You have not validated any take here",
    "editor.selection.unvalidateAudioTooltip": plural({
      one: "Remove your validation from {count} take",
      other: "Remove your validation from {count} takes",
    }),
    "editor.selection.unvalidatedAudioToast": plural({
      one: "Removed your validation from {count} take",
      other: "Removed your validation from {count} takes",
    }),
    "editor.selection.validatedAudioToast": plural({
      one: "Validated {count} take",
      other: "Validated {count} takes",
    }),
    "editor.selection.noValidations": "No cells have your validation",
    "editor.selection.unvalidateTooltip": plural({
      one: "Remove your validation from {count} cell",
      other: "Remove your validation from {count} cells",
    }),
    "editor.selection.harmonize": "Harmonize…",
    "editor.selection.harmonizeNeedLead":
      "You need project lead role to run a harmonization sweep",
    "editor.selection.harmonizeTooltip": plural({
      one: "Open harmonize sweep for {count} selected cell",
      other: "Open harmonize sweep for {count} selected cells",
    }),
    "editor.selection.clearTooltip": "Clear selection (Esc)",
    "editor.selection.clear": "Clear selection",
    "editor.selection.validatedToast": plural({
      one: "Validated {count} cell",
      other: "Validated {count} cells",
    }),
    "editor.selection.validatedToastSkipped": plural({
      one: "Validated {count} cell ({already} already validated)",
      other: "Validated {count} cells ({already} already validated)",
    }),
    "editor.selection.unvalidatedToast": plural({
      one: "Removed validations from {count} cell",
      other: "Removed validations from {count} cells",
    }),

    // AQU-646 stage 6I: the attach-video DIALOG is gone (Sam, 2026-08-27) — it
    // claimed to upload a video and did nothing. Only this one string outlived
    // it, because four import panels borrow it for their own file pickers. The
    // `editor.video.` prefix is a misnomer now; it is left alone rather than
    // renamed, which would be churn across five files for a key name.
    "editor.video.chooseFile": "Choose file",

    // — Timeline lens (time-ordered files) ————————————————————————
    "editor.timeline.title": "Timeline",
    "editor.timeline.followPlayhead": "Follow playhead",
    "editor.timeline.linkVideo": "Link video",
    "editor.timeline.changeVideo": "Change video",
    "editor.timeline.coreVideoPrompt": "Core video URL (leave blank to clear)",
    "editor.timeline.zoomIn": "Zoom in",
    "editor.timeline.zoomOut": "Zoom out",
    "editor.timeline.laneSubtitle": "Subtitles",
    "editor.timeline.laneSubtitleSub": "text · reading",
    "editor.timeline.laneSourceAudio": "Source audio",
    "editor.timeline.laneSourceAudioSub": "original speech",
    "editor.timeline.laneTargetAudio": "Target audio",
    "editor.timeline.laneTargetAudioSub": "takes · generated",
    "editor.timeline.laneUntimed": "Untimed",
    "editor.timeline.laneUntimedSub": "no timecode yet",
    // AQU-646: a track whose button silences something the standard per-track
    // sentences cannot name — on a subtitle file the source row's cues sit over
    // the FILM's soundtrack, and "source audio" there is true but useless. The
    // name is a frame here because the alternative is not naming it at all.
    // AQU-646 stage 6: one menu for everything that attaches material to the
    // file already open, as distinct from Import, which mints a new file.
    "editor.timeline.sourcesMenu": "Sources",
    "editor.timeline.sourcesMenuAria": "Attach material to this file",
    "editor.timeline.checkMenu": "Check",
    "editor.timeline.checkMenuLinking": "Linking",
    "editor.timeline.checkMenuAria": "Check this file's pairings and characters",
    "editor.timeline.muteNamed": "Mute {name}",
    "editor.timeline.unmuteNamed": "Unmute {name}",
    "editor.timeline.namedAudible": "{name} is audible — click to mute",
    "editor.timeline.namedMuted": "{name} is muted — click to unmute",
    "editor.timeline.muteSourceAudio": "Mute source audio",
    "editor.timeline.unmuteSourceAudio": "Unmute source audio",
    "editor.timeline.sourceAudioAudible": "Source audio is audible — click to mute",
    "editor.timeline.sourceAudioMuted": "Source audio is muted — click to unmute",
    "editor.timeline.muteTargetAudio": "Mute target audio",
    "editor.timeline.unmuteTargetAudio": "Unmute target audio",
    "editor.timeline.targetAudioAudible": "Target audio is audible — click to mute",
    "editor.timeline.targetAudioMuted": "Target audio is muted — click to unmute",
    "editor.timeline.timingModeDubbing": "Original's timing",
    "editor.timeline.timingModeDubbingHint":
      "The translation is fitted to the original recording's timing.",
    "editor.timeline.timingModeDubbingHintLocked":
      "The translation is fitted to the original recording's timing. Only a maintainer can change this.",
    "editor.timeline.timingModeFree": "Free timing",
    "editor.timeline.timingModeFreeHint":
      "Verses are laid end to end — each takes as much room as its longer side.",
    "editor.timeline.timingModeFreeHintLocked":
      "Verses are laid end to end — each takes as much room as its longer side. Only a maintainer can change this.",
    "editor.timeline.qualityToggleAria": "Play generated voices at original quality",
    // AQU-646: "Recordings are always compressed" stopped being true when
    // capture began following the device's WAV preference — a take now plays
    // back in whatever format it was actually recorded in.
    "editor.timeline.qualityOriginalTooltip":
      "Original quality (WAV) for generated voices — larger downloads. Recorded takes always play in the format they were captured.",
    "editor.timeline.qualityCompressedTooltip":
      "Compressed playback (smaller, faster). Toggle for original-quality generated voices.",
    "editor.timeline.snapToggleAria": "Snap to neighboring edges",
    "editor.timeline.snapOnTooltip": "Snapping on — edges magnet to neighbors",
    "editor.timeline.snapOffTooltip": "Snapping off",
    "editor.timeline.videoHiddenNote":
      "The linked video is hidden here — it plays on the original recording's timing, which this view no longer follows.",
    "editor.timeline.outputLatencyNote":
      "Bluetooth audio arrives a moment after the app sends it. The playhead is adjusted for the delay it can measure, but a little is unmeasurable — trust your ears over the line for fine timing.",
    "editor.timeline.outputDeviceChangedToast": "Playback paused — the audio output changed.",
    // AQU-646 stage 2: the track colour palette. Each names a PAIR — the tone
    // recorded takes are drawn in, and the near neighbour generated voices get
    // — so the label is the family, not either exact hue.
    // Sam's own seven (2026-08-27), named as his spec names them.
    "editor.timeline.colorCyan": "Cyan",
    "editor.timeline.colorAzure": "Azure",
    "editor.timeline.colorViolet": "Violet",
    "editor.timeline.colorMagenta": "Magenta",
    "editor.timeline.colorAmber": "Amber",
    "editor.timeline.colorGreen": "Green",
    "editor.timeline.measureNote": plural({
      one: "{count} recording has no measured length — its chip is drawn at a guessed width.",
      other:
        "{count} recordings have no measured length — their chips are drawn at guessed widths.",
    }),
    "editor.timeline.measureNow": "Measure now",
    "editor.timeline.measureTooltip":
      "Download each recording, measure its real length, and fix the chips. Nothing else about the takes changes.",
    "editor.timeline.measureOfflineTooltip":
      "Measuring downloads each recording — connect to the internet first.",
    "editor.timeline.measureBusyTooltip": "Another batch is running — wait for it to finish.",
    "editor.timeline.measureDismiss": "Dismiss for now",

    // — Section-scoped transcription (AQU-928) ————————————————————
    "editor.timeline.transcribeSelectionCount": plural({
      one: "{count} section selected",
      other: "{count} sections selected",
    }),
    "editor.timeline.transcribeSelectionActionOne": "Transcribe section",
    "editor.timeline.transcribeSelectionActionMany": plural({
      one: "Transcribe {count} section",
      other: "Transcribe {count} sections",
    }),
    "editor.timeline.transcribeSelectionRecordings": plural({
      one: "{count} recording",
      other: "{count} recordings",
    }),
    "editor.timeline.transcribeSelectionClear": "Clear selection",
    "editor.timeline.transcribeSelectionHint":
      "Ctrl/⌘-click or Shift-click chips to select more sections.",
    "editor.timeline.transcribeSelectionTooltip":
      "Run speech-to-text on the selected sections' audio only — the rest of the file is left alone.",
    "editor.timeline.transcribeSelectionSharedTooltip": plural({
      one: "Some of these sections are performed by the same heard line, so this runs {count} transcription covering all of them.",
      other: "Some of these sections are performed by the same heard line, so this runs {count} transcriptions covering all of them.",
    }),
    "editor.timeline.transcribeSelectionNoAudioTooltip":
      "None of the selected sections has audio to transcribe.",
    "editor.timeline.transcribeSelectionBusyTooltip":
      "Another audio batch is running — wait for it to finish.",

    // AQU-646: the video pane, the pairing overlay, and the small lane
    // affordances. Keyed 2026-08-20 — these surfaces were authored inline
    // while the dubbing workflow was being designed.
    "editor.timeline.videoPaneTitle": "Video",
    // AQU-1119: the section heading over the dialogue table, opposite the
    // Video header. It says "Text" and not "Source text" because SOURCE and
    // TARGET are the two columns underneath it — the section holds both, and
    // naming it after one of its columns read as a mislabel. Deliberately not
    // the track row's name: `TRACK_KIND_LABELS` still calls those "Source
    // text" / "Target text", which is right, because a track IS one side.
    "editor.timeline.textPaneTitle": "Text",
    "editor.timeline.videoPaneLinked": "Linked video",
    "editor.timeline.videoPaneStart": "Click to start the picture",
    "editor.timeline.videoPanePicture": "picture",
    "editor.timeline.videoPaneBar": "bar",
    "editor.timeline.videoPaneErrorTitle": "This video could not be loaded",
    // No `videoPaneRetry` or `videoPaneChangeVideo` here: the pane's two
    // buttons reuse `common.retry` and `editor.timeline.changeVideo`. Minting a
    // second key for a word the catalog already carries gives a translator two
    // things to keep consistent for no gain — and rewording the English to dodge
    // the duplicate scan is the mistake this catalog already made once and
    // reverted (see no-duplicates.test.ts on commit 6b2977f5f).
    "editor.timeline.subtitlePosition": "Subtitle position",
    "editor.timeline.subtitleText": "Subtitle text",
    "editor.timeline.audioTrackSearchPlaceholder": "Search languages…",
    "editor.timeline.audioTrackSearchAria": "Search languages",
    "editor.timeline.audioTrackNoMatch": "No language by that name.",
    "editor.timeline.audioTrackFilmAudio": "Film audio",
    "editor.timeline.pairingFromThis": "Pairing from this one — click a line on the other row",
    "editor.timeline.pairedClickToUnpair": "Paired · click to unpair",
    "editor.timeline.clickToPair": "Click to pair with the selected chip",
    // AQU-646: the confirmation before a pairing is made or broken.
    "editor.timeline.linkConfirmTitle": "Pair these two lines?",
    "editor.timeline.linkConfirmDescription":
      "The heard line's recording will belong to this subtitle. Pairings decide which line a performance is attributed to, so it is worth checking you clicked the two you meant.",
    "editor.timeline.unlinkConfirmTitle": "Break this pairing?",
    "editor.timeline.unlinkConfirmDescription":
      "These two stop being a pair. Any recording on the heard line stays where it is, but it will no longer be attributed to this subtitle.",
    // No `linkConfirmSubtitleSide` — the row label reuses
    // `editor.timeline.chipHeadingSubtitle`, which is already this same word for
    // this same row. A twin would be a second thing to keep in step.
    "editor.timeline.linkConfirmHeardSide": "Heard",
    "editor.timeline.linkConfirmGo": "Pair them",
    "editor.timeline.unlinkConfirmGo": "Break the pairing",
    "editor.timeline.noSpeechHere": "No speech here · {seconds}s",
    "editor.timeline.takeLoading": "Loading this clip's audio…",
    "editor.timeline.takeSaving": "Saving — kept safe on this device until it syncs",
    "editor.timeline.recordOverStretch": "Record over this stretch",
    "editor.timeline.removeThisLine": "Remove this line",
    "editor.timeline.addLineHere": "Add a line here",

    // The link-video dialog and the chip strip's field labels.
    "editor.timeline.linkVideoTitleChange": "Change the linked video",
    "editor.timeline.linkVideoTitleNew": "Link a video",
    "editor.timeline.linkVideoDescription":
      "Paste the address of the video this file was dubbed from. It plays beside the text, muted and in step with the audio — the recording you hear is always the one on the timeline.",
    "editor.timeline.linkVideoAddressLabel": "Video address",
    "editor.timeline.linkVideoInvalid":
      "That doesn't look like a web address. It should start with http:// or https://.",
    "editor.timeline.linkVideoClear": "Clear video",
    "editor.timeline.chipHeadingDialogue": "Dialogue",
    "editor.timeline.chipHeadingSubtitle": "Subtitle",
    "editor.timeline.chipSpeaker": "Speaker",
    "editor.timeline.chipCamera": "Camera",

    // The toolbar, the gutter and the Sources/Check menu state badges.
    "editor.timeline.sortableTrackRole": "sortable track",
    "editor.timeline.gutterReorderAria":
      "Timeline tracks — drag a name, or press Alt with the arrow keys, to reorder",
    // AQU-646 stage 2: folders in the track gutter. (Stage 4b retired the
    // "N tracks" sublabel — a slim folder heading has no room for a second
    // line, and the summary band says what is inside better.)
    "editor.timeline.gutterCollapseAria": "Narrow the track names",
    "editor.timeline.gutterExpandAria": "Show the track names",
    // AQU-1119: collapsing a whole section of the media lens down to a rail of
    // one icon, and bringing it back. Each pair is one button in two states —
    // the collapse control lives in the section's own header, the expand
    // control IS the rail.
    "editor.timeline.collapseVideoAria": "Hide the video",
    "editor.timeline.expandVideoAria": "Show the video",
    "editor.timeline.collapseTimelineAria": "Hide the timeline",
    "editor.timeline.expandTimelineAria": "Show the timeline",
    "editor.timeline.collapseTextAria": "Hide the text",
    "editor.timeline.expandTextAria": "Show the text",
    // AQU-1119: the other control beside each body section's chevron. Where
    // the chevron folds ITS OWN section, this one folds the others so this
    // section has the lens to itself — one button in two states.
    "editor.timeline.fullscreenVideoAria": "Fill the lens with the video",
    "editor.timeline.restoreVideoAria": "Put the video back in its column",
    "editor.timeline.fullscreenTextAria": "Fill the lens with the text",
    "editor.timeline.restoreTextAria": "Put the text back in its column",
    "editor.timeline.folderExpandAria": "Show the tracks in {name}",
    "editor.timeline.folderCollapseAria": "Hide the tracks in {name}",
    "editor.timeline.trackMenuAria": "Track options for {name}",
    "editor.timeline.trackRename": "Rename",
    "editor.timeline.trackColor": "Colour",
    // AQU-646 stage 7: one hue per track, picked from six swatches, so the
    // whole vocabulary of axes, weights and previews is gone with the picker.
    // A colour name and a count is all this menu says now.
    // AQU-646 stage 6H rev 2: the colour PICKER's own words. Temporary by
    // design — Sam is using it to craft a palette, and when the palette exists
    // this dialog and these four keys go with it.
    "editor.timeline.trackColorCount": plural({
      one: "Colour {count} track",
      other: "Colour {count} tracks",
    }),
    "editor.timeline.trackNewFolderFrom": "New folder from this track",
    "editor.timeline.trackNewFolderFromCount": plural({
      one: "New folder from {count} track",
      other: "New folder from {count} tracks",
    }),
    "editor.timeline.trackLeaveFolder": "Take out of folder",
    "editor.timeline.trackLeaveFolderCount": plural({
      one: "Take {count} track out of its folder",
      other: "Take {count} tracks out of their folders",
    }),
    "editor.timeline.trackDelete": "Delete track",
    "editor.timeline.trackDeleteFolder": "Delete folder",
    "editor.timeline.trackDeleteCount": plural({
      one: "Delete {count} track",
      other: "Delete {count} tracks",
    }),
    "editor.timeline.trackAdd": "Add track",
    "editor.timeline.trackAddTrack": "Audio track",
    "editor.timeline.trackAddFolder": "Folder",
    // "Folder" → editor.timeline.trackAddFolder (identical text)
    // AQU-646 stage 6J: the automatic name is DATA, not copy, so it is built in
    // code now — see `nextTrackName`. It has to be stable across locales: a
    // track called "Track 2" is stored under that name and read back by
    // everyone on the project, whatever language each of them is working in.
    // The add-track dialog.
    "editor.timeline.addTrackTitle": "Add an audio track",
    // "Name" → common.name (identical text)
    "editor.timeline.addTrackAlignLabel": "Line it up with",
    "editor.timeline.addTrackAlignHint":
      "The new track's recordings sit against this track's lines. It can't be changed afterwards.",
    // "Add track" → editor.timeline.trackAdd (identical text)
    // The delete confirmation.
    "editor.timeline.deleteTrackTitle": "Delete {name}?",
    "editor.timeline.deleteTracksTitle": plural({
      one: "Delete {count} track?",
      other: "Delete {count} tracks?",
    }),
    "editor.timeline.deleteTrackEmpty": "This track has no recordings on it.",
    "editor.timeline.deleteTrackTakes": plural({
      one: "{count} recording on this track will be deleted with it.",
      other: "{count} recordings on this track will be deleted with it.",
    }),
    "editor.timeline.deleteFolderMembers": plural({
      one: "The {count} track inside it will be moved out, not deleted.",
      other: "The {count} tracks inside it will be moved out, not deleted.",
    }),
    // "Delete" → common.delete (identical text)
    "editor.timeline.rowsShorterAria": "Shorter rows",
    "editor.timeline.rowsShorterTooltip": "Shorter rows — fit more tracks on screen (⌘ + scroll)",
    "editor.timeline.rowsTallerAria": "Taller rows",
    "editor.timeline.rowsTallerTooltip": "Taller rows (⌘ + scroll)",
    "editor.timeline.timingsUnlocked": "Timings unlocked",
    "editor.timeline.pairingsFailed": "The pairings couldn't be loaded — what's shown may be incomplete.",
    "editor.timeline.neverPaired":
      'These cues have never been paired with the subtitles — re-import the audio VTT and tick "work out the subtitle pairings".',
    "editor.timeline.badgePairing": "pairing…",
    // No `badgeSaving` — the Sources row's spinner badge reuses `common.saving`.
    // It differed only in case, and a case-only split is pure duplicate work:
    // three of the four target locales have no letter case at all. The badge
    // capitalises as a result, which is the cost of not having a twin.
    "editor.timeline.badgeLinked": "linked",
    "editor.timeline.badgeNotLinked": "not linked",
    "editor.timeline.badgeNotImported": "not imported",
    "editor.timeline.badgeImportedCount": "{count} imported",

    // — Row hover controls + assurance panel (editing table) ——————
    "editor.row.removeLine": "Remove this line",
    // AQU-1068 round 3: WHY a row cannot take an action. A closed set with
    // one sentence shape — the same string serves the disabled button's tooltip
    // and the disabled menu item's second line, so the two surfaces cannot
    // drift. Shown instead of hiding the control, because an absent button
    // cannot distinguish "not applicable here" from "this feature is broken".
    //
    // The media cause carries TWO strings because the question differs by
    // action: hovering a dead INSERT asks about a new cell, not about the row
    // it happens to sit beside, so describing the row there answered the
    // wrong question (round 4, Sam).
    "editor.row.noRoomReason": "There\u2019s no room here to fit a line.",
    "editor.row.mediaInsertReason": "Cells can\u2019t be added to imported audio.",
    "editor.row.mediaRemoveReason":
      "This row is a piece of the original recording, so it can\u2019t be removed.",
    "editor.row.idmlReason":
      "IDML files keep their original layout, so cells can\u2019t be added or removed.",
    "editor.row.maintainerOnlyReason": "Only a maintainer can remove an imported line.",
    // AQU-1068: the removal confirmation. The body is ASSEMBLED from the
    // fragments below — a resolved-and-concatenated list, the house idiom (see
    // nav.workspaceActions.moreAfterThis) rather than a nested placeholder,
    // because which clauses appear depends on what the cell actually carries.
    "editor.removeCell.title": "Remove this cell?",
    "editor.removeCell.confirmLabel": "Remove it",
    "editor.removeCell.lead": "This removes the cell and everything on it:",
    "editor.removeCell.leadNothing":
      "This removes the cell. There is nothing else attached to it.",
    "editor.removeCell.translations": plural({
      one: "its translation in {count} language",
      other: "its translations in {count} languages",
    }),
    "editor.removeCell.takes": plural({
      one: "{count} recording",
      other: "{count} recordings",
    }),
    "editor.removeCell.comments": plural({
      one: "{count} comment",
      other: "{count} comments",
    }),
    "editor.removeCell.validations": plural({
      one: "{count} validation",
      other: "{count} validations",
    }),
    "editor.removeCell.sharedTakeWarning":
      "One of those recordings also performs other lines.",
    "editor.removeCell.milestoneWarning":
      "This cell carries the \u201c{label}\u201d heading, which will disappear from chapter navigation.",
    "editor.removeCell.permanent": "This cannot be undone.",
    // AQU-1068: an insert/removal applies instantly and is corrected if the
    // server refuses it — the row comes back (or goes away again) on its own,
    // so the copy explains the reversal rather than asking for an action.
    "editor.addCell.failedToast": "That cell couldn\u2019t be added, so it has been removed again.",
    "editor.removeCell.failedToast": "That cell couldn\u2019t be removed, so it has been put back.",
    "editor.addCell.forbiddenToast": "You don\u2019t have permission to add cells here, so it has been removed again.",
    "editor.removeCell.forbiddenToast": "You don\u2019t have permission to remove cells here, so it has been put back.",
    "editor.removeCell.notYetSavedToast": "That cell is still being saved \u2014 try removing it again in a moment.",
    "editor.row.addLine": "Add a line",
    "editor.row.insertAbove": "Insert above",
    "editor.row.insertBelow": "Insert below",
    "editor.row.addLineAbove": "Add a line above",
    "editor.row.addLineBelow": "Add a line below",
    "editor.row.draftSearching": "{cellRef}: Looking up similar examples…",
    "editor.row.draftGenerating": "{cellRef}: Generating translation…",
    "editor.row.draftPreviewReady": "{cellRef}: Translation preview available",
    "editor.assurance.validatedWithInfractions":
      "Validation is authoritative, but automatic checks still found an issue.",
    "editor.assurance.validatedClean":
      "Human review is complete. Automatic evidence remains available as context.",
    "editor.assurance.lowerSupport":
      "Lower local support — review terminology and context closely.",
    "editor.assurance.betterSupport":
      "Better local support — human review is still required.",

    // AQU-646, keyed 2026-08-20: the audio-VTT import dialog, the character-
    // sheet import dialog, the character-check drawer and the pairing drawer.
    // A sentence that was split around an interpolated value in JSX is ONE key
    // here — the fragments cannot be translated, because word order moves
    // between languages. The `{placeholder}` names say what each hole holds.

    // — Import audio VTT dialog ————————————————————————————————
    "editor.timeline.audioVttTitleReplace": "Replace the audio VTT",
    "editor.timeline.audioVttTitleNew": "Import an audio VTT",
    "editor.timeline.audioVttDescription":
      "The cues become a read-only Source audio track on this file's timeline — " +
      "the transcript of what is said in the film, on the film's own timings. The " +
      "dialogue table below is untouched: no rows are added to \"{fileName}\", and " +
      "nothing here is translated or exported.",
    "editor.timeline.audioVttDescriptionReplacing":
      "The audio track this file has now will be replaced.",
    "editor.timeline.audioVttCueSummary": "{count} cues, {span}",
    "editor.timeline.audioVttRepairedShortForm":
      "{count} short-form timestamps read as minutes and seconds.",
    "editor.timeline.audioVttStrippedTags": "Formatting removed from {count} cues.",
    "editor.timeline.audioVttDroppedCues":
      "{count} lines carried no usable text and were skipped.",
    "editor.timeline.audioVttChoose": "Choose audio VTT",
    "editor.timeline.audioVttPickHint":
      "The episode's audio VTT — usually the one marked AUDIO_ONLY.",
    "editor.timeline.audioVttTimebaseFyi":
      "The timings will be adjusted slightly to line up with \"{fileName}\".",
    "editor.timeline.audioVttUnmeasurableFyi":
      "The timings couldn't be checked against the subtitles — importing the file as delivered.",
    "editor.timeline.audioVttReconcileNoop":
      "These are the {count} cues this file already has, on the same timings — " +
      "there is nothing to update.",
    "editor.timeline.audioVttKeptOfTotal": "{kept} of {total} cues",
    "editor.timeline.audioVttReconcileKept":
      "{kept} are the ones already here and keep everything attached to them",
    "editor.timeline.audioVttKeptIncluding": "— including {takes}",
    "editor.timeline.audioVttRecordingCount": plural({
      one: "{count} recording",
      other: "{count} recordings",
    }),
    "editor.timeline.audioVttRetimeShift": "{count} shift by up to {seconds} seconds",
    "editor.timeline.audioVttCreates": plural({
      one: "{count} new cue will be added.",
      other: "{count} new cues will be added.",
    }),
    // The `one` form reads "1 cue are gone" — that is the English this dialog
    // has always rendered (the component wrote "are" unconditionally and only
    // toggled the noun's "s"), and moving copy into the catalog is not the
    // place to change what a user sees. Flagged for the copy owner.
    "editor.timeline.audioVttDeletes": plural({
      one: "{count} cue is gone from this file and will be removed.",
      other: "{count} cues are gone from this file and will be removed.",
    }),
    "editor.timeline.audioVttOrphanLead": plural({
      one: "{count} recording sits on a cue that is going away",
      other: "{count} recordings sit on a cue that is going away",
    }),
    "editor.timeline.audioVttOrphanWarning":
      "{lead} and will no longer be reachable. The audio itself is kept, but " +
      "nothing in the app would show it.",
    "editor.timeline.audioVttRemoveLead":
      "Take the Source audio track off \"{fileName}\"? The {count} cues and every " +
      "subtitle pairing go with it.",
    "editor.timeline.audioVttRemoveTakesLead": plural({
      one: "{count} recording sits on those cues",
      other: "{count} recordings sit on those cues",
    }),
    "editor.timeline.audioVttRemoveTakes":
      "{lead} and would no longer be reachable — the audio itself is kept, but " +
      "nothing in the app would show it.",
    "editor.timeline.audioVttRemoveRestore":
      "The track goes to Recently deleted, so a project lead can put it back — or " +
      "you can import an audio VTT again afterwards.",
    "editor.timeline.audioVttRemoveGo": "Remove the cues",
    "editor.timeline.audioVttRemove": "Remove audio cues",
    "editor.timeline.audioVttImport": "Import cues",
    "editor.timeline.audioVttNothingToUpdate": "Nothing to update",
    "editor.timeline.audioVttUpdateCues": "Update {count} cues",
    "editor.timeline.audioVttImportCues": "Import {count} cues",
    "editor.timeline.audioVttNoCues":
      "This doesn't look like an audio VTT — no timed cues found.",
    "editor.timeline.importFileEmpty": "That file is empty.",
    "editor.timeline.importTooLargeText":
      "\"{fileName}\" is larger than the 10 MB limit for text imports.",
    // One key, three call sites: the answer to "are you sure?" is the same
    // sentence in the audio-VTT removal and in both character clears.
    "editor.timeline.keepThem": "Keep them",

    // — Import characters dialog ——————————————————————————————
    "editor.timeline.charactersTitle": "Characters",
    "editor.timeline.charactersImportTitle": "Import characters",
    "editor.timeline.charactersSubtitleLines": "{count} subtitle lines",
    "editor.timeline.charactersHeardLines": "{count} heard lines",
    "editor.timeline.charactersBothSides": "{subtitle} and {audio}",
    "editor.timeline.charactersImportedSummary":
      "{summary} carry a character. Import a sheet to replace a side, or clear one " +
      "below.",
    "editor.timeline.charactersImportHint":
      "A spreadsheet with one row per line of \"{fileName}\", saying who speaks it " +
      "and whether the camera is on them. Rows are matched to lines by their " +
      "timestamps.",
    "editor.timeline.charactersSheet": "Sheet",
    "editor.timeline.charactersNoColumn":
      "No character column found in this sheet. Expected a column named something " +
      "like \"Character Label\", \"Cast\" or \"Speaker\".",
    "editor.timeline.charactersSubtitleSheet": "subtitle character sheet",
    "editor.timeline.charactersAudioSheet": "audio character sheet",
    "editor.timeline.charactersWrongKindAudio":
      "This looks like the {sheet}, not the audio one — its rows line up with the " +
      "subtitles instead. Use the other button and it will import fine.",
    "editor.timeline.charactersWrongKindSubtitle":
      "This looks like the {sheet}, not the subtitle one — its rows line up with " +
      "the heard lines instead. Use the other button and it will import fine.",
    "editor.timeline.charactersMismatchLeadAudio":
      "{count} of this sheet's rows match no heard line in \"{fileName}\"",
    "editor.timeline.charactersMismatchLeadSubtitle":
      "{count} of this sheet's rows match no line in \"{fileName}\"",
    "editor.timeline.charactersMismatch":
      "{lead} — starting at row {row}. That normally means the spreadsheet belongs " +
      "to a different episode. Nothing has been changed.",
    "editor.timeline.charactersAssignedLeadAudio": "{count} heard lines get a character",
    "editor.timeline.charactersAssignedLeadSubtitle": "{count} lines get a character",
    "editor.timeline.charactersAssignedSummary":
      "{lead}, {people} people in all. Camera state comes across with them.",
    "editor.timeline.charactersBlankRows":
      "{count} rows have no character and are skipped — screen text and the like.",
    "editor.timeline.charactersWithoutRowAudio":
      "{count} heard lines are not in the sheet and keep whatever they have.",
    "editor.timeline.charactersWithoutRowSubtitle":
      "{count} lines are not in the sheet and keep whatever they have.",
    "editor.timeline.charactersFilledByPosition":
      "{count} rows do not quite match their line; the lines either side pin them, " +
      "so they are matched by position.",
    "editor.timeline.charactersCameraDisagreements":
      "In {count} rows the Camera column and the angle written into the name " +
      "disagree. The column wins.",
    "editor.timeline.charactersPickSubtitle": "Subtitle characters",
    "editor.timeline.charactersPickAudio": "Audio characters",
    "editor.timeline.charactersPickHint":
      "One row per line of \"{fileName}\", or per heard line of its audio track. " +
      ".xlsx or .csv.",
    "editor.timeline.charactersAlreadyHave": "{summary} already have a character.",
    "editor.timeline.charactersClearSubtitleTitle": "Clear the characters on the subtitles?",
    "editor.timeline.charactersClearSubtitleBody":
      "{count} lines lose their character name, camera angle and line number. " +
      "Corrections made since the import go too.",
    "editor.timeline.charactersClearSubtitleAlsoAudio":
      "The heard lines read their characters from these, so they go blank as well.",
    "editor.timeline.charactersClearGo": "Clear the characters",
    "editor.timeline.charactersClearAudioTitle": "Clear the characters on the heard lines?",
    "editor.timeline.charactersClearAudioBody":
      "{count} lines lose their character name, camera angle and line number.",
    "editor.timeline.charactersClearAudioToSubtitles":
      "They go back to reading their characters from the subtitles.",
    "editor.timeline.charactersClearAudioNone": "They show no character at all.",
    "editor.timeline.charactersClearSubtitles": "Clear subtitles",
    "editor.timeline.charactersClearHeardLines": "Clear heard lines",
    "editor.timeline.charactersAssignCount": "Assign {count} characters",
    "editor.timeline.charactersAssign": "Assign characters",
    "editor.timeline.charactersNoRows": "That spreadsheet has no rows.",
    "editor.timeline.importTooLargeSheet":
      "\"{fileName}\" is larger than the 10 MB limit for imports.",

    // — Character-check drawer (where the two sheets disagree) ——————
    "editor.timeline.characterCheckSpeakerSettled":
      "Speaker settled — {rejected} was set aside.",
    "editor.timeline.characterCheckCameraSettled":
      "Camera settled — {rejected} was set aside.",
    "editor.timeline.characterCheckSyncing": "Syncing…",
    "editor.timeline.characterCheckSaving": "Saving… {done} of {total}",
    "editor.timeline.characterCheckNothingToCheck": "nothing to check",
    "editor.timeline.characterCheckToCheck": "{count} to check",
    "editor.timeline.characterCheckOneSheet":
      "Both character sheets have to be imported before there is anything to " +
      "check. Each is keyed to one side of the script — one row per subtitle line, " +
      "one per heard line — and comparing them is what turns up a wrong pairing or " +
      "a wrong sheet.",
    "editor.timeline.characterCheckImportSheets": "Import character sheets",
    "editor.timeline.characterCheckNamesTitle": "Who says it · {count}",
    "editor.timeline.characterCheckNamesHint":
      "The sheets name different people. Either the pairing is wrong or one sheet is.",
    "editor.timeline.characterCheckCameraTitle": "Camera · {count}",
    "editor.timeline.characterCheckCameraHint":
      "Same person; the sheets disagree about whether the camera is on them.",
    "editor.timeline.characterCheckAlsoFlag": "Also flag",
    "editor.timeline.characterCheckFlagMixed": "Mixed against on or off",
    "editor.timeline.characterCheckFlagGroup": "Group against on or off",
    "editor.timeline.characterCheckCamerasClear": "Nothing here disagrees about the camera.",
    "editor.timeline.characterCheckBulkConfirm":
      "Use the {side} sheet's camera answer for all {count} lines? Each lands in " +
      "Resolved and can still be flipped one by one.",
    "editor.timeline.characterCheckBulkGo": "Use {side}",
    "editor.timeline.characterCheckBulkAll": "All {count}:",
    "editor.timeline.characterCheckAllAgree":
      "The two sheets agree everywhere they both have something to say.",
    "editor.timeline.characterCheckShared":
      "{count} pairings sit on a subtitle row that covers several heard lines, so " +
      "one name cannot describe them all. Nothing to fix.",
    "editor.timeline.characterCheckResolvedToggle": "Resolved · {count}",
    "editor.timeline.characterCheckResetConfirm":
      "Un-resolve all {count}? Every disagreement returns to the list with both " +
      "answers restored. Nothing is deleted from the sheets.",
    "editor.timeline.characterCheckResetAll": "Un-resolve everything",

    // — Pairing (cue-link) drawer ——————————————————————————————
    "editor.timeline.cueLinkHeard": "heard",
    "editor.timeline.cueLinkLine": "line",
    "editor.timeline.cueLinkPair": "Pair",
    "editor.timeline.cueLinkNotAPair": "Not a pair",
    "editor.timeline.cueLinkTitle": "Pairings",
    "editor.timeline.cueLinkWorking": "working…",
    "editor.timeline.cueLinkNothingToReview": "nothing to review",
    "editor.timeline.cueLinkToReview": "{count} to review",
    "editor.timeline.cueLinkModeNote":
      "Linking is on — click a heard line, then the subtitle it performs.",
    "editor.timeline.cueLinkRepairConfirm":
      "Work out every pairing again from scratch? This discards any pairing you " +
      "fixed by hand.",
    "editor.timeline.cueLinkRepairAll": "Re-pair everything",
    "editor.timeline.cueLinkConfidentTitle": "Almost certainly the same line",
    "editor.timeline.cueLinkConfidentHint":
      "Identical wording, moments apart, in a gap the pairings left open.",
    "editor.timeline.cueLinkCrossScriptCandidatesTitle": "Different writing systems",
    "editor.timeline.cueLinkCrossScriptCandidatesHint":
      "The timings line up, but nothing could compare the words — so this was not " +
      "paired for you.",
    "editor.timeline.cueLinkWeakTitle": "Overlapping, words barely agree",
    "editor.timeline.cueLinkWeakHint":
      "Enough shared wording to notice, not enough to pair on its own.",
    "editor.timeline.cueLinkUncertainTitle": "The only candidate nearby",
    "editor.timeline.cueLinkUncertainHint":
      "Nothing else is unpaired between them, but the words don't agree.",
    "editor.timeline.cueLinkCrossScriptTitle": "Paired on timing alone",
    "editor.timeline.cueLinkCrossScriptHint":
      "Different writing systems, so nothing compared the words.",
    "editor.timeline.cueLinkLowConfidenceTitle": "Paired, but barely",
    "editor.timeline.cueLinkLowConfidenceHint": "Weak wording agreement. Probably fine.",
    "editor.timeline.cueLinkOrphanCues": plural({
      one: "{count} heard line with no subtitle nearby",
      other: "{count} heard lines with no subtitle nearby",
    }),
    "editor.timeline.cueLinkOrphanText": plural({
      one: "{count} line with no speech nearby",
      other: "{count} lines with no speech nearby",
    }),

    // — Per-cell voice panel (audio lens) ————————————————————————
    "editor.voice.volumeLevel": "Volume level",
    "editor.voice.translateFirst": "Translate to voice this line",
    "editor.voice.play": "Play this line",
    "editor.voice.clone": "Clone a voice from this take",
    "editor.voice.voicing": "Voicing…",
    "editor.voice.clickVoiceToGenerate": "Click a voice to generate",
    "editor.voice.choose": "Choose a voice",
    "editor.voice.activeVoice": "Voice: {name}. Choose a voice",

    // — Rich-text editor: formatting bubble, conflict banner, IDML guards ——
    "editor.format.bold": "Bold",
    "editor.format.boldTooltip": "Bold (Cmd+B)",
    "editor.format.italic": "Italic",
    "editor.format.italicTooltip": "Italic (Cmd+I)",
    "editor.format.underline": "Underline",
    "editor.format.underlineTooltip": "Underline (Cmd+U)",
    "editor.format.strikethrough": "Strikethrough",
    "editor.format.code": "Inline code",
    "editor.conflict.changedElsewhere": "This cell changed elsewhere while you were editing.",
    "editor.conflict.discardAndReload": "Discard and reload",
    "editor.footnotes.deletePrompt": "Delete footnote {label}?",
    "editor.anchor.cursorPosition": "Cursor position",
    "editor.idml.structureChanged":
      "This edit changed the protected IDML document structure. Undo it or " +
      "re-import the IDML.",
    "editor.idml.caretOutsideSlot":
      "Place the caret inside an InDesign text slot before adding a line break.",
    "editor.idml.invalidMetadataError":
      "This IDML cell has invalid formatting metadata and must be repaired or re-imported.",
    "editor.idml.missingSourceHtmlError":
      "This IDML cell is missing its protected source HTML and must be re-imported.",
    "editor.idml.plainTextNoAnchorsError":
      "This translated IDML cell has plain text but no formatting anchors. Re-import or " +
      "repair it before editing.",
    "editor.idml.editWouldChangeStructureError":
      "This edit would change the protected IDML document structure.",
    "editor.idml.editWouldChangeFormattingError":
      "This edit would change protected IDML formatting.",

    // — Text-to-speech status badge on a row ————————————————————————
    "editor.tts.translatingBeforeVoicing": "Translating before voicing",
    "editor.tts.loadingVoiceModel": "Loading voice model",
    "editor.tts.loadingVoiceModelPct": "Loading voice model ({percent}%)",
    "editor.tts.loadingPct": "Loading {percent}%",
    "editor.tts.generatingAudio": "Generating audio…",
    "editor.tts.openAudioSetup": "Open audio setup",
    "editor.tts.failedTooltip": "Audio generation failed — click Generate to retry",
    "editor.tts.notVoiced": "Not voiced",
    "editor.tts.audioFailed": "Audio failed",

    // — Validation button, validator popover and its history ——————————
    "editor.validation.notValidatedTooltip": "Not validated — click to validate",
    "editor.validation.outOfScopeTooltip": "Outside your assigned files or lanes",
    "editor.validation.unavailableTooltip": "Validation unavailable",
    "editor.validation.ariaValidated":
      "Validated — {ref}. Click to remove your validation.",
    "editor.validation.ariaValidatedByOthers":
      "Validated by others — {ref}. Click to add your validation.",
    "editor.validation.ariaNotValidated": "Not validated — {ref}. Click to validate.",
    "editor.validation.validatedBy": "Validated by",
    "editor.validation.noActiveValidators": "No active validators",
    "editor.validation.removeYours": "Remove your validation",
    "editor.validation.history": "History",
    "editor.validation.noValidatorsOnState": "No validators on this state",
    "editor.validation.you": "(you)",

    // — Audio validation (AQU-490): the same control, one vote per TAKE ——
    "editor.audioValidation.notValidatedTooltip": "Audio not validated — click to validate",
    "editor.audioValidation.outOfScopeTooltip": "Outside your assigned files",
    "editor.audioValidation.unavailableTooltip": "Audio validation unavailable",
    "editor.audioValidation.ownRecordingTooltip": "You recorded this — someone else must validate it",
    "editor.audioValidation.ariaValidated":
      "Audio validated — {ref}. Click to remove your validation.",
    "editor.audioValidation.ariaPartlyValidated":
      "You have validated {done} of {total} takes — {ref}. Click to validate the rest.",
    "editor.audioValidation.ariaNotValidated": "Audio not validated — {ref}. Click to validate.",
    "editor.audioValidation.ariaNotValidatedByYou": "Audio not validated — {ref}.",
    "editor.audioValidation.ariaOthersValidated": plural({
      one: "Someone else has validated this audio — {ref}. {count} more validator needed.",
      other: "Someone else has validated this audio — {ref}. {count} more validators needed.",
    }),
    "editor.audioValidation.ariaYoursMoreNeeded": plural({
      one: "You have validated this audio — {ref}. {count} more validator needed.",
      other: "You have validated this audio — {ref}. {count} more validators needed.",
    }),
    "editor.audioValidation.takesHeading": "Takes on this line",
    "editor.audioValidation.takeFraction": "{done}/{total}",
    "editor.audioValidation.needsMore": plural({
      one: "{count} more validator needed",
      other: "{count} more validators needed",
    }),
    "editor.audioValidation.noValidators": "Nobody has validated this take",
    "editor.audioValidation.generatedTake": "Generated voice",
    "editor.audioValidation.defaultTrack": "Main",
    "editor.audio.addedTrackTakeHint": "Take on an added track",

    // — Row chrome: numbering, selection, paragraph and timing markers ——
    "editor.row.noTimingAria": "No specific timing — ordered by sequence",
    "editor.row.noTimingBadge": "no timing",
    "editor.row.newParagraph": "New paragraph",
    "editor.row.lineAria": "Line {number}",
    "editor.row.cellAria": "{ref} cell",
    "editor.row.rowFallbackRef": "row {index}",
    "editor.row.editorAria": "{ref} — {state}",
    "editor.row.translationAria": "Translation for {ref}: {source} — {state}",
    "editor.row.selectedTooltip": "Selected. Drag up or down to extend the range.",
    "editor.row.selectTooltip": "Select cell. Drag up or down to select a range.",
    // -- CellPresenceBadges: per-row live-collaborator chips --
    "editor.presence.viewing": "viewing",
    "editor.presence.editing": "editing",
    "editor.presence.typing": "typing…",
    "editor.row.selectedAria": "Selected cell. Drag to extend selection.",
    "editor.row.selectAria": "Select cell. Drag to select a range.",
    "editor.state.empty": "empty",
    "editor.state.selfValidated": "self-validated",

    // — Open-comment indicator on a row ————————————————————————————
    "editor.comments.open": plural({
      one: "{count} open comment",
      other: "{count} open comments",
    }),
    "editor.comments.openAria": plural({
      one: "{count} open comment — open comments",
      other: "{count} open comments — open comments",
    }),

    // — Table header, lane switcher and whole-file empty states ——————
    "editor.column.controls": "Controls",
    "editor.lane.activeAria": "Active translation lane",
    "editor.lane.setTargetLanguage": "Set target language",
    "editor.lane.changeTargetLanguage": "Change target language",
    "editor.lane.changeTargetLanguageItem": "Change target language…",
    "editor.lane.searchPlaceholder": "Search lanes…",
    "editor.lane.searchAriaLabel": "Search lanes",
    "editor.lane.searchEmpty": "No lanes found.",
    "editor.lane.showArchived": "Show archived ({count})",
    "editor.empty.noMediaSegments": "No media segments yet",
    "editor.empty.mediaLayerHint":
      "Import an audio or video file, or record a take, to populate the media layer.",

    // — USFM note chips in the source text ————————————————————————
    "editor.note.footnote": "Footnote",
    "editor.note.endnote": "Endnote",
    "editor.note.crossReference": "Cross reference",
    "editor.note.empty": "(empty)",

    // — Managed-term chips ————————————————————————————————————————
    "editor.term.managed": "Managed term: {term}",

    // — Write failures surfaced on the row ————————————————————————
    "editor.write.saveFailed": "Could not save — please try again",
    "editor.write.saveSourceFailed": "Could not save source edit — please try again",
    "editor.write.sourceEditingClosed":
      "Source editing is no longer available on this project — the source editor " +
      "was closed.",

    // — Source column ——————————————————————————————————————————————
    // AQU-1068 item 5: the source cell's one menu, which replaced the pencil
    // and the hover corner. `editor.source.editText` and the row's insert /
    // remove / reason strings are reused verbatim as its entries.
    "editor.cellMenu.trigger": "Cell actions",
    "editor.cellMenu.editTimestamps": "Edit timestamps",
    "editor.cellMenu.timingLocked": "Timing is locked for this project.",
    "editor.cellMenu.unlockInSettings": "Unlock timing in project settings",
    "editor.cellMenu.startLabel": "Start time",
    "editor.cellMenu.endLabel": "End time",
    "editor.cellMenu.betweenHint": "Lines either side start {from} and {to}",
    "editor.cellMenu.afterHint": "The line before starts {from}",
    "editor.cellMenu.beforeHint": "The line after starts {to}",
    "editor.cellMenu.badTime": "Type a time like 1:02.5",
    "editor.cellMenu.invertedTimes": "The end has to come after the start.",
    "editor.cellMenu.startsBeforePrevious":
      "This would put the line before the one above it. Its start has to stay after {from}.",
    "editor.cellMenu.startsAfterNext":
      "This would put the line after the one below it. Its start has to stay before {to}.",
    "editor.cellMenu.saveTimestamps": "Save",
    "editor.source.textAria": "Source text",
    "editor.source.editText": "Edit source text",
    "editor.source.doneEditing": "Done editing source",
    "editor.source.locked": "Source is locked",
    "editor.source.placeholder": "Source text…",
    "editor.source.formattingBadge": "formatting",
    "editor.source.idmlProtected":
      "IDML source text is protected because changing it would invalidate the " +
      "original package locator.",
    "editor.source.formattingLossTooltip":
      "Source has inline formatting that the target does not preserve. Formatting " +
      "will be lost on export.",

    // — AI drafting on the target side ————————————————————————————
    "editor.ai.draftBadge": "AI draft · review required",
    "editor.ai.draftBadgeAria": "AI draft — individual human review required",
    "editor.ai.lookingUpExamples": "Looking up similar examples…",
    "editor.ai.generatingTranslation": "Generating translation…",
    "editor.ai.signInForTranslations": "Sign in for AI translations",
    "editor.ai.setUpToEnable": "Set up AI to enable",
    "editor.ai.serviceUnavailable": "AI service unavailable — try again shortly",
    "editor.ai.generating": "Generating…",
    "editor.ai.translateWithAi": "Translate with AI",
    "editor.ai.draftParagraph": "Draft paragraph ({count} cells)",
    "editor.ai.regenerate": "Regenerate — another AI variation",

    // — Remaining action-rail tooltips ————————————————————————————
    "editor.audio.play": "Play audio",
    "editor.cue.playFrom": "Play from this cue",

    // — Expansion tab: retrieval support ——————————————————————————
    "editor.expansion.retrievalSupport": "Retrieval support",
    "editor.expansion.endorsements": plural({
      one: "{count} endorsement · support {percent}%",
      other: "{count} endorsements · support {percent}%",
    }),
    "editor.expansion.lowerSupport":
      "Lower retrieval support — review terminology and context closely.",
    "editor.expansion.betterSupport":
      "Better retrieval support — human review is still required.",

    // — Expansion tab: back-translation ————————————————————————————
    "editor.bt.label": "Back-translation",
    "editor.bt.explainTooltip":
      "A literal back-translation into your source language, for comparing with " +
      "the original. AI can misread, and the statistical gloss tracks your corpus " +
      "— treat both as checks, not proof.",
    "editor.bt.needsAiTooltip":
      "Sign in or add an AI model in project settings to generate back-translations",
    "editor.bt.regenerateTooltip": "Regenerate back-translation",
    "editor.bt.regenerateAria": "Regenerate the back-translation",
    "editor.bt.editTooltip": "Edit the back-translation",
    "editor.bt.contributorRequired": "Contributor+ required to edit back-translations",
    "editor.bt.failed": "Back-translation failed",
    "editor.bt.translateFirst":
      "Translate this cell first to generate a back-translation.",
    "editor.bt.staleWarning":
      "This back-translation describes an earlier version of the translation",
    "editor.bt.emptyPitch":
      "Reverse-translate this cell literally, then compare the result with the source.",
    "editor.bt.readingItBack": "Generating back-translation…",
    "editor.bt.readItBack": "Generate back-translation",
    "editor.bt.needsAiHint":
      "Sign in or add an AI model in project settings to generate a back-translation.",
    "editor.bt.contributorCanGenerate":
      "A contributor can generate a back-translation.",
    "editor.bt.originAi": "AI back-translation",
    "editor.bt.originCorrected": "Hand-corrected",
    "editor.bt.freshLabel": "Matches this translation",
    "editor.bt.pairsDisagree": "Statistical gloss differs",
    "editor.bt.pairsLive":
      "Statistical gloss from project pairs — updates as you translate",
    "editor.bt.usePairsInstead": "Use this gloss",
    "editor.bt.statisticalGloss": "Statistical gloss",
    "editor.bt.statisticalGlossSub": "— word-for-word, from this project's own pairs",
    "editor.bt.glossNotEnoughPairs":
      "Not enough translated pairs in this project to build a gloss yet.",
    "editor.bt.glossDisclaimer":
      "Built statistically from this project's translated pairs — no AI involved. " +
      "It's only as good as the corpus so far: expect rough, literal, sometimes " +
      "wrong word choices. Use it as a hint, not a reading.",
    "editor.bt.alignment": "Alignment",
    "editor.bt.alignmentSub": "— word-level source/target view",
    "editor.transcript.editTooltip": "Correct the transcript",
    "editor.transcript.editAria": "Correct the transcript",
    "editor.transcript.contributorRequired": "Contributor+ required to edit transcripts",

    // — Expansion tab: recording ————————————————————————————————
    "editor.expansion.recording": "Recording",
    "editor.voice.synthesizeWith": "Synthesize with {name}",
    "editor.voice.dropToSynthesize": "Drop to synthesize",
    "editor.audio.reRecordShort": "Re-record",
    "editor.cell.transcribeShort": "Transcribe",
    "editor.voice.aiGeneratedHint":
      "AI generated voice. Drag a voice from the toolbar to regenerate, or:",
    "editor.audio.recordOver": "Record over",
    "editor.audio.noAudioYet":
      "No audio yet. Record below, or drag a voice onto this cell from the " +
      "toolbar above.",
    "editor.audio.recordShort": "Record",
    "editor.audio.heardLineAt": "Heard line · {range}",
    "editor.audio.heardLineShared": "Also performs {count} other subtitle lines — re-recording changes those too.",

    // — Expansion tabs: issues and metadata ————————————————————————
    "editor.expansion.issues": "Issues",
    "editor.expansion.metadata": "Metadata",
    "editor.metadata.showOnCells": "Show {key} on cells",
    "editor.issues.none": "No translation rule issues on this cell.",
    "editor.issues.waived": "Waived",

    // — Draft-a-whole-paragraph confirm dialog ——————————————————————
    "editor.paragraph.confirmTitle": "Draft this paragraph?",
    "editor.paragraph.confirmAll":
      "Draft this paragraph? {total} cells will be drafted as one unit.",
    "editor.paragraph.confirmPartial":
      "Draft this paragraph? {draftable} of {total} cells will be drafted; " +
      "already-validated cells are kept as-is.",
    "editor.paragraph.confirmAction": "Draft paragraph",

    // — Workspace navigation titles (AQU-914) — the back/forward history
    // popover and the workspace tab breadcrumb. Not editor-table strings, but
    // this pass's new keys are scoped to this namespace file; a dedicated
    // nav-history namespace is a reasonable follow-up once that ownership is
    // free (see src/lib/navigation/deriveTitle.ts).
    "editor.navTitle.home": "Home",
    "editor.navTitle.overview": "Overview",
    "editor.navTitle.adminConsole": "Admin console",
    "editor.navTitle.sharedWithYou": "Shared with you",
    "editor.navTitle.archivedProjects": "Archived projects",
    "editor.navTitle.assignedToMe": "Assigned to me",
    "editor.navTitle.organizationSettings": "Organization settings",
    "editor.navTitle.membersMatrix": "Members matrix",
    "editor.navTitle.members": "Members",
    "editor.navTitle.team": "Team",
    "editor.navTitle.teams": "Teams",
    "editor.navTitle.projectOverview": "Project overview",
    "editor.navTitle.editor": "Editor",
    "editor.navTitle.projectSettings": "Project settings",
    "editor.navTitle.checksAndRules": "Checks & rules",
    "editor.navTitle.voice": "Voice",
    "editor.navTitle.projectMembers": "Project members",

    // — Per-file sync status chip (WS connection to the sync-worker) ————
    "editor.sync.trafficHistory": "Upload and download activity over the past five minutes",
    "editor.sync.replyHistory": "Observed server replies over the past five minutes",
    "editor.sync.fiveMinutesAgo": "5 min ago",
    "editor.sync.historyHelp": "5-second averages. Gaps mean no reply was measured. History builds while this tab is open.",
    "editor.sync.activityNow": "Now",
    "editor.sync.pastFiveMinutes": "Past 5 min",
    "editor.sync.serverReply": "Server reply",
    "editor.sync.transferredTotal": "{amount} total",
    "editor.sync.averageReply": "{time} avg",
    "editor.sync.slowestReply": "Slowest reply: {time}",
    "editor.sync.replyJustNow": "Last reply just now",
    "editor.sync.requestCount": plural({ one: "{count} request", other: "{count} requests" }),
    "editor.sync.failureCount": plural({ one: "{count} failed", other: "{count} failed" }),
    "editor.sync.replySecondsAgo": plural({ one: "Last reply {count}s ago", other: "Last reply {count}s ago" }),
    "editor.sync.replyMinutesAgo": plural({ one: "Last reply {count}m ago", other: "Last reply {count}m ago" }),
    "editor.sync.connection": "Connection",
    "editor.sync.upload": "Upload",
    "editor.sync.download": "Download",
    "editor.sync.responseTime": "Response time",
    "editor.sync.ping": "Ping",
    "editor.sync.connectionDetails": "Connection details",
    "editor.sync.showDetails": "Show connection details",
    "editor.sync.qualityGood": "Good",
    "editor.sync.qualityFair": "OK",
    "editor.sync.qualitySlow": "Slow",
    "editor.sync.noActivity": "Idle",
    "editor.sync.waitingForActivity": "Waiting for activity",
    "editor.sync.activityHelp": "Sync traffic in this tab, not your internet speed. Small transfers are normal. Reply times include server work.",
    "editor.sync.live": "Live",
    "editor.sync.liveTooltip": "Live — all changes are saved to the server and syncing across devices",
    "editor.sync.syncing": "Syncing",
    "editor.sync.syncingTooltip": "Syncing — some changes are still being sent to the server",
    "editor.sync.retrying": "Retrying",
    "editor.sync.retryingTooltip":
      "Retrying — the last attempt to send your changes failed. Edits are saved locally and will be retried.",
    "editor.sync.reconnecting": "Reconnecting",
    "editor.sync.reconnectingTooltip":
      "Reconnecting — the live connection dropped. Edits are saved locally; changes from others may be delayed.",
    "editor.sync.connecting": "Connecting",
    "editor.sync.connectingTooltip": "Connecting to the sync server…",
    "editor.sync.offline": "Offline",
    "editor.sync.offlineTooltip": "Offline — changes are saved locally and will sync when reconnected",
    "editor.sync.paused": "Paused",
    "editor.sync.pausedTooltip": "Sync paused while the tab is hidden — will resume when you return",
    "editor.sync.noFileOpen": "No file open",
    "editor.sync.noFileOpenTooltip": "Open a file to start editing and syncing",

    // — Outbox (unsynced local writes) status chip in the status bar ————
    // "N failed" is nav.outbox.failedCount (reused — same popover this chip
    // opens already uses it for the identical count).
    "editor.outbox.backlogLabel": "Sync backlog",
    "editor.outbox.queuedLabel": plural({ other: "Queued {count}" }),
    "editor.outbox.syncedLabel": "Synced",
    "editor.outbox.failedTooltip": plural({
      one: "{count} change could not be synced after repeated attempts. Click to inspect.",
      other: "{count} changes could not be synced after repeated attempts. Click to inspect.",
    }),
    "editor.outbox.backlogTooltip":
      "Could not sync changes to the server. Edits are still saved locally. Click to review.",
    "editor.outbox.queuedTooltip": plural({
      one: "{count} change queued for server sync. Click to review.",
      other: "{count} changes queued for server sync. Click to review.",
    }),
    "editor.outbox.syncedTooltip": "All changes synced. Click to review pending changes.",
  },
  context: {
    _context: {
      description:
        "The translation editor — the source/target editing table and everything " +
        "attached to a row: the action rail, the expansion tabs, the audio and " +
        "timeline lenses, footnotes, and the reference sidebars. Strings here are " +
        "inline controls, tooltips and status words rendered immediately beside " +
        "translation text, so they compete for horizontal space with the content " +
        "the user is actually reading. Prefer the shortest wording that stays " +
        "unambiguous, and keep imperative verbs imperative — many of these are " +
        "both the visible label and the screen-reader name of the same button.",
      screenshot: "editor-table",
    },
    keys: {
      // AQU-646, keyed 2026-08-20. Only the two classes that require their own
      // entry — a placeholder and an accessibility name; the rest of that batch
      // inherits the namespace description above.
      "editor.row.draftSearching": {
        description:
          "Screen-reader-only live-region announcement while an AI draft is " +
          "being prepared for one row: it is looking up similar past " +
          "translations. Never visible. Leads with the row's reference so a " +
          "listener knows which line is speaking.",
        placeholders: {
          cellRef: "The row's reference, e.g. a verse or cue id.",
        },
      },
      "editor.row.draftGenerating": {
        description:
          "Screen-reader-only live-region announcement while an AI draft is " +
          "being written for one row. Never visible. Leads with the row's " +
          "reference so a listener knows which line is speaking.",
        placeholders: {
          cellRef: "The row's reference, e.g. a verse or cue id.",
        },
      },
      "editor.row.draftPreviewReady": {
        description:
          "Screen-reader-only live-region announcement when an AI draft is ready " +
          "to look at. Never visible. Leads with the row's reference so a " +
          "listener knows which line is speaking.",
        placeholders: {
          cellRef: "The row's reference, e.g. a verse or cue id.",
        },
      },
      "editor.timeline.gutterReorderAria": {
        description:
          "Screen-reader name of the timeline's track-name gutter, which is a " +
          "reorderable list. Names the list and states both ways to reorder it. " +
          "Never visible.",
      },
      "editor.timeline.trackMenuAria": {
        description:
          "Screen-reader name of the '…' button on a timeline track's row, " +
          "which opens the same options right-clicking the track does. Never " +
          "visible — the button is an icon.",
        placeholders: { name: "The track's name, as the user set it." },
      },
      "editor.timeline.deleteTrackTitle": {
        description:
          "Title of the confirmation asked before deleting a timeline track. " +
          "Deleting really deletes: the recordings on the track go with it.",
        placeholders: { name: "The track's name, as the user set it." },
      },
      "editor.timeline.deleteTracksTitle": {
        description:
          "The same confirmation when SEVERAL selected timeline tracks are " +
          "being deleted at once, where naming them all would not fit. The " +
          "line beneath states how many recordings go with them.",
        placeholders: { count: "How many tracks are being deleted; it also selects the plural form." },
      },
      "editor.timeline.trackColorCount": {
        description:
          "Submenu label when several timeline tracks are selected at once. " +
          "The count is how many of the selected tracks can actually take a " +
          "colour — source rows cannot — so it may be fewer than are selected.",
        placeholders: { count: "How many tracks will be recoloured; it also selects the plural form." },
      },
      "editor.timeline.trackNewFolderFromCount": {
        description:
          "Menu item that creates a folder containing the selected timeline " +
          "tracks. Replaces an older 'move to folder' submenu: a folder is made " +
          "FROM tracks, and moving into an existing one is a drag.",
        placeholders: { count: "How many tracks go into the new folder; it also selects the plural form." },
      },
      "editor.timeline.trackLeaveFolderCount": {
        description:
          "Menu item that returns the selected timeline tracks to the top " +
          "level, out of whatever folders they are in. The tracks are not " +
          "deleted or changed in any other way.",
        placeholders: { count: "How many tracks leave their folder; it also selects the plural form." },
      },
      "editor.timeline.trackDeleteCount": {
        description:
          "Menu item that deletes several selected timeline tracks at once. " +
          "The count is how many of the selection can be deleted — the rows a " +
          "file derives cannot — so it may be fewer than are selected. A " +
          "confirmation follows.",
        placeholders: { count: "How many tracks will be deleted; it also selects the plural form." },
      },
      "editor.timeline.deleteTrackTakes": {
        description:
          "The warning line in that confirmation, counting the recordings that " +
          "will be deleted along with the track. Stated plainly because it is " +
          "the fact the person is being asked to accept.",
        placeholders: {
          count:
            "How many recordings are on the track; it also selects which plural form is used.",
        },
      },
      "editor.timeline.deleteFolderMembers": {
        description:
          "Shown instead when the thing being deleted is a FOLDER. The tracks " +
          "inside are not deleted with it — they return to the top level — and " +
          "saying so is what stops the confirmation reading as a threat to them.",
        placeholders: {
          count:
            "How many tracks are inside the folder; it also selects which plural form is used.",
        },
      },
      "editor.timeline.addTrackAlignHint": {
        description:
          "Help text under the 'Line it up with' picker in the add-track " +
          "dialog. The new track's chips are positioned against the chosen " +
          "track's lines, and that choice is made once, at creation.",
      },
      "editor.timeline.gutterCollapseAria": {
        description:
          "Screen-reader name and tooltip of the button that narrows the " +
          "timeline's whole track-name column to a strip of icons, giving the " +
          "space to the tracks themselves. Affects every row at once. Doubles " +
          "as the button's hover tooltip, so it is read as well as heard.",
      },
      "editor.timeline.gutterExpandAria": {
        description:
          "Screen-reader name and tooltip of the button that widens the " +
          "timeline's track-name column back out, so every track's full name " +
          "and description are readable again. Affects every row at once. " +
          "Doubles as the button's hover tooltip.",
      },
      "editor.timeline.collapseVideoAria": {
        description:
          "Screen-reader name and tooltip of the button in the video's own " +
          "header that collapses the whole video section to a 40px rail of one " +
          "icon, giving its width to the text beside it. Doubles as the " +
          "button's hover tooltip. Pairs with expandVideoAria.",
      },
      "editor.timeline.expandVideoAria": {
        description:
          "Screen-reader name and tooltip of the collapsed video rail — the " +
          "strip of one icon that is all that remains of the video section, " +
          "and which is itself the button that brings the picture back. The " +
          "name is only ever seen on hover, so it carries the whole label.",
      },
      "editor.timeline.fullscreenVideoAria": {
        description:
          "Screen-reader name and tooltip of the button beside the video " +
          "header's collapse chevron, which folds the OTHER sections — the " +
          "timeline and the text — so the picture has the whole media lens " +
          "to itself. Not browser fullscreen: the app window is unchanged. " +
          "Pairs with restoreVideoAria, which is the same button pressed.",
      },
      "editor.timeline.restoreVideoAria": {
        description:
          "Screen-reader name and tooltip of that same button once the video " +
          "already has the lens to itself: pressing it puts the sections that " +
          "were folded to make room back the way they were. 'Its column' is " +
          "the video's normal place beside the text, not a table column.",
      },
      "editor.timeline.fullscreenTextAria": {
        description:
          "Screen-reader name and tooltip of the button beside the text " +
          "header's collapse chevron, which folds the OTHER sections — the " +
          "timeline and the video — so the cells have the whole media lens " +
          "to themselves. Not browser fullscreen: the app window is " +
          "unchanged. Pairs with restoreTextAria, the same button pressed.",
      },
      "editor.timeline.restoreTextAria": {
        description:
          "Screen-reader name and tooltip of that same button once the text " +
          "already has the lens to itself: pressing it puts the sections that " +
          "were folded to make room back the way they were. 'Its column' is " +
          "the text's normal place beside the video.",
      },
      "editor.timeline.collapseTimelineAria": {
        description:
          "Screen-reader name and tooltip of the button in the timeline's " +
          "toolbar that collapses the whole timeline to a 40px rail of one " +
          "icon, giving its height to the video and text below it. Doubles as " +
          "the button's hover tooltip. Pairs with expandTimelineAria.",
      },
      "editor.timeline.expandTimelineAria": {
        description:
          "Screen-reader name and tooltip of the collapsed timeline rail — the " +
          "strip of one icon that is all that remains of the timeline, and " +
          "which is itself the button that brings it back. The name is only " +
          "ever seen on hover, so it carries the whole label.",
      },
      "editor.timeline.collapseTextAria": {
        description:
          "Screen-reader name and tooltip of the button in the text section's " +
          "header that collapses the dialogue table to a 40px rail of one " +
          "icon, giving its width to the video beside it. 'Text' here is the " +
          "section holding the source and target columns, not one of them. " +
          "Doubles as the button's hover tooltip. Pairs with expandTextAria.",
      },
      "editor.timeline.expandTextAria": {
        description:
          "Screen-reader name and tooltip of the collapsed text rail — the " +
          "strip of one icon that is all that remains of the dialogue table, " +
          "and which is itself the button that brings it back. The name is " +
          "only ever seen on hover, so it carries the whole label.",
      },
      "editor.timeline.folderExpandAria": {
        description:
          "Screen-reader name of the triangle that opens a timeline folder and " +
          "shows the tracks inside it. Never visible — the control is an icon.",
        placeholders: { name: "The folder's name, as the user set it." },
      },
      "editor.timeline.folderCollapseAria": {
        description:
          "Screen-reader name of the triangle that closes a timeline folder. " +
          "The tracks inside are hidden and the folder's own row shows a " +
          "summary of where their audio falls. Never visible — an icon.",
        placeholders: { name: "The folder's name, as the user set it." },
      },
      "editor.timeline.rowsShorterAria": {
        description:
          "Screen-reader name of the button that makes every timeline row " +
          "shorter so more tracks fit. Never visible — the button is an icon. " +
          "A noun phrase naming the result, not a command.",
        maxLength: 20,
      },
      "editor.timeline.rowsTallerAria": {
        description:
          "Screen-reader name of the button that makes every timeline row " +
          "taller. Never visible — the button is an icon. A noun phrase naming " +
          "the result, not a command.",
        maxLength: 20,
      },
      "editor.timeline.badgeImportedCount": {
        description:
          "State badge on the Sources menu's 'Audio cues' row, saying how many " +
          "cues the file already carries. Lower-case, no period — it sits beside " +
          "the row's label as a status, not a sentence.",
        placeholders: {
          count: "How many audio cues are imported on this file.",
        },
      },
      "editor.timeline.noSpeechHere": {
        description:
          "Tooltip on a dashed empty chip covering a stretch of film where nobody " +
          "speaks. Not a sentence — a label and a duration, joined by a middle dot. " +
          "The 's' is the unit symbol for seconds and stays attached to the number.",
        placeholders: {
          seconds: "Length of the silent stretch in seconds, already rounded.",
        },
      },
      "editor.timeline.audioTrackSearchAria": {
        description:
          "Screen-reader name of the text box that filters the film's audio tracks " +
          "by language. Never visible — the box shows its placeholder instead. A " +
          "noun phrase naming what the box searches.",
        maxLength: 24,
      },
      "editor.lens.text": {
        description:
          "First option of the two-option lens switch above the editing table " +
          "(Text | Audio). Selects plain text translation, as opposed to the audio " +
          "lens. A noun naming the mode, not a verb; it is also the button's " +
          "screen-reader name, and the visible label is hidden on narrow screens.",
        maxLength: 12,
        screenshot: "editor-table",
      },
      "editor.completion.translating": {
        description:
          "Label at the left of the batch AI-translation progress bar, shown while " +
          "a whole file's cells are being drafted. A present-participle status word " +
          "('in progress'), not a button and not a command. Sits in a single row " +
          "with the bar and an 'n/total' counter, so it must be very short.",
        maxLength: 16,
      },
      "editor.completion.stop": {
        description:
          "Tooltip and screen-reader name of the X button that aborts the running " +
          "batch AI translation. Imperative; it cancels the remaining cells and " +
          "keeps the ones already drafted.",
        maxLength: 24,
      },
      "editor.completion.failed": {
        description:
          "Summary sentence replacing the progress bar when a batch AI translation " +
          "run finished and every attempted cell failed. Full sentence with a " +
          "period. Honest failure reporting, so do not soften it. The counted noun " +
          "is 'cells', so the plural form is governed by {total}, not {failed}.",
        placeholders: {
          failed: "Number of cells that could not be translated.",
          total: "Number of cells the run attempted in total.",
        },
      },
      "editor.completion.failedPartial": {
        description:
          "Same summary as editor.completion.failed but for a partially successful " +
          "run: some cells failed and some were drafted. Full sentence with a " +
          "period; the dash separates the failure count from the success count. As " +
          "above, the counted noun is 'cells' and the form is governed by {total}.",
        placeholders: {
          failed: "Number of cells that could not be translated.",
          total: "Number of cells the run attempted in total.",
          done: "Number of cells that were translated successfully.",
        },
      },
      "editor.health.needsAttention": {
        description:
          "Line in the health-breakdown popover giving the share of cells in scope " +
          "whose translation has decayed past the warning threshold. 'Need " +
          "attention' means a human should re-check them, not that they are broken.",
        placeholders: {
          percent:
            "Whole-number percentage (already rounded, no % sign) of cells past the " +
            "warning threshold.",
        },
      },
      "editor.health.noneNeedAttention": {
        description:
          "Reassuring empty state of the health-breakdown popover, shown instead of " +
          "the 'biggest drags' list when nothing has decayed past the threshold. " +
          "Full sentence with a period.",
      },
      "editor.health.biggestDrags": {
        description:
          "Heading above the short list of the worst-scoring cells in the health " +
          "popover — the cells dragging the score down most. Idiomatic in English; " +
          "translate the meaning ('what is hurting the score most'), not the image.",
        maxLength: 24,
      },
      "editor.removeCell.translations": {
        description:
          "One clause in the list of what removing a cell destroys, in the removal " +
          "confirmation dialog. Counts the target-language lanes that hold a translation " +
          "of the cell. Reads as an item in a sentence, e.g. \u201cits translations in 3 " +
          "languages\u201d, so it starts lower-case and carries no full stop.",
        placeholders: {
          count:
            "The number of target languages; it also selects which plural form is used.",
        },
      },
      "editor.removeCell.takes": {
        description:
          "One clause in the list of what removing a cell destroys, in the removal " +
          "confirmation dialog. Counts the voice recordings made against that cell. " +
          "Reads as an item in a sentence, so no leading capital and no full stop.",
        placeholders: {
          count:
            "The number of recordings; it also selects which plural form is used.",
        },
      },
      "editor.removeCell.comments": {
        description:
          "One clause in the list of what removing a cell destroys, in the removal " +
          "confirmation dialog. Counts every comment on the cell, replies and already- " +
          "resolved ones included. Reads as an item in a sentence, so no leading capital " +
          "and no full stop.",
        placeholders: {
          count: "The number of comments; it also selects which plural form is used.",
        },
      },
      "editor.removeCell.validations": {
        description:
          "One clause in the list of what removing a cell destroys, in the removal " +
          "confirmation dialog. Counts the reviewers whose approval currently stands on " +
          "the cell. Reads as an item in a sentence, so no leading capital and no full stop.",
        placeholders: {
          count: "The number of validations; it also selects which plural form is used.",
        },
      },
      "editor.removeCell.milestoneWarning": {
        description:
          "Extra warning in the removal confirmation dialog, shown only when the cell " +
          "being removed is the one carrying a chapter or section heading. Removing it " +
          "takes that heading out of the chapter navigator.",
        placeholders: {
          label:
            "The heading as it appears in the file, e.g. a chapter number or a section " +
            "title. Content from the user's own document \u2014 never translate it.",
        },
      },
      "editor.health.staleSource": {
        description:
          "Amber warning row in the health popover counting cells whose pinned source text " +
          "has changed since the translation was last revised, so the translation may no " +
          "longer match what it was made from.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.rail.moreActions": {
        description:
          "Tooltip and screen-reader name of the '…' overflow button in a cell's " +
          "action rail (AQU-200). Opens a small menu holding the row's " +
          "lower-frequency actions — record, upload audio, play, text-to-speech, " +
          "footnote, comments, history — which no longer each get their own " +
          "button. A noun phrase naming what is inside, not an imperative.",
        maxLength: 20,
      },
      "editor.audio.record": {
        description:
          "Tooltip and screen-reader name of the microphone button in a cell's " +
          "action rail; it opens the recording modal to capture a spoken take of " +
          "that line. Imperative verb phrase.",
        maxLength: 24,
      },
      "editor.audio.recordingDisabled": {
        description:
          "Tooltip on the microphone button when recording is turned off for this " +
          "cell (for example a read-only or Git-backed project). A state " +
          "description, not an action.",
        maxLength: 28,
      },
      "editor.audio.micBlockedTooltip": {
        description:
          "Tooltip on the microphone button when the browser has denied microphone " +
          "permission. The second half tells the user the button still does " +
          "something — it opens a small help popover rather than recording.",
      },
      "editor.audio.micBlockedTitle": {
        description:
          "Bold heading of the small help popover shown after clicking a blocked " +
          "microphone button. A short state phrase, not a sentence.",
        maxLength: 28,
      },
      "editor.audio.micBlockedHelp": {
        description:
          "Body of the mic-permission help popover: the steps to re-allow the " +
          "microphone. The padlock emoji stands for the browser's site-settings " +
          "icon in the address bar — keep the emoji. Two short sentences in a " +
          "narrow (about 13rem) popover, so keep it compact.",
      },
      "editor.cell.addComment": {
        description:
          "Overflow-menu item that starts a new comment thread on this cell. " +
          "Imperative; 'comment' here means a discussion note between team members " +
          "about the translation, not a footnote in the text.",
        maxLength: 24,
      },
      "editor.cell.closeDetails": {
        description:
          "Screen-reader name of the X button in the header of the panel that " +
          "expands under a cell row (back-translation, audio, footnotes, history). " +
          "It collapses that panel only; it does not close the file or the editor.",
      },
      "editor.waveform.scrubber": {
        description:
          "Screen-reader name of the waveform strip drawn under a cell's " +
          "translation. It behaves as a slider over the clip's duration: dragging " +
          "moves playback position. 'Scrubber' is the audio-editing term for that " +
          "control; use whatever the target language calls it.",
      },
      "editor.waveform.seekTooltip": {
        description:
          "Tooltip on a ready waveform explaining that clicking it jumps playback " +
          "to that point in the clip. 'Seek' is the audio sense of moving the " +
          "playback position, not searching for something.",
      },
      "editor.waveform.loading": {
        description:
          "Tooltip while the waveform's peak data is being downloaded and decoded. " +
          "The trailing three periods are literal in the English source here " +
          "(not the … glyph used elsewhere); use the target language's normal " +
          "continuation mark.",
      },
      "editor.waveform.needsLoadTooltip": {
        description:
          "Tooltip on a waveform that has not been fetched yet, because the project " +
          "is set to load audio only on demand. Explains that clicking downloads " +
          "the clip and draws its waveform — it does not start playback.",
      },
      "editor.waveform.load": {
        description:
          "Tiny (10px) label centred inside a not-yet-loaded waveform strip, " +
          "beside a download icon. Clicking fetches and draws the waveform. Very " +
          "little room — abbreviate before wrapping.",
        maxLength: 18,
      },
      "editor.waveform.decodeErrorTooltip": {
        description:
          "Tooltip when the clip downloaded but its audio could not be decoded into " +
          "a waveform. Two clauses: what went wrong, then what to do.",
      },
      "editor.waveform.retryTooltip": {
        description:
          "Tooltip on the amber retry overlay shown after a waveform failed to " +
          "load. Two clauses: what went wrong, then what to do. Only the waveform " +
          "drawing failed — the recording itself is fine and still plays.",
      },
      "editor.waveform.retry": {
        description:
          "Tiny (10px) label of the retry overlay inside a failed waveform strip, " +
          "beside a circular-arrow icon. Imperative; retries drawing the waveform, " +
          "not the recording.",
        maxLength: 18,
      },
      "editor.audio.upload": {
        description:
          "Tooltip and screen-reader name of the upload button in a cell's action " +
          "rail, which opens the file picker to attach an existing audio file " +
          "recorded elsewhere (typically on a phone). Distinct from recording in " +
          "the app.",
        maxLength: 24,
      },
      "editor.audio.uploadSignIn": {
        description:
          "Error shown in that popover when the user is signed out: uploading a " +
          "recording needs an account. Imperative sentence telling them what to do, " +
          "not an accusation.",
      },
      "editor.crop.open": {
        description:
          "Screen-reader name of the scissors button that opens the crop popover " +
          "for a cell's recording. Cropping trims the start and end of the clip " +
          "non-destructively — nothing is re-encoded or deleted.",
      },
      "editor.crop.title": {
        description:
          "Heading of the crop popover. A noun naming the operation (trimming the " +
          "start/end of an audio clip), not an imperative.",
        maxLength: 14,
      },
      "editor.crop.reset": {
        description:
          "Screen-reader name of the small reset control in the crop popover, which " +
          "clears both trim points so the whole recording plays again.",
      },
      "editor.crop.start": {
        description:
          "Screen-reader name of the draggable handle marking where the cropped " +
          "clip begins. A noun phrase naming the handle, not a command.",
      },
      "editor.crop.end": {
        description:
          "Screen-reader name of the draggable handle marking where the cropped " +
          "clip stops. A noun phrase naming the handle, not a command.",
      },
      "editor.file.loadErrorTitleNamed": {
        description:
          "Heading of the panel filling the editing area when a named file failed " +
          "to load. Reassuring, not technical; the body text explains that nothing " +
          "was lost.",
        placeholders: {
          fileName:
            "The file's own name as the user typed or imported it — user data, so " +
            "never translate the substituted value.",
        },
      },
      "editor.file.loadErrorTitle": {
        description:
          "Same failure heading as editor.file.loadErrorTitleNamed, used when the " +
          "file's name is not known yet.",
      },
      "editor.file.loadErrorBody": {
        description:
          "Body of the failed-to-load panel. First sentence reassures that the " +
          "user's work is intact; second suggests the likely cause and the fix. " +
          "Two short sentences.",
      },
      "editor.file.retryLoad": {
        description:
          "Button in the failed-to-load panel that fetches the file again. " +
          "Imperative. Distinct from the bare common.retry because it names what " +
          "is being retried.",
        maxLength: 24,
      },
      "editor.file.loadingFromCloud": {
        description:
          "Accessible label of the skeleton shown while a file's cells are being " +
          "fetched from the server. It is a plain read, so it must NOT say " +
          "'syncing' — that word is reserved in this app for pushing the user's " +
          "own unsaved edits.",
      },
      "editor.file.noneSelectedTitle": {
        description:
          "Heading of the neutral empty state filling the editing area when the " +
          "project has files but none is open yet. A state description, not an error.",
        maxLength: 28,
      },
      "editor.file.noneSelectedBody": {
        description:
          "Body under editor.file.noneSelectedTitle, pointing at the file list in " +
          "the left sidebar. One imperative sentence.",
      },
      "editor.file.noFilesTitle": {
        description:
          "Heading of the empty state when the project contains no files at all, so " +
          "there is nothing to pick from the sidebar. Not an error — the project is " +
          "simply new.",
        maxLength: 28,
      },
      "editor.file.noFilesBody": {
        description:
          "Body under editor.file.noFilesTitle. 'Import' means bringing an existing " +
          "document (USFM, docx, subtitles, audio…) into the project.",
      },
      "editor.file.importFile": {
        description:
          "Call-to-action button in the no-files empty state; it opens the import " +
          "dialog. Imperative, and 'import' in the bring-a-document-in sense.",
        maxLength: 24,
      },
      "editor.file.emptyNamedTitle": {
        description:
          "Heading shown when the open file loaded successfully but contains no " +
          "cells yet. Names the file so the user knows which one is empty.",
        placeholders: {
          fileName:
            "The file's own name as the user typed or imported it — user data, so " +
            "never translate the substituted value.",
        },
      },
      "editor.file.emptyTitle": {
        description:
          "Same empty-file heading as editor.file.emptyNamedTitle, used when the " +
          "file's name is not known. 'Cells' are the numbered translation units " +
          "(usually a verse or a line) the editor lists one per row.",
      },
      "editor.file.emptyBody": {
        description:
          "Body under the empty-file heading, offering the two ways forward: import " +
          "content into the file, or type directly into the first row.",
      },
      "editor.file.importContent": {
        description:
          "Call-to-action button in the empty-file state; it opens the import dialog " +
          "to add cells to the file that is already open. Imperative.",
        maxLength: 24,
      },
      "editor.stale.directLabel": {
        description:
          "Screen-reader name of the amber warning triangle in a cell's action rail " +
          "shown when the source text this translation was pinned to has since been " +
          "edited. A state description read aloud in place of the icon.",
      },
      "editor.stale.directTooltip": {
        description:
          "Tooltip behind that amber triangle, spelling out the state: the source " +
          "moved on after this translation was last revised, so the translation may " +
          "no longer match. Full sentence.",
      },
      "editor.stale.upstreamLabel": {
        description:
          "Screen-reader name of the violet dotted-border branch icon, shown when " +
          "this cell's own source is unchanged but something earlier in the chain of " +
          "linked projects it derives from has changed.",
      },
      "editor.stale.upstreamTooltip": {
        description:
          "Tooltip behind that violet icon. 'Upstream' and 'ancestry' refer to the " +
          "chain of linked projects this translation derives from — the change " +
          "happened in one of those, not in this project's own source.",
      },
      "editor.media.emptyTitle": {
        description:
          "Heading of the drop zone shown when a time-ordered (audio/video) file has " +
          "no media attached yet. 'Media' means the audio or video recording the " +
          "timeline's clips are cut from.",
        maxLength: 36,
      },
      "editor.media.dropHint": {
        description:
          "Line under editor.media.emptyTitle offering drag-and-drop. It ends with " +
          "'or' on purpose: the file-picker button follows immediately below and " +
          "completes the sentence. Keep that dangling-conjunction structure, or " +
          "rephrase so the button still reads as the alternative.",
      },
      "editor.media.choose": {
        description:
          "Button under the drop zone that opens the operating system's file picker " +
          "for an audio or video file. Imperative.",
        maxLength: 26,
      },
      "editor.media.adding": {
        description:
          "Status line replacing the drop zone while the chosen media is being " +
          "attached, beside a spinner. Present-participle status text.",
      },
      "editor.media.urlLabel": {
        description:
          "Screen-reader name of the text field for pasting a direct link to an " +
          "audio or video file hosted elsewhere. A noun phrase naming the field.",
      },
      "editor.media.attach": {
        description:
          "Button beside the media URL field that links that URL to the file. " +
          "Imperative. 'Attach' rather than 'upload' because nothing is copied — " +
          "the clip keeps streaming from its original location.",
        maxLength: 14,
      },
      "editor.media.urlHint": {
        description:
          "Explanatory line under the media URL field. The point after the dash is " +
          "reassurance about what is stored: only timing information is kept in the " +
          "project, the audio itself stays at the URL the user provided.",
      },
      "editor.footnotes.label": {
        description:
          "Heading of the footnote strip under a cell, and the name of the footnote " +
          "tab in a cell's expansion panel. A footnote here is a translator's note " +
          "carried inside the biblical text itself (a \\f marker in USFM), NOT a " +
          "team comment. Plural noun.",
        maxLength: 16,
      },
      "editor.footnotes.trayRegion": {
        description:
          "Screen-reader name of the tray docked at the bottom of the editor that " +
          "collects the footnotes of whichever rows are currently on screen. " +
          "'Visible' means 'in the rows you can currently see', not 'not hidden'.",
      },
      "editor.footnotes.trayHint": {
        description:
          "Sub-line under the tray's heading explaining that its contents change as " +
          "the user scrolls the editor. A sentence fragment describing behaviour, " +
          "not an instruction. Truncated when too long, so keep it short.",
        maxLength: 34,
      },
      "editor.footnotes.closeTray": {
        description:
          "Screen-reader name of the X button that hides the bottom footnote tray. " +
          "It closes the tray only; the footnotes themselves are untouched.",
      },
      "editor.footnotes.trayEmpty": {
        description:
          "Empty state inside the footnote tray: the rows currently on screen have " +
          "no footnotes. Scrolling elsewhere may show some. Full sentence.",
      },
      "editor.footnotes.docxReadOnly": {
        description:
          "Amber badge beside the footnote heading for a file imported from Word. " +
          "It warns that footnotes cannot be edited here yet, because writing them " +
          "back into the .docx is not safe. 'DOCX' is the file format name and " +
          "stays as-is; the middle dot separates the two halves.",
      },
      "editor.footnotes.addTarget": {
        description:
          "Small link-style button on a footnote row where the source has a note " +
          "but the translation has none yet; it creates the matching note on the " +
          "target side. Imperative.",
        maxLength: 26,
      },
      "editor.footnotes.noTarget": {
        description:
          "Italic placeholder on the target half of a footnote row when the " +
          "translation has no matching note and the user cannot create one. A state " +
          "description, not an error.",
        maxLength: 26,
      },
      "editor.footnotes.noSource": {
        description:
          "Italic placeholder on the source half of a footnote row when the " +
          "translation has a note the source does not — the reverse of " +
          "editor.footnotes.noTarget.",
        maxLength: 26,
      },
      "editor.footnotes.emptyNote": {
        description:
          "Italic placeholder standing in for a footnote whose text is blank, in " +
          "the read-only source view.",
        maxLength: 22,
      },
      "editor.footnotes.emptyTarget": {
        description:
          "Italic placeholder for a target-side footnote whose text is blank, shown " +
          "when the user cannot edit it (so it does not invite typing, unlike " +
          "editor.footnotes.addTranslation).",
        maxLength: 26,
      },
      "editor.footnotes.targetRole": {
        description:
          "Screen-reader-only label announcing that the following text is the " +
          "translated side of a footnote pair. Never visible; it exists so a " +
          "screen-reader user can tell the two halves of the row apart.",
      },
      "editor.footnotes.editPlaceholder": {
        description:
          "Placeholder inside the small textarea for typing a footnote's " +
          "translation. Trailing three periods are literal in the English source. " +
          "It tells the user what to type, so it must read as a prompt, not a label.",
      },
      "editor.footnotes.editLabel": {
        description:
          "Screen-reader name of that footnote textarea. A noun phrase naming the " +
          "field's purpose.",
      },
      "editor.footnotes.editMarker": {
        description:
          "Screen-reader name of the small numbered/lettered marker badge beside a " +
          "footnote; clicking it re-opens that note for editing.",
        placeholders: {
          label:
            "The footnote's marker as it appears in the text — a number ('3') or a " +
            "letter ('b'). Not translatable.",
        },
      },
      "editor.footnotes.clickToEdit": {
        description:
          "Screen-reader name of an editable footnote's text, telling the user the " +
          "text itself is the control that opens the editor.",
      },
      "editor.footnotes.translationLabel": {
        description:
          "Screen-reader name of the same footnote text when the user cannot edit " +
          "it — a plain noun phrase with no call to action.",
      },
      "editor.footnotes.addTranslation": {
        description:
          "Italic prompt shown in place of an editable but still-empty target " +
          "footnote, inviting the user to click and type. Trailing three periods " +
          "are literal in the English source.",
        maxLength: 24,
      },
      "editor.footnotes.deleteConfirm": {
        description:
          "Second state of the footnote Delete button: the user clicked Delete and " +
          "this click actually deletes the note. First person, deliberately " +
          "committing ('yes, I really mean it'). Use whatever a target-language " +
          "user would say to confirm a destructive step in a tiny inline button.",
        maxLength: 14,
      },
      "editor.footnotes.saveConflict": {
        description:
          "Inline error (role=alert) when saving a footnote failed because the " +
          "cell's text changed underneath the open editor, so the app can no longer " +
          "tell where the note belongs. The user's typing is preserved: the three " +
          "imperative steps are the recovery path and must stay in order.",
      },
      "editor.footnote.add": {
        description:
          "Title of the add-footnote dialog and the label of its confirming button " +
          "— the same words in both places. Imperative; it inserts a new note at " +
          "the current cursor position in the translation.",
        maxLength: 24,
        screenshot: "cell-editor",
      },
      "editor.footnote.addDescription": {
        description:
          "Sub-heading of the add-footnote dialog, naming the two things the dialog " +
          "asks for in order: the marker style, then the note text. 'Anchor' is the " +
          "word or phrase in the translation the note hangs off.",
        screenshot: "cell-editor",
      },
      "editor.footnote.markerStyle": {
        description:
          "Label above the pair of choices for how the footnote's marker is printed " +
          "in the text (a number or a letter). 'Marker' is the small raised " +
          "character readers click or look up.",
        maxLength: 20,
        screenshot: "cell-editor",
      },
      "editor.footnote.markerStyleGroup": {
        description:
          "Screen-reader name of the group containing the two marker-style buttons. " +
          "Never visible.",
        screenshot: "cell-editor",
      },
      "editor.footnote.markerNumbered": {
        description:
          "Title of the first marker-style option: markers are numbers that " +
          "renumber themselves as notes are added or removed. A noun naming the " +
          "scheme, not a command.",
        maxLength: 18,
        screenshot: "cell-editor",
      },
      "editor.footnote.markerNumberedDesc": {
        description:
          "One-line description under the Numbering option. 'Automatic' is the " +
          "selling point: the user does not maintain the numbers by hand.",
        screenshot: "cell-editor",
      },
      "editor.footnote.markerLettered": {
        description:
          "Title of the second marker-style option: markers are letters (a, b, c), " +
          "conventionally used for a second, separate series of notes. A noun " +
          "naming the scheme.",
        maxLength: 18,
        screenshot: "cell-editor",
      },
      "editor.footnote.markerLetteredDesc": {
        description:
          "One-line description under the Lettering option. The point is that " +
          "letters keep this note in a series of its own, separate from the " +
          "numbered notes.",
        screenshot: "cell-editor",
      },
      "editor.footnote.textLabel": {
        description:
          "Form label above the large textarea holding the note's wording in the " +
          "add-footnote dialog.",
        maxLength: 20,
        screenshot: "cell-editor",
      },
      "editor.footnote.textPlaceholder": {
        description:
          "Placeholder in that textarea, demonstrating the recommended shape of a " +
          "note: the quoted word from the verse, a colon, then the explanation. " +
          "It is an example, so translate both halves as example words rather than " +
          "as instructions. Trailing three periods are literal.",
        screenshot: "cell-editor",
      },
      "editor.footnote.attachedTo": {
        description:
          "First sentence of the help line under the footnote textarea, naming the " +
          "scripture reference the new note will be attached to. " +
          "editor.footnote.textHint follows it in the same paragraph.",
        placeholders: {
          ref:
            "Scripture reference of the cell, e.g. 'MAT 3:16'. Book codes and numbers " +
            "come from the project's data — do not translate the substituted value. " +
            "The app renders it monospaced and a shade darker than the rest of the " +
            "line, so it must stay a placeholder.",
        },
        screenshot: "cell-editor",
      },
      "editor.footnote.textHint": {
        description:
          "Advice under the footnote textarea, explaining the colon convention that " +
          "editor.footnote.textPlaceholder demonstrates. A recommendation, not a " +
          "requirement.",
        screenshot: "cell-editor",
      },
      "editor.footnote.targetPreview": {
        description:
          "Label above the read-only rendering of the translated cell with the new " +
          "marker inserted, so the user can see where the note will land before " +
          "committing. 'Target' means the translation, as opposed to the source.",
        maxLength: 22,
        screenshot: "cell-editor",
      },
      "editor.footnote.previewEmptyCell": {
        description:
          "Stand-in shown inside the add-footnote preview when the translated cell " +
          "has no text at all, so there is nothing to preview. A state description.",
        maxLength: 20,
        screenshot: "cell-editor",
      },
      "editor.milestone.region": {
        description:
          "Screen-reader name of the prev / picker / next control group in the " +
          "editor header that moves between the file's major divisions. It stays " +
          "generic because the divisions differ by file type (chapters, slides, " +
          "stories…); each kind's own labels are keyed under " +
          "editor.milestone.<kind>.*, with the noun written into the sentence.",
      },
      "editor.milestone.cellRange": {
        description:
          "Label of a cell-range row nested under a division in the picker, and the " +
          "same row's text value. 'Cells' are the numbered translation units; the " +
          "range is inclusive.",
        placeholders: {
          range: MILESTONE_RANGE_PLACEHOLDER,
        },
      },
      "editor.milestone.percentTranslated": {
        description:
          "First line of the two-line progress figure on the right of each picker " +
          "row: the share of the division's cells that have any translation. Sits " +
          "in a fixed 7.5rem column above editor.milestone.percentValidated, so " +
          "both must fit on one short line.",
        maxLength: 20,
        placeholders: {
          percent: "Whole-number percentage, already rounded, without the % sign.",
        },
      },
      "editor.milestone.percentValidated": {
        description:
          "Second line of that progress figure: the share of the division's cells a " +
          "reviewer has marked validated. Validated is a stronger state than " +
          "translated, so the two words must stay clearly different.",
        maxLength: 20,
        placeholders: {
          percent: "Whole-number percentage, already rounded, without the % sign.",
        },
      },
      "editor.milestone.splitAria": {
        description:
          "Label of the switch in ⋯ → Editor settings. It switches the table " +
          "between a continuous list of every cell and a paged view that shows " +
          "only the current division. On means the paged view is active. A " +
          "switch label, so it names the thing being toggled on.",
        maxLength: 28,
        screenshot: "editor-table",
      },
      "editor.milestone.splitHint": {
        description:
          "Tooltip explaining that same switch: what the on state does, and that " +
          "the chapter/section arrows then turn the page. 'Division' stays " +
          "generic because the unit differs by file type (chapter, slide, section…).",
        screenshot: "editor-table",
      },
      "editor.milestone.chapter.moveBetween": {
        description: MILESTONE_MOVE_BETWEEN + MILESTONE_KIND_CHAPTER,
      },
      "editor.milestone.chapter.previous": {
        description: MILESTONE_PREVIOUS + MILESTONE_KIND_CHAPTER,
      },
      "editor.milestone.chapter.next": {
        description: MILESTONE_NEXT + MILESTONE_KIND_CHAPTER,
      },
      "editor.milestone.chapter.current": {
        description: MILESTONE_CURRENT + MILESTONE_KIND_CHAPTER,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
        },
      },
      "editor.milestone.chapter.currentWithCells": {
        description: MILESTONE_CURRENT_WITH_CELLS + MILESTONE_KIND_CHAPTER,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
          cells: MILESTONE_CELLS_PLACEHOLDER,
        },
      },
      "editor.milestone.chapter.findPlaceholder": {
        description: MILESTONE_FIND_PLACEHOLDER + MILESTONE_KIND_CHAPTER,
      },
      "editor.milestone.chapter.find": {
        description: MILESTONE_FIND + MILESTONE_KIND_CHAPTER,
      },
      "editor.milestone.chapter.empty": {
        description: MILESTONE_EMPTY + MILESTONE_KIND_CHAPTER,
      },
      "editor.milestone.slide.moveBetween": {
        description: MILESTONE_MOVE_BETWEEN + MILESTONE_KIND_SLIDE,
      },
      "editor.milestone.slide.previous": {
        description: MILESTONE_PREVIOUS + MILESTONE_KIND_SLIDE,
      },
      "editor.milestone.slide.next": {
        description: MILESTONE_NEXT + MILESTONE_KIND_SLIDE,
      },
      "editor.milestone.slide.current": {
        description: MILESTONE_CURRENT + MILESTONE_KIND_SLIDE,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
        },
      },
      "editor.milestone.slide.currentWithCells": {
        description: MILESTONE_CURRENT_WITH_CELLS + MILESTONE_KIND_SLIDE,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
          cells: MILESTONE_CELLS_PLACEHOLDER,
        },
      },
      "editor.milestone.slide.findPlaceholder": {
        description: MILESTONE_FIND_PLACEHOLDER + MILESTONE_KIND_SLIDE,
      },
      "editor.milestone.slide.find": {
        description: MILESTONE_FIND + MILESTONE_KIND_SLIDE,
      },
      "editor.milestone.slide.empty": {
        description: MILESTONE_EMPTY + MILESTONE_KIND_SLIDE,
      },
      "editor.milestone.story.moveBetween": {
        description: MILESTONE_MOVE_BETWEEN + MILESTONE_KIND_STORY,
      },
      "editor.milestone.story.previous": {
        description: MILESTONE_PREVIOUS + MILESTONE_KIND_STORY,
      },
      "editor.milestone.story.next": {
        description: MILESTONE_NEXT + MILESTONE_KIND_STORY,
      },
      "editor.milestone.story.current": {
        description: MILESTONE_CURRENT + MILESTONE_KIND_STORY,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
        },
      },
      "editor.milestone.story.currentWithCells": {
        description: MILESTONE_CURRENT_WITH_CELLS + MILESTONE_KIND_STORY,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
          cells: MILESTONE_CELLS_PLACEHOLDER,
        },
      },
      "editor.milestone.story.findPlaceholder": {
        description: MILESTONE_FIND_PLACEHOLDER + MILESTONE_KIND_STORY,
      },
      "editor.milestone.story.find": {
        description: MILESTONE_FIND + MILESTONE_KIND_STORY,
      },
      "editor.milestone.story.empty": {
        description: MILESTONE_EMPTY + MILESTONE_KIND_STORY,
      },
      "editor.milestone.section.moveBetween": {
        description: MILESTONE_MOVE_BETWEEN + MILESTONE_KIND_SECTION,
      },
      "editor.milestone.section.previous": {
        description: MILESTONE_PREVIOUS + MILESTONE_KIND_SECTION,
      },
      "editor.milestone.section.next": {
        description: MILESTONE_NEXT + MILESTONE_KIND_SECTION,
      },
      "editor.milestone.section.current": {
        description: MILESTONE_CURRENT + MILESTONE_KIND_SECTION,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
        },
      },
      "editor.milestone.section.currentWithCells": {
        description: MILESTONE_CURRENT_WITH_CELLS + MILESTONE_KIND_SECTION,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
          cells: MILESTONE_CELLS_PLACEHOLDER,
        },
      },
      "editor.milestone.section.findPlaceholder": {
        description: MILESTONE_FIND_PLACEHOLDER + MILESTONE_KIND_SECTION,
      },
      "editor.milestone.section.find": {
        description: MILESTONE_FIND + MILESTONE_KIND_SECTION,
      },
      "editor.milestone.section.empty": {
        description: MILESTONE_EMPTY + MILESTONE_KIND_SECTION,
      },
      "editor.milestone.timeRange.moveBetween": {
        description: MILESTONE_MOVE_BETWEEN + MILESTONE_KIND_TIME_RANGE,
      },
      "editor.milestone.timeRange.previous": {
        description: MILESTONE_PREVIOUS + MILESTONE_KIND_TIME_RANGE,
      },
      "editor.milestone.timeRange.next": {
        description: MILESTONE_NEXT + MILESTONE_KIND_TIME_RANGE,
      },
      "editor.milestone.timeRange.current": {
        description: MILESTONE_CURRENT + MILESTONE_KIND_TIME_RANGE,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
        },
      },
      "editor.milestone.timeRange.currentWithCells": {
        description: MILESTONE_CURRENT_WITH_CELLS + MILESTONE_KIND_TIME_RANGE,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
          cells: MILESTONE_CELLS_PLACEHOLDER,
        },
      },
      "editor.milestone.timeRange.findPlaceholder": {
        description: MILESTONE_FIND_PLACEHOLDER + MILESTONE_KIND_TIME_RANGE,
      },
      "editor.milestone.timeRange.find": {
        description: MILESTONE_FIND + MILESTONE_KIND_TIME_RANGE,
      },
      "editor.milestone.timeRange.empty": {
        description: MILESTONE_EMPTY + MILESTONE_KIND_TIME_RANGE,
      },
      "editor.milestone.part.moveBetween": {
        description: MILESTONE_MOVE_BETWEEN + MILESTONE_KIND_PART,
      },
      "editor.milestone.part.previous": {
        description: MILESTONE_PREVIOUS + MILESTONE_KIND_PART,
      },
      "editor.milestone.part.next": {
        description: MILESTONE_NEXT + MILESTONE_KIND_PART,
      },
      "editor.milestone.part.current": {
        description: MILESTONE_CURRENT + MILESTONE_KIND_PART,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
        },
      },
      "editor.milestone.part.currentWithCells": {
        description: MILESTONE_CURRENT_WITH_CELLS + MILESTONE_KIND_PART,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
          cells: MILESTONE_CELLS_PLACEHOLDER,
        },
      },
      "editor.milestone.part.findPlaceholder": {
        description: MILESTONE_FIND_PLACEHOLDER + MILESTONE_KIND_PART,
      },
      "editor.milestone.part.find": {
        description: MILESTONE_FIND + MILESTONE_KIND_PART,
      },
      "editor.milestone.part.empty": {
        description: MILESTONE_EMPTY + MILESTONE_KIND_PART,
      },
      "editor.milestone.group.moveBetween": {
        description: MILESTONE_MOVE_BETWEEN + MILESTONE_KIND_GROUP,
      },
      "editor.milestone.group.previous": {
        description: MILESTONE_PREVIOUS + MILESTONE_KIND_GROUP,
      },
      "editor.milestone.group.next": {
        description: MILESTONE_NEXT + MILESTONE_KIND_GROUP,
      },
      "editor.milestone.group.current": {
        description: MILESTONE_CURRENT + MILESTONE_KIND_GROUP,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
        },
      },
      "editor.milestone.group.currentWithCells": {
        description: MILESTONE_CURRENT_WITH_CELLS + MILESTONE_KIND_GROUP,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
          cells: MILESTONE_CELLS_PLACEHOLDER,
        },
      },
      "editor.milestone.group.findPlaceholder": {
        description: MILESTONE_FIND_PLACEHOLDER + MILESTONE_KIND_GROUP,
      },
      "editor.milestone.group.find": {
        description: MILESTONE_FIND + MILESTONE_KIND_GROUP,
      },
      "editor.milestone.group.empty": {
        description: MILESTONE_EMPTY + MILESTONE_KIND_GROUP,
      },
      "editor.milestone.milestone.moveBetween": {
        description: MILESTONE_MOVE_BETWEEN + MILESTONE_KIND_MILESTONE,
      },
      "editor.milestone.milestone.previous": {
        description: MILESTONE_PREVIOUS + MILESTONE_KIND_MILESTONE,
      },
      "editor.milestone.milestone.next": {
        description: MILESTONE_NEXT + MILESTONE_KIND_MILESTONE,
      },
      "editor.milestone.milestone.current": {
        description: MILESTONE_CURRENT + MILESTONE_KIND_MILESTONE,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
        },
      },
      "editor.milestone.milestone.currentWithCells": {
        description: MILESTONE_CURRENT_WITH_CELLS + MILESTONE_KIND_MILESTONE,
        placeholders: {
          label: MILESTONE_LABEL_PLACEHOLDER,
          cells: MILESTONE_CELLS_PLACEHOLDER,
        },
      },
      "editor.milestone.milestone.findPlaceholder": {
        description: MILESTONE_FIND_PLACEHOLDER + MILESTONE_KIND_MILESTONE,
      },
      "editor.milestone.milestone.find": {
        description: MILESTONE_FIND + MILESTONE_KIND_MILESTONE,
      },
      "editor.milestone.milestone.empty": {
        description: MILESTONE_EMPTY + MILESTONE_KIND_MILESTONE,
      },
      "editor.milestone.vocab.chapterPlural": {
        description:
          "Plural noun for a scripture file's divisions. Used as the group heading " +
          "over the rows of the division picker and as the scope option for " +
          "assigning whole chapters. It stands alone in both places — nothing is " +
          "interpolated into it — so it takes the language's heading form.",
      },
      "editor.milestone.vocab.slidePlural": {
        description:
          "Plural noun for a presentation-shaped file's divisions; the group " +
          "heading over the division picker's rows. Standalone heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.storyPlural": {
        description:
          "Plural noun for an oral-Bible or story-set file's divisions; the group " +
          "heading over the division picker's rows. Standalone heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.sectionPlural": {
        description:
          "Plural noun for the titled divisions of a non-scripture document, where " +
          "'section' is the chapter-equivalent unit. Group heading over the " +
          "division picker's rows, and the scope option for assigning whole " +
          "sections. Standalone heading form.",
      },
      "editor.milestone.vocab.timeRangePlural": {
        description:
          "Plural noun for the divisions of an audio or video file — spans of time " +
          "on the timeline. Group heading over the picker's rows; heading form.",
        maxLength: 20,
      },
      "editor.milestone.vocab.partPlural": {
        description:
          "Plural noun for a file divided into numbered parts; the group heading " +
          "over the division picker's rows. Standalone heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.groupPlural": {
        description:
          "Plural noun for arbitrary groupings of cells, used when a file's " +
          "divisions have no more specific name. Group heading; heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.milestonePlural": {
        description:
          "The catch-all plural used when a file mixes several kinds of division, so " +
          "none of the specific words fits. Choose a neutral word for 'marked " +
          "points or stretches in the file'. Group heading; heading form.",
        maxLength: 20,
      },
      "editor.milestone.vocab.startLabel": {
        description:
          "Full label of the synthetic first division inserted before any cell " +
          "carries a real division tag, for a file with section-based (not " +
          "scripture) divisions — it stands for 'the beginning of the file'. A " +
          "noun naming a position, not the imperative 'begin' — distinct from " +
          "audio.recordingModal.startButton, which starts a recording.",
        maxLength: 16,
      },
      "editor.milestone.vocab.story": {
        description:
          "Singular fallback label for a story-set division whose source path " +
          "yields no friendlier name. Standalone noun — see " +
          "editor.milestone.vocab.storyPlural for the picker's group heading.",
        maxLength: 16,
      },
      "editor.milestone.vocab.group": {
        description:
          "Singular fallback label for a generic (IDML/InDesign) grouping " +
          "division whose source path yields no friendlier name.",
        maxLength: 16,
      },
      "editor.milestone.vocab.section": {
        description:
          "Fallback label for a heading-based division whose own heading text is " +
          "empty, so there is nothing to summarize into a label.",
        maxLength: 16,
      },
      "editor.milestone.label.slide": {
        description:
          "Full label of one division in a presentation-shaped file, naming the " +
          "slide by number. Shown as the picker's current-selection text and in " +
          "its row list.",
        placeholders: {
          number: "The slide's 1-based position in the file. Numbers only — do not translate.",
        },
      },
      "editor.milestone.label.story": {
        description:
          "Full label of one division in an Open Bible Stories file, naming the " +
          "story by number. Shown as the picker's current-selection text and in " +
          "its row list.",
        placeholders: {
          number: "The story's number within the set. Numbers only — do not translate.",
        },
      },
      "editor.milestone.label.part": {
        description:
          "Full label of one division created by splitting a file with no real " +
          "structure into fixed-size chunks, naming the chunk by number.",
        placeholders: {
          number: "The part's 1-based position. Numbers only — do not translate.",
        },
      },
      "editor.column.source": {
        description:
          "The name of the source side generally: the text being translated FROM. Used as " +
          "the left column heading of the editing table, as a settings row label, as the " +
          "label above the source snippet in the comments drawer and the recording dialog, " +
          "as the search filter that looks only at source text, as the badge marking a " +
          "search hit as source-language, and interpolated into other strings ('Source " +
          "direction'). One word, and it must pair contrastively with editor.column.target.",
      },
      "editor.column.target": {
        description:
          "The name of the target side generally: the language being translated INTO. Used " +
          "as the right, editable column heading of the editing table, as a settings row " +
          "label, as the label above the translated snippet in the comments drawer, as the " +
          "search filter that looks only at translated text, as the badge marking a search " +
          "hit as target-language, and interpolated into other strings. Must pair " +
          "contrastively with editor.column.source.",
      },
      "editor.view.settings": {
        description:
          "Tooltip, screen-reader name and hidden title of the gear-icon popover " +
          "holding per-file display preferences (line numbers, footnote display, " +
          "text direction, font size). 'Editor' here means the translation editor, " +
          "not a person who edits.",
        maxLength: 24,
      },
      "editor.view.showLineNumbers": {
        description:
          "Label of the switch that shows or hides the running line number at the " +
          "left of every row. A switch label, so it names the thing being toggled " +
          "on; do not phrase it as a question.",
        maxLength: 28,
      },
      "editor.view.showCellLabels": {
        description:
          "Label of the switch that shows or hides each cell's own label (a verse " +
          "number, a timecode, a slide title) beside the row.",
        maxLength: 28,
      },
      "editor.view.showTranslationNotes": {
        description:
          "Label of the switch that reveals the translation-notes sidebar — " +
          "published exegetical notes for the verse in focus, fetched from a notes " +
          "resource. Not the user's own comments.",
        maxLength: 32,
      },
      "editor.view.showHealthIndicators": {
        description:
          "Label of the switch that turns the per-row health ribbon, rule " +
          "infractions, and the confidence overlay on or off. Turning it off " +
          "lightens the editor on very large files. Applies to this browser only.",
        maxLength: 32,
      },
      "editor.view.targetKeyTerms": {
        description:
          "Section heading for the setting that controls subtle highlights on approved " +
          "terminology found in translated target cells.",
        maxLength: 28,
      },
      "editor.view.targetKeyTermsAlways": {
        description:
          "Option that shows approved target key-term highlights in every visible cell.",
        maxLength: 16,
      },
      "editor.view.targetKeyTermsFocused": {
        description:
          "Option that shows approved target key-term highlights only in the focused cell.",
        maxLength: 24,
      },
      "editor.view.targetKeyTermsNever": {
        description:
          "Option that hides approved target key-term highlights. Violation markers remain visible.",
        maxLength: 16,
      },
      "editor.view.footnotesHidden": {
        description:
          "First of three radio options for how footnotes are displayed: not shown " +
          "at all. A state, not a command.",
        maxLength: 18,
      },
      "editor.view.footnotesInline": {
        description:
          "Second footnote-display option: each cell's footnotes appear in a strip " +
          "directly beneath that cell's row.",
        maxLength: 26,
      },
      "editor.view.footnotesTray": {
        description:
          "Third footnote-display option: footnotes are collected in a tray docked " +
          "along the bottom of the editor, showing the notes of the rows currently " +
          "on screen.",
        maxLength: 26,
      },
      "editor.view.textDirection": {
        description:
          "Section heading in the view-settings popover for the left-to-right / " +
          "right-to-left setting of each column. Title Case in English because it " +
          "is a section heading.",
        maxLength: 22,
      },
      "editor.view.fontSize": {
        description:
          "Section heading in the view-settings popover for the per-column text " +
          "size steppers. Title Case in English because it is a section heading.",
        maxLength: 18,
      },
      "editor.view.directionAuto": {
        description:
          "First option of the three-way text-direction control (Auto / LTR / RTL): " +
          "let the app infer direction from the text itself. The other two options " +
          "are the untranslated acronyms LTR and RTL.",
        maxLength: 10,
      },
      "editor.view.directionOf": {
        description:
          "Screen-reader name of one column's three-way text-direction control.",
        placeholders: {
          side:
            "Which column — the already-translated editor.column.source or " +
            "editor.column.target.",
        },
      },
      "editor.view.decreaseFontSize": {
        description:
          "Tooltip and screen-reader name of the 'A−' button that makes one " +
          "column's text one step smaller. Imperative.",
        placeholders: {
          side:
            "Which column, lower-cased by the app from editor.column.source / " +
            "editor.column.target.",
        },
      },
      "editor.view.increaseFontSize": {
        description:
          "Tooltip and screen-reader name of the 'A+' button that makes one " +
          "column's text one step larger. Imperative.",
        placeholders: {
          side:
            "Which column, lower-cased by the app from editor.column.source / " +
            "editor.column.target.",
        },
      },
      "editor.view.useAppFontSize": {
        description:
          "Tooltip and screen-reader name of the button that drops a column's " +
          "custom size so it follows the app-wide font size again. Shown only " +
          "after A+ or A− has pinned that column. Imperative.",
        placeholders: {
          side:
            "Which column, lower-cased by the app from editor.column.source / " +
            "editor.column.target.",
        },
      },
      "editor.view.directionMismatch": {
        description:
          "Warning toast when a column's direction has been forced by hand but " +
          "its actual text runs the other way — so the text will look wrong. Two " +
          "contrasting halves: what was chosen, then what was detected. Stays on " +
          "screen until the translator dismisses it or repairs the direction.",
        placeholders: {
          side:
            "Which column is mis-set — the translated editor.column.source or " +
            "editor.column.target.",
          forced:
            "The direction the user forced, from editor.view.dirLtr / dirRtl. Rendered " +
            "bold, because it is half of the conflict this warning is about.",
          detected:
            "The direction the text actually appears to run, from " +
            "editor.view.dirLtr / dirRtl / dirMixed. Also rendered bold — the two " +
            "bold values are what the reader compares, so keep both placeholders.",
        },
      },
      "editor.view.dismissDirectionWarning": {
        description:
          "Screen-reader name of the X that hides the direction-mismatch warning. " +
          "It hides the warning only; the mis-set direction is unchanged.",
      },
      "editor.view.dirLtr": {
        description:
          "Name of left-to-right text direction, substituted mid-sentence into " +
          "editor.view.directionMismatch. Lower-case in English for that reason. " +
          "Spell out the direction rather than using the acronym.",
        maxLength: 18,
      },
      "editor.view.dirRtl": {
        description:
          "Name of right-to-left text direction, substituted mid-sentence into " +
          "editor.view.directionMismatch. Lower-case in English for that reason.",
        maxLength: 18,
      },
      "editor.view.dirMixed": {
        description:
          "Substituted into editor.view.directionMismatch when the column's text " +
          "runs both ways, so no single direction was detected. Lower-case, " +
          "mid-sentence.",
        maxLength: 14,
      },
      "editor.bibles.openTooltip": {
        description:
          "Tooltip on the collapsed right-edge tab that opens the parallel-bibles " +
          "sidebar. Two halves: the feature's name, then what it does. 'Versions' " +
          "here means published Bible translations, not document revisions.",
      },
      "editor.bibles.show": {
        description:
          "Screen-reader name of that same collapsed edge tab. Imperative.",
      },
      "editor.bibles.hide": {
        description:
          "Screen-reader name of the X that collapses the parallel-bibles sidebar " +
          "back to its edge tab. Nothing is unpinned or lost.",
      },
      "editor.bibles.edgeTab": {
        description:
          "The one word printed vertically down the collapsed edge tab. Extremely " +
          "tight — it must be short enough to read rotated 90° in a 36px-wide " +
          "column. Abbreviate rather than let it overflow.",
        maxLength: 10,
      },
      "editor.bibles.title": {
        description:
          "Heading of the open parallel-bibles sidebar. 'Parallel' means shown " +
          "side by side with the user's own translation for comparison.",
        maxLength: 22,
      },
      "editor.bibles.noReferences": {
        description: "Empty-state title when no usable Bible reference is available.",
      },
      "editor.bibles.noReferencesDescription": {
        description:
          "Explains why parallel text is unavailable for the current cells. " +
          "Do not imply that the entire file lacks references or suggest scrolling fixes it.",
      },
      "editor.bibles.scrollHint": {
        description:
          "Empty state of the parallel-bibles sidebar before the editor has focused " +
          "a verse. Explains the interaction: the panel follows the editor's scroll " +
          "position. Full sentence.",
      },
      "editor.bibles.noVersions": {
        description:
          "Empty state when a verse is in focus but the user has not chosen any " +
          "comparison translations yet. Two sentences: the state, then the fix.",
      },
      "editor.bibles.removeVersion": {
        description:
          "Screen-reader name of the X that unpins one comparison translation from " +
          "the sidebar. Imperative.",
        placeholders: {
          version:
            "The translation's short identifier, e.g. 'BSB'. A code — never " +
            "translate the substituted value.",
        },
      },
      "editor.bibles.scrollToVerse": {
        description:
          "Shown under a pinned translation when the editor is on a chapter but not " +
          "on a specific verse, so there is no single verse to display. Full " +
          "sentence.",
      },
      "editor.bibles.noTextForRef": {
        description:
          "Shown under a pinned translation that has no text at the current verse — " +
          "the translation may not include that book, or numbers verses differently. " +
          "Not an error.",
        placeholders: {
          ref:
            "The verse reference being looked up, e.g. 'MAT 3:16'. Book codes and " +
            "numbers come from the data — do not translate.",
        },
      },
      "editor.bibles.searchPlaceholder": {
        description:
          "Placeholder in the search field of the add-translation picker. The two " +
          "quoted items are examples of what to type — a language code and a " +
          "translation abbreviation; keep them as-is and translate only the framing " +
          "words.",
      },
      "editor.bibles.searchLabel": {
        description:
          "Screen-reader name of that same search field. A noun phrase naming what " +
          "is searched: published Bible translations.",
      },
      "editor.bibles.failedToLoad": {
        description:
          "Error line in the picker when the list of available translations could " +
          "not be fetched. The reason after the colon comes from the network layer " +
          "and stays in English.",
        placeholders: {
          error: "Raw failure reason from the network layer; not translated.",
        },
      },
      "editor.bibles.loadingVersions": {
        description:
          "Status text while the list of available translations is being fetched.",
        maxLength: 24,
      },
      "editor.bibles.noMatches": {
        description:
          "Shown in the translation picker when the typed query matches nothing. " +
          "Full sentence with a period, in a very narrow list.",
        maxLength: 20,
      },
      "editor.bibles.closePicker": {
        description:
          "Footer button label while the add-translation picker is open; it hides " +
          "the picker. Imperative. Swaps with editor.bibles.addVersion.",
        maxLength: 20,
      },
      "editor.bibles.addVersion": {
        description:
          "Footer button label when the picker is closed; it opens the picker to " +
          "pin another translation. Imperative.",
        maxLength: 20,
      },
      "editor.bibles.attribution": {
        description:
          "Opening words of the 10px attribution line at the foot of the sidebar. " +
          "It is followed immediately by a link whose text is the data source's " +
          "proper name, which is not translated — so this string ends mid-phrase on " +
          "purpose and the name cannot be moved in front of it.",
      },
      "editor.resources.openTooltip": {
        description:
          "Tooltip on the collapsed right-edge tab that opens the verse-resources " +
          "sidebar. Two halves: the feature's name, then what it shows. 'Resources' " +
          "here means published reference articles about the things the verse names " +
          "(a person, a town, a key term), not files or project assets.",
      },
      "editor.resources.show": {
        description:
          "Screen-reader name of that same collapsed edge tab. Imperative.",
      },
      "editor.resources.hide": {
        description:
          "Screen-reader name of the X that collapses the verse-resources sidebar " +
          "back to its edge tab. Nothing is unloaded or lost.",
      },
      "editor.resources.edgeTab": {
        description:
          "The one word printed vertically down the collapsed edge tab. Extremely " +
          "tight — it must read rotated 90° in a 36px-wide column. 'Helps' is the " +
          "field's own term for reference material that assists a translator. " +
          "Abbreviate rather than let it overflow.",
        maxLength: 10,
      },
      "editor.resources.title": {
        description:
          "Heading of the open verse-resources sidebar. Names what the panel lists: " +
          "reference articles for the entities the currently-viewed verse mentions.",
        maxLength: 24,
      },
      "editor.resources.scrollHint": {
        description:
          "Empty state shown before the editor has scrolled to a verse. Explains the " +
          "interaction: the panel follows the editor's scroll position. Full sentence.",
      },
      "editor.resources.noneForRef": {
        description:
          "Empty state when a verse IS in view but the corpus links no entities to " +
          "it — common for non-narrative verses. States the fact; nothing is broken " +
          "and there is no action to take.",
        placeholders: {
          ref: "The verse being viewed, as book/chapter/verse (e.g. 'MAT 2 1'). Not translated.",
        },
      },
      "editor.resources.failedToLoad": {
        description:
          "Error line replacing the list when the reference lookup fails (offline, " +
          "or the upstream corpus is down). The verse itself is unaffected.",
        placeholders: {
          error: "Raw English error text from the failed request. Not translated.",
        },
      },
      "editor.resources.openMap": {
        description:
          "Link under a place's locator map; opens that location on openstreetmap.org " +
          "in a new tab, where it can be zoomed. Imperative, very tight — it sits on " +
          "one 10px line opposite the coordinates.",
        maxLength: 16,
      },
      "editor.resources.mapAria": {
        description:
          "Screen-reader description of the locator map image, which is otherwise " +
          "just tiles. Names the place and reads out its coordinates, since a " +
          "non-sighted user cannot see the marker.",
        placeholders: {
          place: "Name of the biblical place shown, e.g. 'Bethlehem (of Judah)'. Not translated.",
          coords:
            "Formatted latitude/longitude, e.g. '31.705°N, 35.210°E'. The N/S/E/W letters are " +
            "English compass abbreviations. Not translated.",
        },
      },
      "editor.resources.openExternal": {
        description:
          "Tooltip on the small external-link icon beside an entity's name; it opens " +
          "that entity's full reference article on the source site in a new tab.",
        maxLength: 24,
      },
      "editor.resources.openExternalAria": {
        description:
          "Screen-reader name of that same icon-only link. Icon-only, so this string " +
          "is the only name it has, and it must say WHICH entity it opens.",
        placeholders: {
          entity: "Name of the person, place or term, e.g. 'Herod'. Not translated.",
        },
      },
      "editor.resources.attribution": {
        description:
          "Opening words of the 10px attribution line at the foot of the sidebar. It " +
          "is followed immediately by links whose text is each data source's proper " +
          "name, which is not translated — so this string ends mid-phrase on purpose " +
          "and the names cannot be moved in front of it.",
      },
      "editor.tn.title": {
        description:
          "Heading of the translation-notes sidebar. These are published exegetical " +
          "notes about the verse (a translation-helps resource), not the team's own " +
          "comments and not footnotes in the text.",
        maxLength: 24,
      },
      "editor.tn.hide": {
        description:
          "Screen-reader name of the X that hides the translation-notes sidebar.",
      },
      "editor.tn.focusHint": {
        description:
          "Empty state of the translation-notes sidebar before a cell has focus. " +
          "Explains the interaction: notes follow whichever cell the user is in. " +
          "Full sentence.",
      },
      "editor.tn.noneForRef": {
        description:
          "Shown when a verse has focus but the notes resource has nothing for it. " +
          "A neutral state, not an error. Full sentence with a period.",
        placeholders: {
          ref:
            "The verse reference in focus, e.g. 'MAT 3:16'. From the data — do not " +
            "translate. The app renders it in a monospace face, so keep it a " +
            "placeholder rather than writing a reference into the sentence.",
        },
      },
      "editor.ebible.matched": {
        description:
          "Summary line in the eBible import review: how many verses of the chosen public " +
          "translation line up with cells in this project. 'Matched' means paired to an " +
          "existing cell, not that the wording agrees.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.ebible.conflicts": {
        description:
          "Amber warning fragment appended to the match summary: matched cells that ALREADY " +
          "have translated text, which importing would overwrite. The parenthetical is the " +
          "reason it is a conflict.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.ebible.orphans": {
        description:
          "Fragment appended to the match summary counting verses present in the eBible " +
          "translation with no cell to import into. 'Orphan' is used in the sense 'has no " +
          "counterpart here'.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.ebible.selectedCount": {
        description:
          "Counter above the review list showing how many of the matched verses are " +
          "ticked for import. The slash separates chosen from available.",
        placeholders: {
          selected: "Number of verses currently ticked.",
          total: "Number of matched verses available to tick.",
        },
      },
      "editor.ebible.willOverwrite": {
        description:
          "Amber warning appended to the selection counter: this many of the ticked " +
          "verses would replace text already in the project. Parenthesised because " +
          "it qualifies the count before it.",
        placeholders: {
          count: "Number of ticked verses whose cell already has a translation.",
        },
      },
      "editor.ebible.selectAll": {
        description:
          "Tiny underlined link that ticks every matched verse, including the ones " +
          "that would overwrite existing text. One word.",
        maxLength: 10,
      },
      "editor.ebible.selectClean": {
        description:
          "Tiny underlined link that ticks only the matched verses whose cell is " +
          "still empty — the safe subset. 'Clean' means 'not yet translated', not " +
          "'tidy'.",
        maxLength: 14,
      },
      "editor.ebible.noMatches": {
        description:
          "Shown instead of the review list when no verse in the chosen eBible " +
          "translation lines up with any cell. The clause after the dash is the " +
          "likely cause, so the user knows it is fixable and not a bug.",
      },
      "editor.ebible.orphanSummary": {
        description:
          "Summary of the collapsed list of eBible verses that had no cell to import into. " +
          "The parenthetical explains what 'orphan' means here.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.ebible.andMore": {
        description:
          "Last row of the truncated orphan list, standing for the entries not " +
          "shown. The leading ellipsis glyph continues the list visually — keep a " +
          "leading continuation mark if the target language uses one.",
        placeholders: { count: "Number of orphan entries not listed." },
      },
      "editor.ebible.unmatched": {
        description:
          "Note counting the project's own source cells that the eBible translation had " +
          "nothing for — the mirror image of an orphan. Full sentence.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.ebible.apply": {
        description:
          "Label of the confirming button that writes the ticked verses into the project's " +
          "target column. Imperative, with the count so the user sees the scope before " +
          "committing.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.ebible.conflictBadge": {
        description:
          "Tiny (9px) amber badge on a review row whose cell already has translated " +
          "text. Lower-case in English because it is a badge, not a sentence. One " +
          "word — there is almost no room.",
        maxLength: 12,
      },
      "editor.state.validated": {
        description:
          "The state word for a translation a reviewer has signed off. Used as a " +
          "small badge in the history drawer and inside the screen-reader name of a " +
          "cell's editor. Lower-case in English because it is a badge and appears " +
          "mid-phrase; it must contrast clearly with editor.state.unvalidated.",
        maxLength: 14,
      },
      "editor.state.unvalidated": {
        description:
          "The state word for a translation that exists but nobody has signed off " +
          "yet. Not an error and not a rejection — just 'not yet checked'. " +
          "Lower-case, appears mid-phrase and as a small badge.",
        maxLength: 16,
      },
      "editor.history.title": {
        description:
          "Heading of the drawer listing every recorded change to one cell's " +
          "translation. A noun phrase naming the panel; the cell's reference is " +
          "appended after it by the layout.",
        maxLength: 22,
      },
      "editor.history.close": {
        description:
          "Screen-reader name of the X that closes the edit-history drawer.",
      },
      "editor.history.loading": {
        description:
          "Status text while a cell's history is being fetched from the server.",
        maxLength: 24,
      },
      "editor.history.loadFailed": {
        description:
          "Shown when the history fetch failed, in place of the list. It must not " +
          "read like 'this cell has no history' — the distinction matters, because " +
          "the cell probably does. A Retry control follows.",
      },
      "editor.history.noEdits": {
        description:
          "Genuine empty state: the cell has never been edited. Full sentence with " +
          "a period.",
        maxLength: 24,
      },
      "editor.history.refreshFailed": {
        description:
          "Quiet 10px warning above the list when the server could not be reached " +
          "but locally-known edits are being shown. The clause after the dash is " +
          "what the user is looking at. A Retry control follows.",
      },
      "editor.history.revisions": {
        description:
          "Count of 'significant' revisions — the app groups bursts of keystrokes into one " +
          "revision, so this is smaller than the raw edit count.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.history.collapsedNote": {
        description:
          "Parenthetical after the revision count, reconciling it with the raw " +
          "number of stored edits: the difference was folded into the groups. " +
          "Parenthesised because it qualifies the count before it.",
        placeholders: {
          total: "Raw number of stored edits, before grouping.",
          hidden: "How many of those were folded into a group and are not listed.",
        },
      },
      "editor.history.staleBadge": {
        description:
          "Amber badge on a history entry that was recorded but never became the " +
          "cell's value, because a concurrent edit won the slot. 'Branch' is the " +
          "version-control sense: a line of edits that split off and was not " +
          "merged. Two words maximum.",
        maxLength: 18,
      },
      "editor.history.staleTooltip": {
        description:
          "Tooltip explaining the stale-branch badge. 'First-child-of-parent race' " +
          "is this app's conflict rule: when two edits claim the same slot, the " +
          "first one to arrive wins and the other is kept but not applied. Explain " +
          "the outcome plainly; the user's text was not lost, it just is not the " +
          "current value.",
      },
      "editor.history.syncing": {
        description:
          "Badge on a history entry that is saved locally and currently being sent " +
          "to the server. Lower-case because it is a badge. Present participle.",
        maxLength: 14,
      },
      "editor.history.syncFailed": {
        description:
          "Badge on a history entry that is saved locally but could not be sent to " +
          "the server. Lower-case badge. It means 'not uploaded yet', NOT 'lost'.",
        maxLength: 16,
      },
      "editor.history.syncFailedTooltip": {
        description:
          "Tooltip on the sync-failed badge. First clause is the reassurance (the " +
          "edit is safe in this browser), second is where to go to retry. 'Sync " +
          "indicator' is the connection status control in the app chrome.",
      },
      "editor.history.minorEdits": {
        description:
          "Badge counting the intermediate keystroke-level edits folded into a revision " +
          "group. The leading plus sign means 'in addition to the one shown' — keep it.",
        maxLength: 20,
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.history.author": {
        description:
          "Attribution line under a history entry naming who made the edit. A " +
          "sentence fragment, lower-case, immediately followed by the current / " +
          "bumped marker keys.",
        placeholders: {
          author:
            "The person's display name or username, or an agent name for AI edits. " +
            "User data — never translate the substituted value. The app renders it " +
            "in a heavier weight, so it must stay a placeholder.",
        },
      },
      "editor.history.currentMarker": {
        description:
          "Marker appended to the attribution line of the entry that IS the cell's " +
          "value right now. The leading middle dot is the separator from the author " +
          "name — keep it (or the target language's equivalent inline separator).",
        maxLength: 18,
      },
      "editor.history.bumpedMarker": {
        description:
          "Marker appended to a stale entry's attribution line, saying why it is " +
          "not the current value: another edit landed first. Leading middle dot is " +
          "the separator — keep it.",
        maxLength: 36,
      },
      "editor.history.examples": {
        description:
          "Note under an AI-generated history entry: how many retrieved translation " +
          "examples the model was given as context. Evidence about how the draft was " +
          "produced.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.history.promote": {
        description:
          "Link on a stale history entry that makes that entry the cell's current " +
          "value. Imperative. 'Promote' is the lift-it-up sense; it does not delete " +
          "anything.",
        maxLength: 26,
      },
      "editor.history.promoteConfirm": {
        description:
          "Inline confirmation question shown after clicking Promote, with Confirm " +
          "and Cancel beside it. A question, so keep the question mark.",
      },
      "editor.history.restore": {
        description:
          "Link on an older (non-current, non-stale) history entry that makes that " +
          "entry's text the cell's current value again, as a new edit. Imperative. " +
          "Nothing is deleted; the newer edits stay in the history.",
        maxLength: 26,
      },
      "editor.history.restoreConfirm": {
        description:
          "Inline confirmation question shown after clicking Restore, with Confirm " +
          "and Cancel beside it. A question, so keep the question mark.",
      },
      "editor.history.showIntermediate": {
        description:
          "Tiny (10px) disclosure link that expands the folded keystroke-level " +
          "edits inside a revision group. Imperative. Swaps with " +
          "editor.history.hideIntermediate.",
        maxLength: 30,
      },
      "editor.history.hideIntermediate": {
        description:
          "The same disclosure link once expanded; it collapses the folded edits " +
          "again. Imperative.",
        maxLength: 30,
      },
      "editor.selection.actions": {
        description:
          "Screen-reader name of the floating toolbar that appears at the bottom of " +
          "the editor when several cells are selected. Names the toolbar's purpose; " +
          "never visible.",
      },
      "editor.selection.count": {
        description:
          "Leading text of that toolbar: how many cells are currently selected. " +
          "Sits at the start of a single crowded row of buttons, so keep it short.",
        placeholders: { count: "Number of selected cells." },
        maxLength: 20,
      },
      "editor.selection.needTranslation": {
        description:
          "Muted qualifier after the selection count: how many of the selected " +
          "cells are still empty. Parenthesised because it qualifies the count " +
          "before it.",
        placeholders: { count: "Number of selected cells with no translation yet." },
      },
      "editor.selection.voiceTogether": {
        description:
          "Button in the selection toolbar (audio lens only) that synthesizes the " +
          "selected lines into ONE continuous recording rather than one clip per " +
          "line. 'Together' is the whole point — keep that sense.",
        maxLength: 22,
      },
      "editor.selection.voiceUnavailable": {
        description:
          "Tooltip when the voice-together button is disabled because this file or " +
          "project has no voicing configured at all.",
      },
      "editor.selection.voiceNeedTwo": {
        description:
          "Tooltip when the voice-together button is disabled because fewer than " +
          "two of the selected lines have a translation — there is nothing to join. " +
          "Imperative: tells the user what to do.",
      },
      "editor.selection.voiceTooltip": {
        description:
          "Tooltip on the enabled voice-together button, stating the scope of the " +
          "action. 'Voice' is a verb here: produce spoken audio.",
        placeholders: { count: "Number of translated lines that will be joined." },
      },
      "editor.selection.translate": {
        description:
          "Button in the selection toolbar that asks the AI to draft the untranslated " +
          "cells in the selection. Imperative verb; a count badge follows it, so " +
          "keep the word alone short.",
        maxLength: 16,
      },
      "editor.selection.translateNotConfigured": {
        description:
          "Tooltip when the bulk-translate button is disabled because the project " +
          "has no AI model configured. A state, with the implied fix being project " +
          "settings.",
      },
      "editor.selection.allTranslated": {
        description:
          "Tooltip when the bulk-translate button is disabled because every " +
          "selected cell already has a translation, so there is nothing to draft.",
      },
      "editor.selection.translateTooltip": {
        description:
          "Tooltip on the enabled bulk-translate button. 'Missing' means cells with " +
          "no translation yet.",
        placeholders: { count: "Number of empty cells that would be drafted." },
      },
      "editor.selection.validate": {
        description:
          "Button in the selection toolbar that records the current user's sign-off " +
          "on the selected translations. Imperative verb; a count badge follows, so " +
          "keep the word alone short. It approves work, it does not check syntax.",
        maxLength: 16,
      },
      "editor.selection.validateTooltip": {
        description:
          "Tooltip on the enabled bulk-validate button, stating how many cells the click " +
          "would sign off.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.selection.validateOutOfScope": {
        description:
          "Tooltip when bulk-validate is disabled because the selection reaches into " +
          "files or language lanes this user is not assigned to. A permissions " +
          "explanation, not a fault.",
      },
      "editor.selection.validateAllMine": {
        description:
          "Tooltip when bulk-validate is disabled because this user has already " +
          "signed off every selected cell. Nothing is wrong.",
      },
      "editor.selection.validateAiDrafts": {
        description:
          "Tooltip when bulk-validate is disabled because the selected cells are " +
          "untouched AI drafts. Policy: a human must open each AI draft " +
          "individually, so they cannot be approved in bulk. The reason after the " +
          "dash is the important half.",
      },
      "editor.selection.validateNeedTranslation": {
        description:
          "Tooltip when bulk-validate is disabled because the selected cells have " +
          "no translation yet — there is nothing to approve.",
      },
      "editor.selection.validateNothingEligible": {
        description:
          "Catch-all tooltip when bulk-validate is disabled and none of the more " +
          "specific reasons applies.",
      },
      "editor.selection.removeMyValidations": {
        description:
          "Button in the selection toolbar that withdraws THIS user's sign-off from " +
          "the selected cells, leaving other reviewers' sign-offs alone. The " +
          "first-person possessive is load-bearing.",
        maxLength: 30,
      },
      "editor.selection.validateText": {
        description:
          "Label of the selection toolbar's bulk TEXT validation button. Says "
          + "\"text\" out loud because an audio twin sits beside it and the two "
          + "are never the same act. A count badge follows.",
        maxLength: 20,
      },
      "editor.selection.validateAudioNoTakes": {
        description:
          "Tooltip when the bulk audio validation button is dark because none "
          + "of the selected lines has a recording at all.",
        maxLength: 60,
      },
      "editor.selection.validateAudioAllMine": {
        description:
          "Tooltip when the bulk audio validation button is dark because the "
          + "reader has already validated every take in the selection.",
        maxLength: 60,
      },
      "editor.selection.validateAudioNothingEligible": {
        description:
          "Tooltip when the bulk audio validation button is dark and neither "
          + "of the plainer reasons applies — the takes are out of the "
          + "reader's assignment, or are generated voices, which are signed "
          + "off one at a time.",
        maxLength: 60,
      },
      "editor.selection.removeMyAudioValidations": {
        description:
          "Label of the button that withdraws the reader's own validation "
          + "from every selected recording. The first-person possessive is "
          + "load-bearing: it never touches anyone else's vote.",
        maxLength: 34,
      },
      "editor.selection.noAudioValidations": {
        description:
          "Tooltip when that button is dark because the reader has not "
          + "validated any take in the selection.",
        maxLength: 60,
      },
      "editor.selection.unvalidateAudioTooltip": {
        description:
          "Tooltip on the button that withdraws the reader's own validation "
          + "from the selected recordings. Counts TAKES, not lines — a line "
          + "with two tracks holds two.",
        placeholders: { count: "How many takes the reader's vote comes off." },
      },
      "editor.selection.unvalidatedAudioToast": {
        description:
          "Toast after withdrawing the reader's own validation from the "
          + "selected recordings. Counts takes.",
        placeholders: { count: "How many takes the vote came off." },
      },
      "editor.selection.validateAudio": {
        description:
          "Button in the selection toolbar that validates the recordings on every "
          + "selected line. SEPARATE from the text Validate beside it — signing off "
          + "a translation says nothing about whether anyone has listened to its "
          + "recording. The word is 'validate', never 'approve'.",
        maxLength: 26,
      },
      "editor.selection.validateAudioTooltip": {
        description: "Tooltip for the button above, with the number of recordings it would sign off.",
        placeholders: { count: "How many recordings the selection holds that this user can still validate." },
      },
      "editor.selection.validatedAudioToast": {
        description: "Confirmation after the bulk recording validation above ran.",
        placeholders: { count: "How many recordings were validated." },
      },
      "editor.selection.noValidations": {
        description:
          "Tooltip when the remove-my-validations button is disabled because none of " +
          "the selected cells carries this user's sign-off.",
      },
      "editor.selection.unvalidateTooltip": {
        description:
          "Tooltip on the enabled remove-my-validations button, stating the scope. 'Your' " +
          "keeps it clear that other reviewers are untouched.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.selection.harmonize": {
        description:
          "Button in the selection toolbar that opens a review sweep for wording " +
          "that should be consistent across the selected cells (key terms, names). " +
          "The trailing ellipsis means 'opens a further screen' — keep it. Only " +
          "shown to project leads.",
        maxLength: 22,
      },
      "editor.selection.harmonizeNeedLead": {
        description:
          "Tooltip when the harmonize button is disabled because the user's project " +
          "role is below lead. 'Project lead' is a role name in this app.",
      },
      "editor.selection.harmonizeTooltip": {
        description:
          "Tooltip on the enabled harmonize button, stating the scope of the sweep it " +
          "opens.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.selection.clearTooltip": {
        description:
          "Tooltip on the X at the end of the selection toolbar. The parenthetical " +
          "is the keyboard shortcut — 'Esc' is the key's name and stays as-is.",
      },
      "editor.selection.clear": {
        description:
          "Screen-reader name of that same X. It only deselects; nothing is deleted.",
      },
      "editor.selection.validatedToast": {
        description:
          "Success toast after a bulk validate. Past tense — it reports what happened.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.selection.validatedToastSkipped": {
        description:
          "Success toast when some selected cells were skipped because this user had " +
          "already signed them off. The parenthetical is the honest accounting of the " +
          "difference.",
        placeholders: {
          count: "How many cells were newly signed off. Selects the plural form.",
          already: "How many were skipped because they were already signed off.",
        },
      },
      "editor.selection.unvalidatedToast": {
        description:
          "Success toast after withdrawing this user's sign-off in bulk. Past tense.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      // The one survivor of the removed attach-video dialog (stage 6I); the
      // file pickers in the import panels are what use it now.
      "editor.video.chooseFile": {
        description:
          "Button under the drop zone that opens the operating system's file " +
          "picker. Imperative.",
        maxLength: 18,
      },
      "editor.timeline.title": {
        description:
          "Label at the left of the timeline toolbar, naming the strip below it: the " +
          "time-ordered view of a file's audio/video clips. A noun.",
        maxLength: 16,
      },
      "editor.timeline.followPlayhead": {
        description:
          "Tooltip and screen-reader name of the toggle that keeps the timeline " +
          "scrolled to the moving playback marker. When on, the view chases " +
          "playback; when off the user scrolls freely. 'Playhead' is the audio/video " +
          "term for the current-position marker.",
      },
      "editor.timeline.linkVideo": {
        description:
          "Toolbar button when no video is attached; it asks for a video URL to use " +
          "as the timeline's master clock. Imperative. Swaps with " +
          "editor.timeline.changeVideo.",
        maxLength: 18,
      },
      "editor.timeline.changeVideo": {
        description:
          "The same toolbar button when a video is already attached; it replaces the " +
          "current one. Imperative.",
        maxLength: 18,
      },
      "editor.timeline.coreVideoPrompt": {
        description:
          "Message in the browser's own prompt box that asks for the timeline's " +
          "master video URL. The parenthetical tells the user how to unlink: submit " +
          "an empty value. Plain text — no formatting is possible here.",
      },
      "editor.timeline.zoomIn": {
        description:
          "Screen-reader name of the + button that stretches the timeline so each " +
          "second takes more width. Icon-only, so this is its only name.",
      },
      "editor.timeline.zoomOut": {
        description:
          "Screen-reader name of the − button that compresses the timeline so more " +
          "time fits on screen. Icon-only.",
      },
      "editor.timeline.laneSubtitle": {
        description:
          "Name of the timeline's first track, holding the on-screen text cues. " +
          "Sits in a 128px-wide label column, so it must be short.",
        maxLength: 14,
      },
      "editor.timeline.laneSubtitleSub": {
        description:
          "10px sub-label under the Subtitle track name, saying what the track is " +
          "for: text meant to be read. The middle dot separates the medium from the " +
          "activity — keep the two-word shape.",
        maxLength: 20,
      },
      "editor.timeline.laneSourceAudio": {
        description:
          "Name of the timeline's second track, holding the ORIGINAL recording the " +
          "team is translating from — not their own takes, which have their own " +
          "track. Sits in a 128px-wide label column.",
        maxLength: 16,
      },
      "editor.timeline.laneSourceAudioSub": {
        description:
          "10px sub-label under the Source audio track name, saying what is on it: " +
          "the speech of the original recording.",
        maxLength: 22,
      },
      "editor.timeline.laneTargetAudio": {
        description:
          "Name of the timeline's third track, holding the translated audio — both " +
          "recorded takes and text-to-speech voices. Pairs with " +
          "editor.timeline.laneSourceAudio; 'target' is the translation side, the " +
          "same sense as the Target column in the editor. 128px label column.",
        maxLength: 16,
      },
      "editor.timeline.laneTargetAudioSub": {
        description:
          "10px sub-label under the Target audio track name, naming the two things " +
          "that land on it: recorded takes and generated (synthesized) voices. The " +
          "middle dot separates the two — keep the two-word shape.",
        maxLength: 22,
      },
      "editor.timeline.sourcesMenuAria": {
        description:
          "Accessible name of the timeline's Sources menu button, whose visible " +
          "label is just 'Sources'. Names what the menu does: it attaches material " +
          "— a film, the heard lines, a character sheet — to the file already open, " +
          "as opposed to the Import button, which creates a new file.",
      },
      "editor.timeline.checkMenuAria": {
        description:
          "Accessible name of the timeline's Check menu button, whose visible label " +
          "is just 'Check'. Names what the menu opens: the reviews of how the " +
          "subtitle lines are paired with the heard lines, and of where the two " +
          "character sheets disagree.",
      },
      "editor.timeline.muteNamed": {
        description:
          "Accessible name of a track's speaker button, for a track whose button " +
          "silences something the per-track names cannot describe — on a subtitle " +
          "file the source row's cues sit over the film's own soundtrack. Verb " +
          "plus the thing that goes quiet.",
        placeholders: {
          name: "What goes quiet, already translated — e.g. \"the film's own sound\".",
        },
      },
      "editor.timeline.unmuteNamed": {
        description:
          "The opposite of editor.timeline.muteNamed: accessible name of the same " +
          "speaker button while that track is silent, so pressing it brings the " +
          "sound back.",
        placeholders: {
          name: "What would become audible again, already translated.",
        },
      },
      "editor.timeline.namedAudible": {
        description:
          "Hover tooltip on that same speaker button while the track is audible. " +
          "States the current state and what a click does, separated by a dash.",
        placeholders: {
          name: "What is currently audible, already translated.",
        },
      },
      "editor.timeline.namedMuted": {
        description:
          "Hover tooltip on that same speaker button while the track is silent. " +
          "Mirrors editor.timeline.namedAudible in the opposite state.",
        placeholders: {
          name: "What is currently silent, already translated.",
        },
      },
      "editor.timeline.muteSourceAudio": {
        description:
          "Accessible name of the speaker button on the Source audio track while that " +
          "track is audible: pressing it silences the original recording during " +
          "playback. Never visible.",
      },
      "editor.timeline.unmuteSourceAudio": {
        description:
          "Accessible name of the same speaker button while the Source audio track is " +
          "already silenced: pressing it brings the original recording back. Never " +
          "visible.",
      },
      "editor.timeline.sourceAudioAudible": {
        description:
          "Hover title of that speaker button while the Source audio track is " +
          "audible. Two halves: the track's current state, then what clicking does. " +
          "Keep both.",
      },
      "editor.timeline.sourceAudioMuted": {
        description:
          "Hover title of that speaker button while the Source audio track is " +
          "silenced: current state, then what clicking does.",
      },
      "editor.timeline.muteTargetAudio": {
        description:
          "Accessible name of the speaker button on the Target audio track while it " +
          "is audible: pressing it silences the translated audio during playback. " +
          "Never visible.",
      },
      "editor.timeline.unmuteTargetAudio": {
        description:
          "Accessible name of the same button while the Target audio track is already " +
          "silenced: pressing it brings the translated audio back. Never visible.",
      },
      "editor.timeline.targetAudioAudible": {
        description:
          "Hover title of that speaker button while the Target audio track is " +
          "audible: current state, then what clicking does.",
      },
      "editor.timeline.targetAudioMuted": {
        description:
          "Hover title of that speaker button while the Target audio track is " +
          "silenced: current state, then what clicking does.",
      },
      "editor.timeline.timingModeDubbing": {
        description:
          "Name of one of the two timing modes, shown on a small segmented control in " +
          "the timeline toolbar. In this mode the translated audio has to fit inside " +
          "the original recording's timing — the possessive is the point: the timing " +
          "belongs to the original, not to the translation.",
        maxLength: 20,
      },
      "editor.timeline.timingModeDubbingHint": {
        description:
          "Hover title of that mode's button, explaining what the mode does to the " +
          "timeline: every translated line is placed to match where the original " +
          "recording says it.",
      },
      "editor.timeline.timingModeDubbingHintLocked": {
        description:
          "The same sentence as editor.timeline.timingModeDubbingHint plus the note " +
          "that the mode is read-only for this user, shown when their role is below " +
          "maintainer so the control renders as a plain label. Kept as one key so the " +
          "two sentences can be ordered naturally in the target language.",
      },
      "editor.timeline.timingModeFree": {
        description:
          "Name of the other timing mode, on the same segmented control: the " +
          "translation sets its own pace instead of fitting the original's timing. " +
          "'Free' means unconstrained by the original, not 'free of charge'.",
        maxLength: 20,
      },
      "editor.timeline.timingModeFreeHint": {
        description:
          "Hover title of that mode's button. 'Verses' are the numbered lines of the " +
          "text; 'laid end to end' means each one starts where the previous ends, and " +
          "each gets as much room as whichever side (original or translation) runs " +
          "longer.",
      },
      "editor.timeline.timingModeFreeHintLocked": {
        description:
          "The same sentence as editor.timeline.timingModeFreeHint plus the note that " +
          "only a maintainer can change the mode, shown when this user's role is " +
          "below that floor. One key so the two sentences can be ordered naturally.",
      },
      "editor.timeline.qualityToggleAria": {
        description:
          "Accessible name of the toolbar toggle that chooses how synthesized voices " +
          "are downloaded for playback — pressed means the larger original-quality " +
          "audio. Never visible.",
      },
      "editor.timeline.qualityOriginalTooltip": {
        description:
          "Tooltip of that toggle while original quality is on. 'WAV' is the " +
          "uncompressed audio file format — keep it as the file-format name. The last " +
          "sentence warns that microphone recordings have no uncompressed form, so " +
          "the setting does not affect them.",
      },
      "editor.timeline.qualityCompressedTooltip": {
        description:
          "Tooltip of the same toggle while compressed playback is on, naming the " +
          "trade-off (smaller and faster) and what clicking switches to.",
      },
      "editor.timeline.snapToggleAria": {
        description:
          "Accessible name of the toolbar toggle for snapping: while it is on, " +
          "dragging a clip's edge jumps to line up exactly with the neighbouring " +
          "clip's edge. Never visible.",
      },
      "editor.timeline.snapOnTooltip": {
        description:
          "Tooltip of the snapping toggle while snapping is on. 'Magnet to' is the " +
          "metaphor for edges pulling together as they get close — use whatever " +
          "phrasing conveys that, not a literal magnet.",
      },
      "editor.timeline.snapOffTooltip": {
        description:
          "Tooltip of the snapping toggle while snapping is off — dragged edges land " +
          "wherever they are dropped. Two words, no sentence.",
        maxLength: 20,
      },
      "editor.timeline.videoHiddenNote": {
        description:
          "Note replacing the linked video player when the file is in free-timing " +
          "mode. The video can only play on the original recording's clock, and this " +
          "view no longer lays clips out on that clock, so showing it would drift " +
          "against the audio. Explains an absence — not an error.",
      },
      "editor.timeline.outputLatencyNote": {
        description:
          "Quiet line in the timeline chrome, shown only while the audio output " +
          "looks like Bluetooth. The app already shifts the playhead by the delay " +
          "the browser reports; this says the REMAINDER cannot be measured, so the " +
          "line may still sit slightly ahead of what is heard. Not a warning and " +
          "not an error — the person can do nothing about it, and nothing is broken.",
      },
      "editor.timeline.outputDeviceChangedToast": {
        description:
          "Toast shown when playback was stopped because the audio output device " +
          "changed mid-playback — headphones connected or unplugged. States what " +
          "happened and why; the person simply presses play again.",
      },
      "editor.timeline.measureNote": {
        description:
          "Amber notice above the timeline: some recordings were saved before the app " +
          "measured how long each one is, so their blocks on the track are drawn at a " +
          "guessed width instead of their real length. Sits beside the 'Measure now' " +
          "button that fixes it.",
        placeholders: {
          count:
            "How many recordings have no measured length; it also selects which " +
            "plural form is used.",
        },
      },
      "editor.timeline.measureNow": {
        description:
          "Button in that notice that starts the measuring pass. Imperative; 'now' " +
          "signals it happens on click rather than on its own.",
        maxLength: 16,
      },
      "editor.timeline.measureTooltip": {
        description:
          "Tooltip of the Measure-now button in its ready state, spelling out what " +
          "the pass does. The reassurance in the last sentence matters: only each " +
          "recording's length is stored, and the audio itself is untouched.",
      },
      "editor.timeline.measureOfflineTooltip": {
        description:
          "Tooltip of the Measure-now button while it is disabled because the device " +
          "is offline — measuring has to fetch each recording first. Names the " +
          "condition that unblocks it.",
      },
      "editor.timeline.measureBusyTooltip": {
        description:
          "Tooltip of the Measure-now button while it is disabled because another " +
          "bulk audio job is already running; only one runs at a time.",
      },
      "editor.timeline.measureDismiss": {
        description:
          "Accessible name of the small X that hides the measure notice for this " +
          "visit. 'For now' is deliberate: the notice returns next time the timeline " +
          "opens while unmeasured recordings remain. Never visible.",
      },
      "editor.timeline.transcribeSelectionRecordings": {
        description:
          "Shown beside the selected-section count when the two differ: several " +
          "subtitles can be performed by ONE heard line (22.7% of heard lines " +
          "cover more than one), so the recording is transcribed once and " +
          "covers all of them. Stating both numbers is how the user learns that " +
          "before pressing, rather than wondering afterwards.",
        placeholders: { count: "How many recordings will actually be transcribed." },
      },
      "editor.timeline.transcribeSelectionSharedTooltip": {
        description:
          "Tooltip explaining why the section count and the recording count " +
          "differ — the sections share a heard line, and one transcription " +
          "covers all of them.",
        placeholders: { count: "How many recordings will actually be transcribed." },
      },
      "editor.timeline.transcribeSelectionCount": {
        description:
          "Read-out on the timeline's transcribe row, stating how many sections the " +
          "user has picked on the lanes. It is the confirmation that transcribing is " +
          "about to run on a chosen subset rather than the whole file, so the number " +
          "carries the meaning — keep it in the string.",
        placeholders: {
          count:
            "How many timeline sections are currently selected; it also selects " +
            "which plural form is used. Never zero — a separate string covers that.",
        },
      },
      "editor.timeline.transcribeSelectionActionMany": {
        description:
          "Label of the transcribe button on that row when more than one section is " +
          "selected, so the count tells the user how much work the click starts. " +
          "Imperative. A separate string covers the single-section label.",
        maxLength: 28,
        placeholders: {
          count:
            "How many selected sections have audio and will actually be " +
            "transcribed; it also selects which plural form is used.",
        },
      },
      "editor.timeline.laneUntimed": {
        description:
          "Name of the holding area below the timeline for clips that have no start " +
          "or end time yet, so they cannot be placed. A state word.",
        maxLength: 14,
      },
      "editor.timeline.laneUntimedSub": {
        description:
          "10px sub-label under the Untimed area, restating why those clips are " +
          "parked there: they carry no timecode.",
        maxLength: 20,
      },
      "editor.voice.volumeLevel": {
        description:
          "Screen-reader name of the volume slider itself, inside that popover. " +
          "Distinct from common.volume so the two do not read identically.",
      },
      "editor.voice.translateFirst": {
        description:
          "Italic hint shown in place of the voice panel when the cell has no " +
          "translation yet: there is nothing to speak. 'Voice' is a verb here — " +
          "produce spoken audio for this line.",
      },
      "editor.voice.play": {
        description:
          "Tooltip and screen-reader name of the round play button over the " +
          "waveform. 'This line' matters: playback is scoped to this one cell, not " +
          "the whole file. Swaps with common.pause.",
        maxLength: 22,
      },
      "editor.voice.clone": {
        description:
          "Tooltip of the clone (copy-plus) button in the voice card, which turns this " +
          "recording into a reusable synthetic voice for the project's cast. " +
          "'Clone' is the voice-synthesis term for copying a speaker's sound.",
      },
      "editor.voice.voicing": {
        description:
          "Status text while text-to-speech is producing this line's audio, in both the " +
          "waveform overlay and the small badge on the row. Present participle of the verb " +
          "'to voice'. Rendered as small as 9px, so keep it very short.",
        maxLength: 12,
      },
      "editor.voice.clickVoiceToGenerate": {
        description:
          "Hint above the cast picker when the line has a translation but no audio " +
          "yet: choosing a voice immediately synthesizes it. Explains that the " +
          "picker is also the action.",
      },
      "editor.voice.choose": {
        description:
          "Tooltip on the cast picker button that opens the searchable list of " +
          "voices. Imperative.",
        maxLength: 20,
      },
      "editor.voice.activeVoice": {
        description:
          "Screen-reader name of the cast picker button. Two parts: which voice is " +
          "currently selected, then what pressing it does.",
        placeholders: {
          name:
            "The voice's own name as configured in the project's cast — user data, " +
            "so never translate the substituted value.",
        },
      },
      "editor.format.bold": {
        description:
          "Screen-reader name of the B button in the formatting bubble that appears " +
          "over selected text in the translation editor. The typographic weight, not " +
          "the adjective for a daring person.",
        maxLength: 16,
      },
      "editor.format.boldTooltip": {
        description:
          "Tooltip of that same B button: the name plus its keyboard shortcut. " +
          "'Cmd' is the macOS modifier key's name and the letter is the physical " +
          "key — leave the parenthesised shortcut exactly as it is.",
      },
      "editor.format.italic": {
        description:
          "Screen-reader name of the I button in the formatting bubble — slanted " +
          "type. Some scripts have no italic form; use the term a local typesetter " +
          "would use, or keep the loanword.",
        maxLength: 16,
      },
      "editor.format.italicTooltip": {
        description:
          "Tooltip of the italic button: the name plus its keyboard shortcut. Leave " +
          "the parenthesised shortcut exactly as it is.",
      },
      "editor.format.underline": {
        description:
          "Screen-reader name of the U button in the formatting bubble — a line " +
          "under the text.",
        maxLength: 16,
      },
      "editor.format.underlineTooltip": {
        description:
          "Tooltip of the underline button: the name plus its keyboard shortcut. " +
          "Leave the parenthesised shortcut exactly as it is.",
      },
      "editor.format.strikethrough": {
        description:
          "Tooltip and screen-reader name of the S button in the formatting bubble — " +
          "a line drawn through the text, conventionally marking it as removed.",
        maxLength: 18,
      },
      "editor.format.code": {
        description:
          "Tooltip and screen-reader name of the button that marks the selection as " +
          "monospaced code inside a normal line. 'Inline' distinguishes it from a " +
          "whole code block.",
        maxLength: 18,
      },
      "editor.conflict.changedElsewhere": {
        description:
          "Amber banner above the editor when a teammate (or another device) " +
          "committed a new value for this cell while the user was typing. It states " +
          "the fact only — the button beside it is the action. Full sentence.",
      },
      "editor.conflict.discardAndReload": {
        description:
          "Button in that amber banner. It throws away the user's uncommitted typing " +
          "and loads the other person's value instead — destructive to local work, " +
          "so it must not read as a harmless refresh. Imperative.",
        maxLength: 24,
      },
      "editor.footnotes.deletePrompt": {
        description:
          "Inline confirmation floating in the corner of the editor after the user " +
          "deleted a footnote marker, naming which note is about to go. A question, " +
          "so keep the question mark. Confirm/cancel controls follow it; the confirm " +
          "reuses editor.footnotes.deleteConfirm.",
        placeholders: {
          label:
            "The footnote's marker as it appears in the text — a number ('3') or a " +
            "letter ('b'). Not translatable.",
        },
      },
      "editor.anchor.cursorPosition": {
        description:
          "Stand-in preview of where a new footnote will be anchored when the user " +
          "has selected no text, so there is no wording to show. A noun phrase " +
          "naming the insertion point.",
        maxLength: 22,
      },
      "editor.idml.structureChanged": {
        description:
          "Inline error (role=alert) shown for a file imported from Adobe InDesign " +
          "(IDML), where the layout's structure must survive translation. The edit " +
          "broke that structure, so it was refused. Two sentences: what happened, " +
          "then the two ways out. 'IDML' is the file-format name and stays as-is.",
      },
      "editor.idml.caretOutsideSlot": {
        description:
          "Inline error when the user pressed Shift+Enter in an InDesign file with " +
          "the cursor outside a translatable text frame, so a line break could not " +
          "be inserted. Imperative — it tells the user where to put the cursor. " +
          "'InDesign' is the product name and stays as-is; 'text slot' is the " +
          "translatable frame in the layout.",
      },
      "editor.idml.invalidMetadataError": {
        description:
          "Inline error (role=alert) replacing the whole editor when an IDML cell's " +
          "persisted formatting metadata fails validation on load — a corrupt import, " +
          "not something the user did in this session. 'IDML' is the file-format name " +
          "and stays as-is.",
      },
      "editor.idml.missingSourceHtmlError": {
        description:
          "Inline error (role=alert) replacing the whole editor when an IDML cell's " +
          "protected source HTML is absent from its metadata — a corrupt or partial " +
          "import. 'IDML' is the file-format name and stays as-is.",
      },
      "editor.idml.plainTextNoAnchorsError": {
        description:
          "Inline error (role=alert) shown when a translated IDML cell holds plain " +
          "text but none of the formatting anchors that plain text should be " +
          "distributed across — likely edited before IDML support existed. Two " +
          "sentences: what's wrong, then the two ways out. 'IDML' is the " +
          "file-format name and stays as-is.",
      },
      "editor.idml.editWouldChangeStructureError": {
        description:
          "Rejection message (role=alert, via reportIdmlError) for an in-progress " +
          "edit that would restructure the protected IDML document — the edit is " +
          "refused before it lands, distinct from editor.idml.structureChanged which " +
          "reports a structural break already detected on commit. 'IDML' is the " +
          "file-format name and stays as-is.",
      },
      "editor.idml.editWouldChangeFormattingError": {
        description:
          "Rejection message (role=alert, via reportIdmlError) for an in-progress " +
          "edit that would alter protected IDML formatting anchors — the edit is " +
          "refused before it lands. 'IDML' is the file-format name and stays as-is.",
      },
      "editor.tts.translatingBeforeVoicing": {
        description:
          "Tooltip on the tiny (9px) status badge beside a row while the AI is " +
          "drafting the translation that will then be spoken. Explains the two-step " +
          "order: translate first, voice second.",
      },
      "editor.tts.loadingVoiceModel": {
        description:
          "Tooltip while the speech model is being downloaded before it can speak " +
          "this line. A one-off cost, not per line.",
      },
      "editor.tts.loadingVoiceModelPct": {
        description:
          "Same tooltip as editor.tts.loadingVoiceModel with download progress.",
        placeholders: {
          percent: "Whole-number download percentage, already rounded, no % sign.",
        },
      },
      "editor.tts.loadingPct": {
        description:
          "The 9px badge itself while the speech model downloads, with progress. " +
          "Present participle plus a percentage. Almost no room — abbreviate the " +
          "word rather than let the badge wrap. When no progress figure is " +
          "available the badge falls back to common.loading.",
        placeholders: {
          percent: "Whole-number download percentage, already rounded, no % sign.",
        },
        maxLength: 16,
      },
      "editor.tts.generatingAudio": {
        description:
          "Tooltip behind the voicing badge (editor.voice.voicing), saying what is happening in " +
          "plainer words. Trailing character is a single ellipsis glyph.",
      },
      "editor.tts.openAudioSetup": {
        description:
          "Recovery button in the audio-error popover; it navigates to the " +
          "project's voice/audio settings so the user can fix the configuration. " +
          "Imperative.",
        maxLength: 24,
      },
      "editor.tts.failedTooltip": {
        description:
          "Tooltip on the muted badge left behind after the user dismissed an " +
          "audio-generation error. 'Generate' names the AI-voice button on the row, " +
          "so keep it recognisable as that control's name.",
      },
      "editor.tts.notVoiced": {
        description:
          "Muted 9px badge shown after dismissing an audio error, so the row does " +
          "not look as though it has audio. A state, not an error. Truncated at " +
          "80px — very tight.",
        maxLength: 14,
      },
      "editor.tts.audioFailed": {
        description:
          "Red 9px badge that opens the audio-error popover. Deliberately says " +
          "which thing failed rather than just 'Failed', because a row can carry " +
          "several kinds of failure. Truncated at 80px.",
        maxLength: 14,
      },
      "editor.validation.notValidatedTooltip": {
        description:
          "Tooltip on a row's validation button when the user may sign this " +
          "translation off. Two halves: the current state, then the invitation.",
      },
      "editor.validation.outOfScopeTooltip": {
        description:
          "Tooltip when the validation button is unavailable because this cell's " +
          "file or language lane is not assigned to the user. A scope limit, not a " +
          "role limit.",
      },
      "editor.validation.unavailableTooltip": {
        description:
          "Tooltip when validation is unavailable for any other reason, typically " +
          "the user's project role. Deliberately vague — do not guess a cause.",
      },
      "editor.validation.ariaValidated": {
        description:
          "Screen-reader name of the validation button when THIS user has already " +
          "signed the cell off; pressing it withdraws that sign-off. Three parts: " +
          "state, which cell, what the press does.",
        placeholders: {
          ref:
            "The cell's reference, e.g. 'MAT 3:16', or a fallback row number. From " +
            "the data — do not translate.",
        },
      },
      "editor.validation.ariaValidatedByOthers": {
        description:
          "Screen-reader name when other reviewers have signed off but this user " +
          "has not; pressing it adds this user's sign-off alongside theirs.",
        placeholders: {
          ref: "The cell's reference or fallback row number. Do not translate.",
        },
      },
      "editor.validation.ariaNotValidated": {
        description:
          "Screen-reader name when nobody has signed the cell off yet.",
        placeholders: {
          ref: "The cell's reference or fallback row number. Do not translate.",
        },
      },
      "editor.validation.validatedBy": {
        description:
          "Heading of the popover listing the people who have signed this " +
          "translation off. A sentence fragment introducing the list of names that " +
          "follows.",
        maxLength: 22,
      },
      "editor.validation.noActiveValidators": {
        description:
          "Empty state of that popover: sign-offs existed at some point but none is " +
          "current (the translation changed, or they were withdrawn). The history " +
          "below still shows them.",
      },
      "editor.validation.removeYours": {
        description:
          "Tooltip and screen-reader name of the small trash button beside the " +
          "user's own name in the validator list; it withdraws only their sign-off. " +
          "Imperative.",
        maxLength: 26,
      },
      "editor.validation.history": {
        description:
          "Divider heading inside the validator popover, above the earlier states of " +
          "this cell and who had signed each one off. A noun.",
        maxLength: 16,
      },
      "editor.validation.noValidatorsOnState": {
        description:
          "Shown under an earlier version of the translation in the validator " +
          "history when nobody had signed that particular version off. 'State' " +
          "means that past version of the text.",
      },
      "editor.validation.you": {
        description:
          "Marker appended after the current user's own name in validator lists, so " +
          "they can spot themselves. Parenthesised, second person.",
        maxLength: 12,
      },
      "editor.audioValidation.notValidatedTooltip": {
        description:
          "Tooltip on the audio validation control when the line's recording has not " +
          "been signed off yet. The word is 'validate', never 'approve'.",
      },
      "editor.audioValidation.outOfScopeTooltip": {
        description:
          "Tooltip when the viewer may validate audio in general but not in this file. " +
          "No lane clause, unlike the text twin: a recording is shared by every target " +
          "language, so audio validation is never per-language.",
      },
      "editor.audioValidation.unavailableTooltip": {
        description:
          "Tooltip when the viewer's role or the project's named-validator list does " +
          "not let them validate recordings at all.",
      },
      "editor.audioValidation.ownRecordingTooltip": {
        description:
          "Tooltip when the viewer recorded this take themselves and the project has " +
          "turned self-validation off for audio. States who must act instead.",
      },
      "editor.audioValidation.ariaValidated": {
        description:
          "Screen-reader name of the audio validation button once the viewer has " +
          "validated. {ref} is the line's reference, e.g. 'GEN 1:1'.",
        placeholders: { ref: "The line's reference, e.g. 'GEN 1:1'." },
      },
      "editor.audioValidation.ariaPartlyValidated": {
        description:
          "Screen-reader name when a line carries takes on more than one track and " +
          "some are validated. Every track holding a chosen take must be validated " +
          "before the line counts, so this says how far along it is.",
        placeholders: {
          done: "How many of the line's takes have reached the required number of validators.",
          total: "How many takes the line has, one per track.",
          ref: "The line's reference, e.g. 'GEN 1:1'.",
        },
      },
      "editor.audioValidation.ariaNotValidatedByYou": {
        description:
          "Screen-reader name when the line's audio is not validated and the "
          + "reader cannot validate what is left — their own recording on a "
          + "project that forbids self-validation, for instance. Same words as "
          + "the clickable version minus the invitation to click.",
        placeholders: { ref: "The line's reference, e.g. GEN 1:1." },
      },
      "editor.audioValidation.ariaOthersValidated": {
        description:
          "Screen-reader name when somebody ELSE has validated this line's "
          + "audio but the project needs more validators and the reader is not "
          + "one of them yet. Matches the filled-mic icon.",
        placeholders: {
          ref: "The line's reference, e.g. GEN 1:1.",
          count: "How many more validators the project still needs.",
        },
      },
      "editor.audioValidation.ariaNotValidated": {
        description: "Screen-reader name of the audio validation button before anyone validates.",
        placeholders: { ref: "The line's reference, e.g. 'GEN 1:1'." },
      },      "editor.audioValidation.ariaYoursMoreNeeded": {
        description:
          "Screen-reader name when the viewer HAS validated but the project asks "
          + "for more validators than the recording has. Without it the button "
          + "announces plain 'validated' while the icon beside it shows a single "
          + "check rather than the double check that means finished — the label "
          + "and the picture would disagree.",
        placeholders: {
          ref: "The line's reference, e.g. 'GEN 1:1'.",
          count: "How many further validators the recording still needs.",
        },
      },
      "editor.audioValidation.takesHeading": {
        description:
          "Heading of the popover listing a line's takes with each one's validators. " +
          "Shown only when the line has more than one take.",
        maxLength: 28,
      },
      "editor.audioValidation.takeFraction": {
        description:
          "The badge beside the audio validation icon on a line with several takes: " +
          "how many are validated out of how many exist. Digits and a slash only — it " +
          "sits in a very small space beside the icon.",
        placeholders: {
          done: "How many takes have reached the required number of validators.",
          total: "How many takes the line has.",
        },
        maxLength: 6,
      },
      "editor.audioValidation.needsMore": {
        description:
          "In the take popover: how many further people must validate this take before " +
          "it counts. The project sets the required number.",
        placeholders: { count: "How many more validators are needed." },
        maxLength: 34,
      },
      "editor.audioValidation.noValidators": {
        description: "Shown for a take in the popover that nobody has validated yet.",
        maxLength: 36,
      },
      "editor.audioValidation.generatedTake": {
        description:
          "Labels a take in the popover that was produced by text-to-speech rather than " +
          "recorded by a person. Such takes are never validated automatically.",
        maxLength: 20,
      },
      "editor.audio.addedTrackTakeHint": {
        description:
          "Header over a take in the Recording tab that lives on an extra "
          + "target-audio track rather than the line's main track, when the take "
          + "has no name of its own.",
        maxLength: 30,
      },
      "editor.audioValidation.defaultTrack": {
        description:
          "Name of the line's main audio track in the take popover, used when a take " +
          "has no name of its own. Extra tracks carry their own names.",
        maxLength: 14,
      },
      "editor.row.noTimingAria": {
        description:
          "Screen-reader name of a row in the timeline view whose cell has no start " +
          "or end time, so it is placed by document order instead. Explains the " +
          "consequence, not just the fact.",
      },
      "editor.row.noTimingBadge": {
        description:
          "Tiny (9px) amber badge in the corner of such a row. Lower-case because it " +
          "is a badge. Two words at most.",
        maxLength: 14,
      },
      "editor.row.newParagraph": {
        description:
          "Tooltip on the pilcrow (¶) marker drawn between two rows where a new " +
          "paragraph starts in the source document. A noun phrase naming what the " +
          "marker means, not an action.",
        maxLength: 20,
      },
      "editor.row.lineAria": {
        description:
          "Screen-reader name of the small number pill at the left of a row.",
        placeholders: {
          number:
            "The line or verse number as printed in the pill. A number — do not " +
            "translate.",
        },
      },
      "editor.row.cellAria": {
        description:
          "Screen-reader name of a whole row in the editing grid, used when " +
          "navigating row by row with the keyboard. 'Cell' is this app's word for " +
          "one translation unit (usually a verse or a line).",
        placeholders: {
          ref: "The cell's reference or fallback row number. Do not translate.",
        },
      },
      "editor.row.rowFallbackRef": {
        description:
          "Stand-in reference used in row and editor names when a cell has no " +
          "scripture reference of its own — just its position in the file. " +
          "Lower-case because it is substituted mid-phrase.",
        placeholders: { index: "1-based position of the row in the file." },
      },
      "editor.row.editorAria": {
        description:
          "Screen-reader name of the editable translation box, so focusing it " +
          "announces which cell it is and what state that cell is in.",
        placeholders: {
          ref: "The cell's reference or fallback row number. Do not translate.",
          state:
            "One of the state words: editor.state.validated, " +
            "editor.state.unvalidated, editor.state.selfValidated, " +
            "editor.state.empty — already translated.",
        },
      },
      "editor.row.translationAria": {
        description: "Accessible name of the translation activation button and editor, including source context.",
        placeholders: {
          ref: "Human reference or localized row number.",
          source: "A short excerpt of the source text. Do not translate.",
          state: "Already localized validation or empty state.",
        },
      },
      "editor.row.selectedTooltip": {
        description:
          "Tooltip on a row's selection checkbox when the row IS selected, " +
          "explaining the drag gesture that extends the selection to neighbouring " +
          "rows.",
      },
      "editor.row.selectTooltip": {
        description:
          "Tooltip on the selection checkbox when the row is NOT selected: what a " +
          "click does, then what a drag does.",
      },
      "editor.presence.viewing": {
        description:
          "Tiny lowercase state word after a collaborator's name on a cell row and " +
          "in the online-peers list: they have the row selected but hold no edit lock.",
      },
      "editor.presence.editing": {
        description:
          "Tiny lowercase state word after a collaborator's name on a cell row and " +
          "in the online-peers list: they hold the edit lock on that cell.",
      },
      "editor.presence.typing": {
        description:
          "Tiny lowercase state word after a collaborator's name on a cell row while " +
          "their live draft text is changing (last change within ~2 seconds).",
      },
      "editor.row.selectedAria": {
        description:
          "Screen-reader name of the selection checkbox when the row is selected. " +
          "Shorter than the tooltip because it is read aloud.",
      },
      "editor.row.selectAria": {
        description:
          "Screen-reader name of the selection checkbox when the row is not " +
          "selected.",
      },
      "editor.state.empty": {
        description:
          "State word for a cell with no translation at all, used inside the " +
          "editor's screen-reader name. Lower-case, mid-phrase.",
        maxLength: 12,
      },
      "editor.state.selfValidated": {
        description:
          "State word for a cell the CURRENT user has signed off, as opposed to one " +
          "signed off by someone else. Used inside the editor's screen-reader name. " +
          "Lower-case, mid-phrase.",
        maxLength: 20,
      },
      "editor.comments.open": {
        description:
          "Tooltip on the blue speech-bubble indicator showing a row has unresolved " +
          "discussion. 'Open' means not yet resolved. Comments are team discussion, not " +
          "footnotes.",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.comments.openAria": {
        description:
          "Screen-reader name of that indicator: the count plus what clicking does (opens " +
          "the comments panel).",
        placeholders: {
          count:
            "The number the sentence counts; it also selects which plural form is used.",
        },
      },
      "editor.column.controls": {
        description:
          "Heading of the editing table's left column in the audio lens, where the " +
          "per-line voice and playback controls sit instead of source text. Replaces " +
          "editor.column.source in that mode, so it must read as a column heading.",
        maxLength: 14,
      },
      "editor.lane.activeAria": {
        description:
          "Screen-reader name of the pill in the table header that shows which " +
          "language lane is being edited and opens the lane switcher. A 'lane' is " +
          "one target language inside a multi-language project.",
      },
      "editor.lane.setTargetLanguage": {
        description:
          "Shown in place of a language name when the project has no target " +
          "language set yet, and as the screen-reader name of the control that sets " +
          "one. Imperative.",
        maxLength: 26,
      },
      "editor.lane.changeTargetLanguage": {
        description:
          "Screen-reader name of the same control once a target language IS set, " +
          "where pressing it replaces the existing one. Imperative.",
        maxLength: 26,
      },
      "editor.lane.changeTargetLanguageItem": {
        description:
          "Menu item inside the lane switcher that opens the target-language " +
          "editor. Trailing ellipsis means 'opens a further dialog' — keep it.",
        maxLength: 28,
      },
      "editor.lane.searchAriaLabel": {
        description:
          "Accessible label for the search field inside every lane-picker combobox (editor lane switcher, rule scope picker, rules lane filter). Filters the lane list as the user types.",
      },
      "editor.lane.showArchived": {
        description:
          "Menu item in the lane switcher that reveals retired language lanes, " +
          "hidden by default so they do not clutter the list. Imperative, with the " +
          "count in parentheses.",
        placeholders: { count: "Number of archived lanes that would be revealed." },
        maxLength: 28,
      },
      "editor.empty.noMediaSegments": {
        description:
          "Heading filling the editing area in the audio lens when a timed file has " +
          "no media clips yet. 'Segments' are the individual timed pieces.",
        maxLength: 30,
      },
      "editor.empty.mediaLayerHint": {
        description:
          "Body under editor.empty.noMediaSegments, listing the two ways to get " +
          "clips: import a file, or record. 'Media layer' is the audio/video track " +
          "of the file.",
      },
      "editor.note.footnote": {
        description:
          "Kind label on the tooltip of a raised note marker in the source text: a " +
          "note printed at the foot of the page. Singular; the plural heading is " +
          "editor.footnotes.label.",
        maxLength: 16,
      },
      "editor.note.endnote": {
        description:
          "Kind label for a note collected at the end of the book rather than at " +
          "the foot of the page. Must be distinguishable from editor.note.footnote.",
        maxLength: 16,
      },
      "editor.note.crossReference": {
        description:
          "Kind label for a note that points at other scripture passages rather " +
          "than explaining anything — the parallel-passage references printed with " +
          "a verse.",
        maxLength: 22,
      },
      "editor.note.empty": {
        description:
          "Italic stand-in inside a note's tooltip when the note carries no text. " +
          "Parenthesised and lower-case because it substitutes for the missing " +
          "content, not for a label.",
        maxLength: 14,
      },
      "editor.term.managed": {
        description:
          "Tooltip and screen-reader name of a highlighted word in the source that " +
          "matches an entry in the project's approved terminology list. 'Managed' " +
          "means the project has an agreed rendering for it, which the user can " +
          "look up by clicking.",
        placeholders: {
          term:
            "The source-language word or phrase itself — project content, so never " +
            "translate the substituted value.",
        },
      },
      "editor.write.saveFailed": {
        description:
          "Inline error (role=alert) when a translation edit could not even be " +
          "queued locally — usually browser storage being full or blocked. The " +
          "optimistic text is rolled back, so the user must retype or retry. " +
          "Imperative second half.",
      },
      "editor.write.saveSourceFailed": {
        description:
          "The same failure for an edit to the SOURCE text, which only project " +
          "leads can make. Named separately so the user knows which side was lost.",
      },
      "editor.write.sourceEditingClosed": {
        description:
          "Inline error when the user's permission to edit source text was " +
          "withdrawn mid-edit, so the open source editor was closed. It explains " +
          "why the editor vanished; keep the cause-and-effect order.",
      },
      "editor.source.textAria": {
        description:
          "Screen-reader name of the read-only source column of one row — the text " +
          "being translated from.",
      },
      "editor.cellMenu.trigger": {
        description:
          "Screen-reader name of the three-dot button at the top-right of a source " +
          "cell. It opens the one menu holding every action on that cell: edit its " +
          "source text, edit its timestamps, insert a cell above or below, remove it.",
        maxLength: 20,
      },
      "editor.cellMenu.editTimestamps": {
        description:
          "Menu entry that opens a small form for typing this line's start and end " +
          "times. Only on files that run on a clock (subtitles, cue sheets). " +
          "Imperative.",
        maxLength: 24,
      },
      "editor.cellMenu.timingLocked": {
        description:
          "Why the timestamps entry is unavailable: a project-wide setting locks " +
          "imported timings against accidental changes. A full sentence — it is " +
          "shown as a second line inside the menu entry, and in the form itself.",
      },
      "editor.cellMenu.unlockInSettings": {
        description:
          "Button shown to a maintainer when timing is locked. It does NOT unlock " +
          "anything — it takes them to the project settings page where the switch " +
          "lives, because the lock covers the whole project and they should see " +
          "that before changing it. Imperative.",
        maxLength: 40,
      },
      "editor.cellMenu.startLabel": {
        description:
          "Label of the field holding when this line starts. Not bare \"Start\": " +
          "beside a second field it would read as a verb, and it collides with " +
          "the recorder's Start button.",
        maxLength: 14,
      },
      "editor.cellMenu.endLabel": {
        description:
          "Label of the field holding when this line ends. Pairs with the start " +
          "field beside it, so the two must read as a matched pair.",
        maxLength: 14,
      },
      "editor.cellMenu.betweenHint": {
        description:
          "Hint under the timestamp fields giving the START times of the lines " +
          "either side. Those two are the only limit: this line may overlap its " +
          "neighbours as much as it likes, but its start must stay between " +
          "theirs, or the file's order changes. {from} and {to} are timecodes " +
          "like 1:02.500.",
        placeholders: {
          from: "The end of the line BEFORE this one, as a timecode like 1:02.500.",
          to: "The start of the line AFTER this one, as a timecode like 1:04.000.",
        },
      },
      "editor.cellMenu.afterHint": {
        description:
          "The same hint when this is the LAST line, so only the line before " +
          "bounds it. {from} is a timecode.",
        placeholders: {
          from: "The end of the line BEFORE this one, as a timecode like 1:02.500.",
        },
      },
      "editor.cellMenu.beforeHint": {
        description:
          "The same hint when this is the FIRST line, so only the line after " +
          "bounds it. {to} is a timecode.",
        placeholders: {
          to: "The start of the line AFTER this one, as a timecode like 1:04.000.",
        },
      },
      "editor.cellMenu.badTime": {
        description:
          "Error under a timestamp field that cannot be read as a time. The example " +
          "is deliberately the short form people actually type; the field accepts " +
          "longer ones too. Keep the example a plain digits-and-punctuation " +
          "timecode in every language.",
      },
      "editor.cellMenu.startsBeforePrevious": {
        description:
          "Error when the start typed would move this line ABOVE the one before " +
          "it, changing the order of the file. Overlapping that line is fine; " +
          "starting earlier than it is not. {from} is the previous line's start, " +
          "a timecode. Nothing is saved.",
        placeholders: {
          from: "The START of the line before this one, as a timecode like 1:02.500.",
        },
      },
      "editor.cellMenu.startsAfterNext": {
        description:
          "The mirror of the entry above: the start typed would move this line " +
          "BELOW the one after it. {to} is the next line's start, a timecode. " +
          "Nothing is saved.",
        placeholders: {
          to: "The START of the line after this one, as a timecode like 1:04.000.",
        },
      },
      "editor.cellMenu.invertedTimes": {
        description:
          "Error under the timestamp fields when the end is at or before the " +
          "start, which is the one span that cannot mean anything. Nothing is " +
          "saved and what was typed is kept, so the person can see and fix it — " +
          "silently swapping the two fields would be the worse surprise.",
      },
      "editor.cellMenu.saveTimestamps": {
        description:
          "Button that commits the typed start and end times. Imperative, one word.",
        maxLength: 12,
      },
      "editor.source.editText": {
        description:
          "Tooltip and screen-reader name of the pencil that opens the source text " +
          "for editing. Only project leads see it; changing source text propagates " +
          "downstream, so it is deliberately explicit. Imperative.",
        maxLength: 24,
      },
      "editor.source.doneEditing": {
        description:
          "The same pencil's label while the source editor is open; pressing it " +
          "closes the editor. It does not discard anything — edits are already " +
          "committed as the user types.",
        maxLength: 24,
      },
      "editor.source.locked": {
        description:
          "Screen-reader name of the padlock shown where the source pencil would " +
          "be when source text cannot be edited (for example the source is pinned " +
          "to an external repository). The tooltip beside it gives the reason.",
      },
      "editor.source.placeholder": {
        description:
          "Placeholder inside the open source-text editor when the cell has no " +
          "source text. Ends with an ellipsis glyph.",
        maxLength: 20,
      },
      "editor.source.idmlProtected": {
        description:
          "Tooltip on the padlock where the source-edit pencil would be, for a file " +
          "imported from Adobe InDesign. Source text there carries invisible " +
          "position markers that tie it back to the original layout, so editing it " +
          "would break the round-trip. Explain the reason plainly; the user has done " +
          "nothing wrong. 'IDML' is the file-format name and stays as-is.",
      },
      "editor.source.formattingBadge": {
        description:
          "Tiny (9px) amber badge in a row's context line warning that the source " +
          "carries inline formatting (bold, italics) the translation cannot keep. " +
          "Lower-case badge — one word.",
        maxLength: 14,
      },
      "editor.source.formattingLossTooltip": {
        description:
          "Tooltip behind editor.source.formattingBadge. Two sentences: what the " +
          "source has, then the consequence at export time. It is a warning about " +
          "losing styling, not about losing text.",
      },
      "editor.ai.draftBadge": {
        description:
          "Amber 9px badge on a translation the AI wrote that no human has checked " +
          "yet. Two halves separated by a middle dot: what it is, then what is " +
          "required. The 'review required' half is a policy statement and must " +
          "survive.",
        maxLength: 30,
      },
      "editor.ai.draftBadgeAria": {
        description:
          "Screen-reader name of that badge, spelling out the policy: each AI draft " +
          "must be reviewed one at a time and cannot be approved in bulk.",
      },
      "editor.ai.lookingUpExamples": {
        description:
          "Status text while the app searches the project's existing translations " +
          "for similar passages to feed the model, before any drafting begins. " +
          "Trailing ellipsis glyph.",
      },
      "editor.ai.generatingTranslation": {
        description:
          "Status text once the model is actually producing the draft — the step " +
          "after editor.ai.lookingUpExamples. Trailing ellipsis glyph.",
      },
      "editor.ai.signInForTranslations": {
        description:
          "Tooltip on the AI-draft button when nobody is signed in, so no model can " +
          "be called. Imperative — the sign-in is the fix.",
      },
      "editor.ai.setUpToEnable": {
        description:
          "Tooltip on an AI button when the project has no model configured yet; " +
          "clicking opens the setup. 'Set up' is the verb, not the noun 'setup'.",
        maxLength: 26,
      },
      "editor.ai.serviceUnavailable": {
        description:
          "Tooltip when the AI service is configured but currently unreachable. The " +
          "clause after the dash is the reassurance that it is temporary and needs " +
          "no action from the user.",
      },
      "editor.ai.generating": {
        description:
          "Tooltip on an AI button while its request is in flight. Present " +
          "participle, trailing ellipsis glyph.",
        maxLength: 18,
      },
      "editor.ai.translateWithAi": {
        description:
          "Tooltip on the sparkle button that asks the model to draft THIS one " +
          "cell. Imperative.",
        maxLength: 24,
      },
      "editor.ai.draftParagraph": {
        description:
          "Tooltip on the button that drafts every cell of the paragraph in one " +
          "model call, so the sentences read together. The count tells the user the " +
          "scope before they click.",
        placeholders: { count: "Number of cells in the paragraph." },
      },
      "editor.ai.regenerate": {
        description:
          "Tooltip on the refresh button that asks the model for a different draft " +
          "of a cell that already has one. The clause after the dash is the point: " +
          "it produces an alternative, not a correction.",
      },
      "editor.audio.play": {
        description:
          "Tooltip on the action-rail play button for a cell's recording. Swaps " +
          "with common.pause. Imperative.",
        maxLength: 18,
      },
      "editor.cue.playFrom": {
        description:
          "Tooltip on the action-rail button that starts the file's master " +
          "audio/video from this cell's timecode, rather than playing the cell's own " +
          "recording. 'Cue' is the timed entry.",
        maxLength: 24,
      },
      "editor.expansion.retrievalSupport": {
        description:
          "Name of the expansion tab showing how much evidence from the project's " +
          "own existing translations backs this cell's draft. 'Retrieval' is the " +
          "search step that finds that evidence. Tab labels sit beside an icon and " +
          "hide on narrow screens.",
        maxLength: 22,
      },
      "editor.expansion.endorsements": {
        description:
          "Summary line in the retrieval-support tab: how many times reviewers have " +
          "endorsed this rendering, and the resulting support score as a percentage. The " +
          "middle dot separates the two figures.",
        placeholders: {
          count:
            "Number of endorsements. Selects the plural form, and the app renders it " +
            "emphasised inside the sentence.",
          percent:
            "Support score 0-100, already rounded, without the % sign — the sign " +
            "belongs to this string, so its glyph and position are yours to choose. " +
            "The number itself is rendered emphasised.",
        },
      },
      "editor.expansion.lowerSupport": {
        description:
          "Advice shown when the retrieval-support score is below the threshold: " +
          "little comparable material was found, so check the wording carefully. Not " +
          "a claim that the translation is wrong.",
      },
      "editor.expansion.betterSupport": {
        description:
          "Advice shown when the score is healthy. The clause after the dash is " +
          "load-bearing: a good score never removes the need for human review.",
      },
      "editor.bt.label": {
        description:
          "Name of the expansion tab and its heading: the AI's rendering of the " +
          "finished translation back into a language the reviewer reads, used to " +
          "check that the meaning carried over. A standard Bible-translation term.",
        maxLength: 24,
      },
      "editor.bt.explainTooltip": {
        description:
          "Tooltip explaining what a back-translation is and how much to trust it. " +
          "Names both checks (AI and the project's own pairs) and insists neither " +
          "is proof. The caution is the load-bearing half and must survive.",
      },
      "editor.bt.needsAiTooltip": {
        description:
          "Tooltip on the disabled regenerate button when no AI model is available: " +
          "either nobody is signed in, or the project has no model configured. Both " +
          "routes are offered.",
      },
      "editor.bt.regenerateTooltip": {
        description:
          "Tooltip on the enabled regenerate button; it asks the model to " +
          "back-translate the current target text again, replacing the existing " +
          "back-translation. Imperative.",
        maxLength: 28,
      },
      "editor.bt.regenerateAria": {
        description:
          "Screen-reader name of that same regenerate button, naming its object " +
          "explicitly because the icon alone is ambiguous on this panel.",
      },
      "editor.bt.editTooltip": {
        description:
          "Tooltip and screen-reader name of the pencil that opens the " +
          "back-translation for hand-editing, so a reviewer can correct the AI's " +
          "reading. Imperative.",
        maxLength: 26,
      },
      "editor.bt.contributorRequired": {
        description:
          "Tooltip on the disabled pencil when the user's project role is below " +
          "contributor. 'Contributor+' means contributor or any higher role — keep " +
          "the 'or above' sense.",
      },
      "editor.bt.failed": {
        description:
          "Label on the inline error shown inside the back-translation tab when the " +
          "AI request to read the translation back did not complete. The provider's " +
          "own error message is shown beside it.",
      },
      "editor.bt.translateFirst": {
        description:
          "Empty state of the back-translation tab when the cell has no translation " +
          "yet: there is nothing to back-translate. Full sentence.",
      },
      "editor.bt.staleWarning": {
        description:
          "Amber warning inside the back-translation tab: the translation was edited " +
          "after this reading was produced, so the reading may describe older text. " +
          "A Refresh button sits beside it. 'Earlier version' is the trust signal — " +
          "do not soften it into a generic 'out of date'.",
      },
      "editor.bt.emptyPitch": {
        description:
          "Invitation shown when no back-translation exists yet, explaining what the " +
          "feature is for before the user spends a model call on it. Uses standard " +
          "Bible-translation / LQA terminology (literal reverse translation, compare " +
          "to source). One sentence, wrapped at about 34 characters.",
      },
      "editor.bt.readingItBack": {
        description:
          "Label of the generate button while the model is working. Present " +
          "participle parallel to editor.bt.readItBack.",
        maxLength: 28,
      },
      "editor.bt.readItBack": {
        description:
          "Primary button that generates the first back-translation. Standard " +
          "industry noun phrase — same term as the tab label. Imperative.",
        maxLength: 26,
      },
      "editor.bt.needsAiHint": {
        description:
          "Small print under the disabled generate button, offering the two ways to " +
          "make an AI model available. Full sentence.",
      },
      "editor.bt.contributorCanGenerate": {
        description:
          "Small print shown instead of the generate button to a user whose role is " +
          "too low: a teammate with more permission can do it. Neutral, not a " +
          "refusal aimed at the reader.",
      },
      "editor.bt.originAi": {
        description:
          "Quiet provenance chip on a model-produced back-translation. Names the " +
          "source so the user does not mistake it for a human check. A noun phrase.",
        maxLength: 22,
      },
      "editor.bt.originCorrected": {
        description:
          "Quiet provenance chip when a contributor has edited the AI " +
          "back-translation. Signals that a human stands behind this wording.",
        maxLength: 18,
      },
      "editor.bt.freshLabel": {
        description:
          "Quiet reassurance when the reading still describes the translation on " +
          "screen. Opposite of editor.bt.staleWarning. A status, not a button.",
        maxLength: 28,
      },
      "editor.bt.pairsDisagree": {
        description:
          "Heading of the statistical-clue card when the project's statistical " +
          "gloss differs from the AI back-translation. This disagreement is the " +
          "point of the card — keep the contrast.",
      },
      "editor.bt.pairsLive": {
        description:
          "Heading of the live statistical gloss shown before an AI back-translation " +
          "exists. It updates as the translator types. Emphasize project pairs, not " +
          "a model.",
      },
      "editor.bt.usePairsInstead": {
        description:
          "Button that adopts the statistical gloss as the saved back-translation, " +
          "replacing the AI wording. Imperative.",
        maxLength: 18,
      },
      "editor.bt.statisticalGloss": {
        description:
          "Heading of a collapsed section holding a rough word-for-word rendering " +
          "computed from the project's own translated pairs, offered as a " +
          "cross-check on the AI reading. 'Gloss' is the word-by-word sense.",
        maxLength: 24,
      },
      "editor.bt.statisticalGlossSub": {
        description:
          "Muted continuation of the statistical-gloss heading, on the same line. " +
          "The leading dash joins it to the heading, so keep an equivalent " +
          "separator and do not start with a capital.",
      },
      "editor.bt.glossNotEnoughPairs": {
        description:
          "Italic message when the project has too few translated pairs to compute a " +
          "word-for-word gloss. It is a matter of corpus size, not an error.",
      },
      "editor.bt.glossDisclaimer": {
        description:
          "10px small print under the statistical gloss. Three points, in order: it " +
          "is computed from the project's own pairs with no AI, its quality tracks " +
          "how much has been translated so far, and it should be treated as a hint. " +
          "The honesty here is the point — do not soften it.",
      },
      "editor.bt.alignment": {
        description:
          "Heading of a collapsed section showing which source words correspond to " +
          "which target words. 'Alignment' is the standard term for that pairing.",
        maxLength: 20,
      },
      "editor.bt.alignmentSub": {
        description:
          "Muted continuation of the alignment heading, on the same line. The " +
          "leading dash joins it to the heading; do not start with a capital. The " +
          "slash separates the two sides, named by editor.column.source and " +
          "editor.column.target elsewhere.",
      },
      "editor.transcript.editTooltip": {
        description:
          "Tooltip on the pencil that opens the recording transcript for correction, " +
          "so a Whisper mistake can be fixed without re-transcribing. Imperative.",
        maxLength: 28,
      },
      "editor.transcript.editAria": {
        description:
          "Screen-reader name of that same transcript-edit control, naming the " +
          "object because the icon alone is ambiguous next to regenerate.",
      },
      "editor.transcript.contributorRequired": {
        description:
          "Tooltip on the disabled transcript pencil when the user's role is below " +
          "contributor. Mirror editor.bt.contributorRequired; keep the 'or above' sense.",
      },
      "editor.expansion.recording": {
        description:
          "Name of the expansion tab holding this cell's spoken audio — the human " +
          "recording and any synthesized voice. A noun, beside an icon, hidden on " +
          "narrow screens.",
        maxLength: 18,
      },
      "editor.voice.synthesizeWith": {
        description:
          "Label inside the drop zone while a voice from the cast toolbar is being " +
          "dragged over the cell: releasing synthesizes this line in that voice. " +
          "Imperative.",
        placeholders: {
          name:
            "The dragged voice's own name from the project's cast — user data, so " +
            "never translate the substituted value.",
        },
      },
      "editor.voice.dropToSynthesize": {
        description:
          "The same drop-zone label when the dragged voice cannot be named. " +
          "Imperative: describes the release gesture and its result.",
        maxLength: 26,
      },
      "editor.audio.reRecordShort": {
        description:
          "Small button in the recording tab that re-opens the recording modal to " +
          "replace the existing take. The short form of editor.cell.reRecord, for a " +
          "narrow row of buttons.",
        maxLength: 16,
      },
      "editor.cell.transcribeShort": {
        description:
          "Small button in the recording tab that runs speech-to-text on the take. " +
          "The short form of editor.cell.transcribe, without naming the model.",
        maxLength: 16,
      },
      "editor.voice.aiGeneratedHint": {
        description:
          "Line above the buttons in the recording tab when the cell's audio is " +
          "synthetic. Two parts: what this audio is, then how to change it. The " +
          "trailing colon leads into the button beside it, so keep it.",
      },
      "editor.audio.recordOver": {
        description:
          "Small button offering to replace a synthesized voice with a real human " +
          "recording. Imperative; 'over' carries the replacing sense.",
        maxLength: 18,
      },
      "editor.audio.noAudioYet": {
        description:
          "Empty state of the recording tab, offering the two ways to get audio: " +
          "record it, or drag a synthetic voice onto the cell. 'Below' and 'above' " +
          "refer to the button under this text and the cast toolbar over the table.",
      },
      "editor.audio.recordShort": {
        description:
          "Primary button in the recording tab's empty state; it opens the " +
          "recording modal. Imperative, one word.",
        maxLength: 14,
      },
      "editor.audio.heardLineAt": {
        description:
          "Heading over one recording in the Recording tab that belongs to a " +
          "HEARD LINE — the performance of this subtitle, which is a separate " +
          "cue with its own place on the film. The timecode range says which " +
          "one, since a subtitle can be performed by more than one.",
        placeholders: {
          range: "The heard line's start and end times, e.g. '1:03.4–1:05.9'. Already formatted.",
        },
      },
      "editor.audio.heardLineShared": {
        description:
          "Warning under a heard line's recording when that one performance " +
          "also covers other subtitle lines, so re-recording it changes them " +
          "as well. Only shown when the count is at least one.",
        placeholders: {
          count: "How many OTHER subtitle lines this heard line performs (never zero).",
        },
      },
      "editor.expansion.issues": {
        description:
          "Name of the expansion tab listing translation-rule problems found in this " +
          "cell (a checklist of project conventions), beside a warning icon. Plural " +
          "noun; the tab is disabled when there are none.",
        maxLength: 16,
      },
      "editor.expansion.metadata": {
        description:
          "Name of the expansion tab showing extra untranslated columns that came in " +
          "with the import (reference codes, quotes, tags, attached images). A noun.",
        maxLength: 18,
      },
      "editor.metadata.showOnCells": {
        description:
          "Tooltip and screen-reader name of the checkbox beside one field in a cell's " +
          "Metadata tab. Checking it shows that field's value as a small label on every " +
          "cell in the project that has the field. {key} is the field name as imported " +
          "(e.g. \"Field\"), shown verbatim — do not translate it.",
        placeholders: {
          key: "The metadata field name exactly as imported, e.g. \"Field\". Not translated.",
        },
      },
      "editor.issues.none": {
        description:
          "Reassuring empty state of the Issues tab: no rule was broken in this " +
          "cell. Full sentence with a period.",
      },
      "editor.issues.waived": {
        description:
          "Divider heading above rule problems the team has explicitly decided to " +
          "accept, so they no longer count against the cell. Past participle of " +
          "'to waive' — a deliberate exemption, not something ignored by accident.",
        maxLength: 16,
      },
      "editor.paragraph.confirmTitle": {
        description:
          "Title of the dialog confirming that the AI should draft every cell of the " +
          "paragraph in one go. A question, so keep the question mark.",
        maxLength: 30,
      },
      "editor.paragraph.confirmAll": {
        description:
          "Body of that dialog when every cell in the paragraph will be drafted. It " +
          "repeats the question and then states the scope. 'As one unit' is the " +
          "selling point: the sentences are drafted together so they read as " +
          "continuous prose.",
        placeholders: { total: "Number of cells in the paragraph." },
      },
      "editor.paragraph.confirmPartial": {
        description:
          "Body of that dialog when some cells are already signed off and will be " +
          "left alone. Three parts: the question, the scope, and the reassurance " +
          "that validated work is not touched.",
        placeholders: {
          draftable: "Number of cells that will actually be drafted.",
          total: "Total number of cells in the paragraph.",
        },
      },
      "editor.paragraph.confirmAction": {
        description:
          "Confirming button of the draft-paragraph dialog. Imperative, and it must " +
          "match the wording of editor.ai.draftParagraph's tooltip closely enough " +
          "that the user recognises the same action.",
        maxLength: 22,
      },
      "editor.navTitle.home": {
        description:
          "Label for the app's root route in the back/forward history popover and " +
          "the workspace tab title.",
        screenshot: "workspace-nav",
        maxLength: 20,
      },
      "editor.navTitle.overview": {
        description:
          "Label for a member-org's '/overview' landing route in the back/forward " +
          "history popover and the workspace tab title.",
        screenshot: "workspace-nav",
        maxLength: 20,
      },
      "editor.navTitle.adminConsole": {
        description: "Label for the platform admin console route.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.navTitle.sharedWithYou": {
        description: "Label for the page listing projects shared with the current user.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.navTitle.archivedProjects": {
        description: "Label for the archived-projects list within an organization.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.navTitle.assignedToMe": {
        description:
          "Label for the list of work assigned to the current user within an organization.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.navTitle.organizationSettings": {
        description:
          "Label for an organization's settings area when no specific section is open.",
        screenshot: "workspace-nav",
        maxLength: 28,
      },
      "editor.navTitle.membersMatrix": {
        description:
          "Label for the organization members matrix — the per-project role grid view.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.navTitle.members": {
        description: "Label for an organization's member list.",
        screenshot: "workspace-nav",
        maxLength: 20,
      },
      "editor.navTitle.team": {
        description: "Label for a single team's page within an organization.",
        screenshot: "workspace-nav",
        maxLength: 16,
      },
      "editor.navTitle.teams": {
        description: "Label for an organization's list of teams.",
        screenshot: "workspace-nav",
        maxLength: 16,
      },
      "editor.navTitle.projectOverview": {
        description:
          "Label for a single project's overview card page, outside the workspace.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.navTitle.editor": {
        description:
          "Label for the translation editor surface within a project workspace.",
        screenshot: "workspace-nav",
        maxLength: 16,
      },
      "editor.navTitle.projectSettings": {
        description: "Label for a project's settings surface within the workspace.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.navTitle.checksAndRules": {
        description: "Label for the project's translation checks & rules surface.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.navTitle.voice": {
        description: "Label for the project's voice/audio production surface.",
        screenshot: "workspace-nav",
        maxLength: 16,
      },
      "editor.navTitle.projectMembers": {
        description: "Label for a project's member list.",
        screenshot: "workspace-nav",
        maxLength: 24,
      },
      "editor.sync.trafficHistory": { description: "Upload and download activity over the past five minutes. Connection history chart accessible name." },
      "editor.sync.replyHistory": { description: "Observed server replies over the past five minutes. Connection history chart accessible name." },
      "editor.sync.fiveMinutesAgo": { description: "5 min ago. Connection history chart caption." },
      "editor.sync.historyHelp": { description: "5-second averages. Gaps mean no reply was measured. History builds while this tab is open. Connection history chart caption." },
      "editor.sync.activityNow": { description: "Column heading for the last five seconds of traffic and latest server reply." },
      "editor.sync.pastFiveMinutes": { description: "Column heading for rolling five-minute transfer totals and average reply time." },
      "editor.sync.serverReply": { description: "Label for elapsed request-to-response time, including server processing; not network ping." },
      "editor.sync.transferredTotal": { description: "Amount of sync payload transferred during the past five minutes.", placeholders: { amount: "Localized byte quantity including unit, e.g. 12 kB." } },
      "editor.sync.averageReply": { description: "Mean observed server reply time over the past five minutes.", placeholders: { time: "Localized duration including ms unit." } },
      "editor.sync.slowestReply": { description: "Longest observed server reply time during the past five minutes.", placeholders: { time: "Localized duration including ms unit." } },
      "editor.sync.replyJustNow": { description: "Freshness label when the last observed server reply arrived under one second ago." },
      "editor.sync.requestCount": { description: "Number of completed sync HTTP requests in the past five minutes, including failures.", placeholders: { count: "Number of observed completed HTTP requests." } },
      "editor.sync.failureCount": { description: "Number of transport failures or HTTP error responses in the past five minutes. Not lost edits.", placeholders: { count: "Number of failed requests; zero is shown as 0 failed." } },
      "editor.sync.replySecondsAgo": { description: "Age of the most recent observed server reply in seconds.", placeholders: { count: "Whole elapsed seconds." } },
      "editor.sync.replyMinutesAgo": { description: "Age of the most recent observed server reply in minutes.", placeholders: { count: "Whole elapsed minutes." } },
      "editor.sync.connection": { description: "Connection popover connection label for observed sync activity." },
      "editor.sync.upload": { description: "Connection popover upload label for observed sync activity." },
      "editor.sync.download": { description: "Connection popover download label for observed sync activity." },
      "editor.sync.responseTime": { description: "Connection popover responseTime label for observed sync activity." },
      "editor.sync.ping": { description: "Tile label in the connection popover for the averaged server reply time.", maxLength: 10 },
      "editor.sync.connectionDetails": { description: "Title of the dialog with full sync telemetry: history chart, totals, request counts." },
      "editor.sync.showDetails": { description: "Accessible name of the (i) button in the connection popover that opens the details dialog." },
      "editor.sync.qualityGood": { description: "Latency band shown beside the median server reply time when replies are under 300 ms.", maxLength: 8 },
      "editor.sync.qualityFair": { description: "Latency band shown beside the median server reply time when replies are between 300 ms and 1 s.", maxLength: 8 },
      "editor.sync.qualitySlow": { description: "Latency band shown beside the median server reply time when replies are 1 s or longer.", maxLength: 8 },
      "editor.sync.noActivity": { description: "Connection popover noActivity label for observed sync activity." },
      "editor.sync.waitingForActivity": { description: "Connection popover waitingForActivity label for observed sync activity." },
      "editor.sync.activityHelp": { description: "Plain-language explanation of passively observed sync payload rates and request response times." },
      "editor.sync.live": {
        description:
          "Label of the per-file sync status chip in the editor header when the " +
          "websocket connection to the sync server is up and the initial sync has " +
          "completed. A state adjective beside a colored dot.",
        maxLength: 12,
      },
      "editor.sync.liveTooltip": {
        description: "Tooltip/aria-label of the sync chip in the editor.sync.live state.",
      },
      "editor.sync.syncing": {
        description:
          "Label of the sync status chip while queued local edits are still being " +
          "sent to the server and no attempt has failed yet. A state adjective " +
          "beside a colored dot.",
        maxLength: 12,
      },
      "editor.sync.syncingTooltip": {
        description: "Tooltip/aria-label of the sync chip in the editor.sync.syncing state.",
      },
      "editor.sync.retrying": {
        description:
          "Label of the sync status chip when queued local edits exist and the last " +
          "attempt to send them failed; the app keeps retrying automatically.",
        maxLength: 12,
      },
      "editor.sync.retryingTooltip": {
        description: "Tooltip/aria-label of the sync chip in the editor.sync.retrying state.",
      },
      "editor.sync.reconnecting": {
        description:
          "Label of the sync status chip when the browser is online but the live " +
          "websocket connection to the sync server is currently closed and being re-established.",
        maxLength: 14,
      },
      "editor.sync.reconnectingTooltip": {
        description: "Tooltip/aria-label of the sync chip in the editor.sync.reconnecting state.",
      },
      "editor.sync.connecting": {
        description:
          "Label of the sync status chip while the websocket connection to the sync " +
          "server is being established.",
        maxLength: 16,
      },
      "editor.sync.connectingTooltip": {
        description: "Tooltip/aria-label of the sync chip in the editor.sync.connecting state.",
      },
      "editor.sync.offline": {
        description:
          "Label of the sync status chip after a previously-live connection has " +
          "dropped and the app is retrying with backoff.",
        maxLength: 12,
      },
      "editor.sync.offlineTooltip": {
        description: "Tooltip/aria-label of the sync chip in the editor.sync.offline state.",
      },
      "editor.sync.paused": {
        description:
          "Label of the sync status chip when the connection was deliberately " +
          "dropped because the browser tab is hidden — resumes automatically when " +
          "the user returns to the tab. Distinct from autopilot.status.paused, " +
          "which is an autopilot run a person paused; this is the app pausing an " +
          "idle connection, not a person pausing work.",
        maxLength: 12,
      },
      "editor.sync.pausedTooltip": {
        description: "Tooltip/aria-label of the sync chip in the editor.sync.paused state.",
      },
      "editor.sync.noFileOpen": {
        description:
          "Label of the sync status chip when there is nothing open to sync yet — " +
          "no session, no project/file selected, or sync turned off.",
        maxLength: 16,
      },
      "editor.sync.noFileOpenTooltip": {
        description: "Tooltip/aria-label of the sync chip in the editor.sync.noFileOpen state.",
      },
      "editor.outbox.backlogLabel": {
        description:
          "Short chip text when queued local writes are retrying but have failed " +
          "several times in a row (not yet permanent failures).",
        maxLength: 16,
      },
      "editor.outbox.queuedLabel": {
        description:
          "Short chip text showing how many local writes are queued to sync to the " +
          "server. Same implicit-noun shape as editor.outbox.failedLabel.",
        placeholders: { count: "Number of local writes waiting to sync." },
        maxLength: 16,
      },
      "editor.outbox.syncedLabel": {
        description:
          "Short chip text when the outbox is empty — everything has synced. " +
          "Always visible (not just on failure) so the chip doubles as reassurance.",
        maxLength: 12,
      },
      "editor.outbox.failedTooltip": {
        description:
          "Tooltip/aria-label of the outbox chip in its failed state. Full " +
          "sentence(s); the second sentence is the same 'click to inspect' " +
          "invitation on every outbox tooltip.",
        placeholders: { count: "Number of writes that permanently failed to sync." },
      },
      "editor.outbox.backlogTooltip": {
        description:
          "Tooltip/aria-label of the outbox chip in its backlog (retrying) state. " +
          "Reassures that edits are safe locally before inviting a click.",
      },
      "editor.outbox.queuedTooltip": {
        description:
          "Tooltip/aria-label of the outbox chip in its queued state.",
        placeholders: { count: "Number of local writes waiting to sync." },
      },
      "editor.outbox.syncedTooltip": {
        description:
          "Tooltip/aria-label of the outbox chip when the queue is empty.",
      },
      // AQU-646, keyed 2026-08-20 — the audio-VTT import dialog, the character-
      // sheet import dialog, the character-check drawer and the pairing drawer.
      // Only the classes that require their own entry (a `{placeholder}` to
      // explain, or a count-governed `plural()`); the rest of that batch
      // inherits the namespace description above.
      "editor.timeline.audioVttDescription": {
        description:
          "Explanatory paragraph under the title of the 'import an audio VTT' " +
          "dialog. Says what the import adds (a read-only track of the film's " +
          "spoken dialogue) and, just as importantly, what it does NOT touch.",
        placeholders: {
          fileName: "Name of the text file the track attaches to, e.g. 'ep101.vtt'. Content — never translate it.",
        },
      },
      "editor.timeline.audioVttCueSummary": {
        description:
          "One line under the picked file's name summarising what was read out of " +
          "it: how many cues, and the stretch of film they cover. Not a sentence.",
        placeholders: {
          count: "Number of timed cues found in the file.",
          span: "The stretch the cues cover, already formatted as two clock times joined by an en dash, e.g. '0:00 – 45:12'.",
        },
      },
      "editor.timeline.audioVttRepairedShortForm": {
        description:
          "Note under the file summary: some timestamps were written in a short " +
          "form and were read as minutes and seconds rather than hours and minutes.",
        placeholders: { count: "Number of timestamps read that way." },
      },
      "editor.timeline.audioVttStrippedTags": {
        description:
          "Note under the file summary: styling markup inside the cues was " +
          "discarded, keeping only the words.",
        placeholders: { count: "Number of cues that had formatting removed." },
      },
      "editor.timeline.audioVttDroppedCues": {
        description:
          "Note under the file summary: some cues had a timestamp but no words, so " +
          "they were left out.",
        placeholders: { count: "Number of cues skipped for having no text." },
      },
      "editor.timeline.audioVttTimebaseFyi": {
        description:
          "Quiet one-line note in the import dialog when a timing correction was " +
          "detected and will be applied automatically. Informational only — there " +
          "is no choice to make and no technical detail to convey.",
        placeholders: {
          fileName: "Name of the text file the cues will be lined up with. Content — never translate it.",
        },
      },
      "editor.timeline.audioVttReconcileNoop": {
        description:
          "Shown when the picked file holds exactly the cues the timeline already " +
          "has, on the same timings: there is simply nothing to do.",
        placeholders: { count: "Number of cues, which is the same on both sides." },
      },
      "editor.timeline.audioVttKeptOfTotal": {
        description:
          "Bold fraction naming how many of the incoming cues are ones the " +
          "timeline already has. Not a sentence — it opens a longer one.",
        placeholders: {
          kept: "Number of cues that already exist and are kept.",
          total: "Number of cues in the file being imported.",
        },
      },
      "editor.timeline.audioVttReconcileKept": {
        description:
          "What an update does to the cues already on the timeline: they keep " +
          "their identity, and therefore their recordings and their subtitle " +
          "pairings. The sentence may be continued by further clauses.",
        placeholders: {
          kept: "The bold fraction, already phrased as '540 of 550 cues'.",
        },
      },
      "editor.timeline.audioVttKeptIncluding": {
        description:
          "Clause appended to the previous sentence when recordings hang off the " +
          "kept cues — the thing people most want to know survives. Opens with an " +
          "em dash because it continues the sentence before it.",
        placeholders: {
          takes: "The number of recordings, already phrased as '12 recordings' and shown in bold.",
        },
      },
      "editor.timeline.audioVttRecordingCount": {
        description:
          "A count of recorded takes, shown in bold inside a longer sentence. " +
          "Just the number and the noun.",
        placeholders: { count: "Number of recordings." },
      },
      "editor.timeline.audioVttRetimeShift": {
        description:
          "Clause appended to the update summary when some kept cues move in " +
          "time. States the largest move, so the reader can judge whether it matters.",
        placeholders: {
          count: "Number of cues whose timing changes.",
          seconds: "The biggest move in seconds, already rounded to one decimal place.",
        },
      },
      "editor.timeline.audioVttCreates": {
        description:
          "Part of the update summary: cues in the picked file that the timeline " +
          "does not have yet and that will be added.",
        placeholders: { count: "Number of cues being added." },
      },
      "editor.timeline.audioVttDeletes": {
        description:
          "Part of the update summary: cues the timeline has that the picked file " +
          "no longer contains, and which will therefore be taken away.",
        placeholders: { count: "Number of cues being removed." },
      },
      "editor.timeline.audioVttOrphanLead": {
        description:
          "Bold warning clause: recordings are attached to cues that this update " +
          "would remove. Not a sentence — the consequence follows it.",
        placeholders: { count: "Number of recordings sitting on cues that are going away." },
      },
      "editor.timeline.audioVttOrphanWarning": {
        description:
          "The full warning about recordings attached to cues an update would " +
          "remove. Says plainly that the audio is kept but nothing will be able to " +
          "reach it — 'lost' and 'out of reach' call for different amounts of nerve.",
        placeholders: {
          lead: "The bold opening clause, already phrased as '3 recordings sit on a cue that is going away'.",
        },
      },
      "editor.timeline.audioVttRemoveLead": {
        description:
          "The question asked by the second step of removing the audio track, " +
          "naming the file and what goes with the track.",
        placeholders: {
          fileName: "Name of the text file losing its audio track. Content — never translate it.",
          count: "Number of cues that would be removed.",
        },
      },
      "editor.timeline.audioVttRemoveTakesLead": {
        description:
          "Bold clause in the removal confirmation: recordings are attached to the " +
          "cues being removed. Not a sentence — the consequence follows it.",
        placeholders: { count: "Number of recordings attached to the cues." },
      },
      "editor.timeline.audioVttRemoveTakes": {
        description:
          "The consequence of removing cues that carry recordings: the audio is " +
          "retained on the server but nothing in the app could show it again.",
        placeholders: {
          lead: "The bold opening clause, already phrased as '7 recordings sit on those cues'.",
        },
      },
      "editor.timeline.audioVttUpdateCues": {
        description:
          "Confirm button of the audio-VTT dialog when the import will UPDATE the " +
          "cues already on the timeline rather than create a new track.",
        placeholders: { count: "Number of cues that will be updated." },
      },
      "editor.timeline.audioVttImportCues": {
        description:
          "Confirm button of the audio-VTT dialog when the import will create the " +
          "track for the first time.",
        placeholders: { count: "Number of cues that will be imported." },
      },
      "editor.timeline.importTooLargeText": {
        description:
          "Inline refusal shown in the dialog when the picked text file is over " +
          "the size limit. '10 MB' is a unit and a number; keep it as it is.",
        placeholders: { fileName: "Name of the file the user picked. Content — never translate it." },
      },
      "editor.timeline.charactersSubtitleLines": {
        description:
          "A count of subtitle lines, used as a fragment inside longer sentences " +
          "about how many lines already carry a character name.",
        placeholders: { count: "Number of subtitle lines." },
      },
      "editor.timeline.charactersHeardLines": {
        description:
          "A count of heard lines — lines of speech in the film's own audio — used " +
          "as a fragment inside longer sentences.",
        placeholders: { count: "Number of heard lines." },
      },
      "editor.timeline.charactersBothSides": {
        description:
          "Joins the two counts when both sides of the script have characters, " +
          "e.g. '637 subtitle lines and 548 heard lines'. Only the conjunction and " +
          "the order belong to the translator.",
        placeholders: {
          subtitle: "The subtitle-side count, already phrased as '637 subtitle lines'.",
          audio: "The audio-side count, already phrased as '548 heard lines'.",
        },
      },
      "editor.timeline.charactersImportedSummary": {
        description:
          "Explanatory paragraph of the characters dialog once at least one sheet " +
          "has been imported: what is already there, and the two things that can " +
          "be done about it.",
        placeholders: {
          summary: "What is already there, already phrased as e.g. '637 subtitle lines and 548 heard lines'.",
        },
      },
      "editor.timeline.charactersImportHint": {
        description:
          "Explanatory paragraph of the characters dialog before anything has been " +
          "imported: what the spreadsheet has to look like and how its rows are " +
          "matched to the file's lines.",
        placeholders: {
          fileName: "Name of the file gaining characters. Content — never translate it.",
        },
      },
      "editor.timeline.charactersWrongKindAudio": {
        description:
          "Refusal shown when the sheet picked under the AUDIO button is really " +
          "the subtitle sheet — its rows line up with the subtitles instead. Says " +
          "outright that the other button will work, because nothing is wrong " +
          "with the file.",
        placeholders: {
          sheet: "Which sheet this actually is, already phrased as 'subtitle character sheet' and shown in bold.",
        },
      },
      "editor.timeline.charactersWrongKindSubtitle": {
        description:
          "Refusal shown when the sheet picked under the SUBTITLE button is really " +
          "the audio sheet — its rows line up with the heard lines instead. Says " +
          "outright that the other button will work, because nothing is wrong " +
          "with the file.",
        placeholders: {
          sheet: "Which sheet this actually is, already phrased as 'audio character sheet' and shown in bold.",
        },
      },
      "editor.timeline.charactersMismatchLeadAudio": {
        description:
          "Bold opening of the refusal when rows of an AUDIO character sheet match " +
          "no heard line in the file. Not a sentence — the rest follows after a dash.",
        placeholders: {
          count: "Number of spreadsheet rows that matched nothing.",
          fileName: "Name of the file the sheet was checked against. Content — never translate it.",
        },
      },
      "editor.timeline.charactersMismatchLeadSubtitle": {
        description:
          "Bold opening of the refusal when rows of a SUBTITLE character sheet " +
          "match no line in the file. Not a sentence — the rest follows after a dash.",
        placeholders: {
          count: "Number of spreadsheet rows that matched nothing.",
          fileName: "Name of the file the sheet was checked against. Content — never translate it.",
        },
      },
      "editor.timeline.charactersMismatch": {
        description:
          "The full refusal when a character sheet's rows match nothing: it almost " +
          "always means the spreadsheet belongs to a different episode. Ends by " +
          "reassuring that nothing was written.",
        placeholders: {
          lead: "The bold opening clause naming how many rows matched nothing and in which file.",
          row: "The number of the first spreadsheet row that matched nothing, so it can be looked up.",
        },
      },
      "editor.timeline.charactersAssignedLeadAudio": {
        description:
          "Bold clause in the go-ahead summary for an AUDIO character sheet: how " +
          "many heard lines gain a character. Not a sentence.",
        placeholders: { count: "Number of heard lines that will be given a character." },
      },
      "editor.timeline.charactersAssignedLeadSubtitle": {
        description:
          "Bold clause in the go-ahead summary for a SUBTITLE character sheet: how " +
          "many lines gain a character. Not a sentence.",
        placeholders: { count: "Number of lines that will be given a character." },
      },
      "editor.timeline.charactersAssignedSummary": {
        description:
          "The go-ahead summary of a character import: how many lines are affected, " +
          "how many distinct people appear, and that the camera column comes across too.",
        placeholders: {
          lead: "The bold opening clause, already phrased as e.g. '548 heard lines get a character'.",
          people: "How many different characters appear across the sheet.",
        },
      },
      "editor.timeline.charactersBlankRows": {
        description:
          "Note in the go-ahead summary: rows with no character in them are passed " +
          "over. Usually on-screen text rather than speech, hence the example.",
        placeholders: { count: "Number of spreadsheet rows with no character name." },
      },
      "editor.timeline.charactersWithoutRowAudio": {
        description:
          "Note in the go-ahead summary for an AUDIO sheet: heard lines the " +
          "spreadsheet says nothing about are left exactly as they are.",
        placeholders: { count: "Number of heard lines absent from the sheet." },
      },
      "editor.timeline.charactersWithoutRowSubtitle": {
        description:
          "Note in the go-ahead summary for a SUBTITLE sheet: lines the " +
          "spreadsheet says nothing about are left exactly as they are.",
        placeholders: { count: "Number of lines absent from the sheet." },
      },
      "editor.timeline.charactersFilledByPosition": {
        description:
          "Note in the go-ahead summary: some rows did not match their line on " +
          "timestamp, but the lines on either side did, so their place in the order " +
          "settles it.",
        placeholders: { count: "Number of rows matched by their position rather than their timestamp." },
      },
      "editor.timeline.charactersCameraDisagreements": {
        description:
          "Warning in the go-ahead summary: the sheet's Camera column and the " +
          "camera angle written into the character name say different things. " +
          "States which one is used.",
        placeholders: { count: "Number of rows where the two disagree." },
      },
      "editor.timeline.charactersPickHint": {
        description:
          "Small print under the two file-picking buttons, describing the shape of " +
          "the spreadsheet and the file types accepted. '.xlsx' and '.csv' are file " +
          "extensions — never translate them.",
        placeholders: {
          fileName: "Name of the file gaining characters. Content — never translate it.",
        },
      },
      "editor.timeline.charactersAlreadyHave": {
        description:
          "Reminder beside the file-picking buttons that characters are already " +
          "present, so picking a sheet will replace a side rather than fill an " +
          "empty one.",
        placeholders: {
          summary: "What is already there, already phrased as e.g. '637 subtitle lines and 548 heard lines'.",
        },
      },
      "editor.timeline.charactersClearSubtitleBody": {
        description:
          "The consequence spelled out in the 'clear the subtitle characters' " +
          "confirmation. Says outright that hand corrections go too, because this " +
          "empties the field rather than undoing the import.",
        placeholders: { count: "Number of lines that would be emptied." },
      },
      "editor.timeline.charactersClearAudioBody": {
        description:
          "The consequence spelled out in the 'clear the heard-line characters' " +
          "confirmation. A following sentence says what those lines will show instead.",
        placeholders: { count: "Number of heard lines that would be emptied." },
      },
      "editor.timeline.charactersAssignCount": {
        description:
          "Confirm button of the characters dialog once a sheet has been read and " +
          "accepted, naming how many lines it will write to.",
        placeholders: { count: "Number of lines that will be given a character." },
      },
      "editor.timeline.importTooLargeSheet": {
        description:
          "Inline refusal shown in the dialog when the picked spreadsheet is over " +
          "the size limit. '10 MB' is a unit and a number; keep it as it is.",
        placeholders: { fileName: "Name of the file the user picked. Content — never translate it." },
      },
      "editor.timeline.characterCheckSpeakerSettled": {
        description:
          "Small note on a half-decided row of the character-check drawer: the " +
          "speaker question has been answered, and this is the answer that was " +
          "NOT taken — kept visible so the decision can be reversed.",
        placeholders: { rejected: "The character name that was set aside. Content — never translate it." },
      },
      "editor.timeline.characterCheckCameraSettled": {
        description:
          "Small note on a half-decided row of the character-check drawer: the " +
          "camera question has been answered, and this is the answer that was NOT " +
          "taken — kept visible so the decision can be reversed.",
        placeholders: { rejected: "The camera state that was set aside, e.g. 'on' or 'off', already translated." },
      },
      "editor.timeline.characterCheckSaving": {
        description:
          "Progress text beside a spinner in the character-check drawer's header " +
          "while decisions are being written one at a time. Deliberately counted " +
          "rather than a bare spinner, because a long run reads as hung.",
        placeholders: {
          done: "How many writes have finished.",
          total: "How many writes there are in all.",
        },
      },
      "editor.timeline.characterCheckToCheck": {
        description:
          "Counter in the character-check drawer's header: how many disagreements " +
          "are still open. Lower case — it sits beside the drawer's title.",
        placeholders: { count: "Number of open disagreements." },
      },
      "editor.timeline.characterCheckNamesTitle": {
        description:
          "Heading of the section listing lines whose two character sheets name " +
          "different speakers, with the count after a middle dot.",
        placeholders: { count: "Number of lines in this section." },
      },
      "editor.timeline.characterCheckCameraTitle": {
        description:
          "Heading of the section listing lines whose two character sheets " +
          "disagree about the camera, with the count after a middle dot.",
        placeholders: { count: "Number of lines in this section." },
      },
      "editor.timeline.characterCheckBulkConfirm": {
        description:
          "The 'are you sure' before applying one sheet's camera answer to every " +
          "disputed line at once. Reassures that each one stays reversible.",
        placeholders: {
          side: "Which sheet's answer would be used — the lower-case word 'subtitle' or 'audio', matching the two column headings.",
          count: "Number of lines the sweep would settle.",
        },
      },
      "editor.timeline.characterCheckBulkGo": {
        description:
          "The button that carries out the bulk camera decision. Short on purpose " +
          "— the drawer is narrow and the column headings above carry the meaning.",
        placeholders: {
          side: "Which sheet's answer wins — the lower-case word 'subtitle' or 'audio', matching the two column headings.",
        },
      },
      "editor.timeline.characterCheckBulkAll": {
        description:
          "Label in front of the two bulk-decision buttons, naming how many lines " +
          "they would settle. Ends with a colon because the buttons follow it.",
        placeholders: { count: "Number of lines the bulk buttons would settle." },
      },
      "editor.timeline.characterCheckShared": {
        description:
          "A statement of fact rather than a job: some subtitle rows cover several " +
          "heard lines at once, so no single character name could be right for all " +
          "of them. Ends by saying plainly that there is nothing to do.",
        placeholders: { count: "Number of pairings in this situation." },
      },
      "editor.timeline.characterCheckResolvedToggle": {
        description:
          "The collapsed section holding settled disagreements, with its count " +
          "after a middle dot. Clicking it opens the list.",
        placeholders: { count: "Number of settled disagreements." },
      },
      "editor.timeline.characterCheckResetConfirm": {
        description:
          "The 'are you sure' before undoing every settled disagreement at once. " +
          "Says that both original answers come back and that nothing is destroyed.",
        placeholders: { count: "Number of settled disagreements that would be reopened." },
      },
      "editor.timeline.cueLinkToReview": {
        description:
          "Counter in the pairing drawer's header: how many pairings are worth a " +
          "look. Lower case — it sits beside the drawer's title.",
        placeholders: { count: "Number of pairings worth reviewing." },
      },
      "editor.timeline.cueLinkOrphanCues": {
        description:
          "A collapsed count at the foot of the pairing drawer: heard lines with " +
          "no subtitle anywhere near them, which is usually nothing to act on. " +
          "Clicking it lists them.",
        placeholders: { count: "Number of heard lines with no nearby subtitle." },
      },
      "editor.timeline.cueLinkOrphanText": {
        description:
          "A collapsed count at the foot of the pairing drawer: subtitle lines " +
          "with no speech anywhere near them. Clicking it lists them.",
        placeholders: { count: "Number of subtitle lines with no nearby speech." },
      },
    },
  },
  surfaces: [
    {
      id: "editor-table",
      title: "Editing table",
      route: "/project/:projectId/editor",
      notes:
        "The main translation screen: one row per cell, source on one side and the " +
        "editable target on the other, with a narrow action rail of icon buttons " +
        "between them and status badges above. Almost every string here shares its " +
        "row with translation content, so a translation much longer than the " +
        "English will push controls out of view or truncate. Many labels are both " +
        "the visible text and the button's screen-reader name.",
    },
  ],
})
