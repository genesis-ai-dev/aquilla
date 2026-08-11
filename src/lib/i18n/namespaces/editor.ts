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

    // — Per-cell audio: record / upload / playback ——————————————————
    "editor.audio.record": "Record audio",
    "editor.audio.recordingDisabled": "Recording disabled",
    "editor.audio.micBlockedTooltip": "Microphone access blocked — click for help",
    "editor.audio.micBlockedTitle": "Microphone blocked",
    "editor.audio.micBlockedHelp":
      "Open your browser's site settings (🔒 in the address bar) and allow " +
      "microphone access, then reload the page.",

    // — Per-cell actions menu (ellipsis popover) ——————————————————
    "editor.cell.moreActions": "More actions",
    "editor.cell.addComment": "Add comment",
    "editor.cell.reRecord": "Re-record audio",
    "editor.cell.transcribe": "Transcribe with Whisper",
    "editor.cell.generateVoice": "Generate AI voice",
    "editor.cell.generateVoiceReplace": "Generate AI voice (replaces audio)",
    "editor.cell.historyCount": "History ({count})",
    "editor.cell.generateBacktranslation": "Generate backtranslation",
    "editor.cell.regenerateBacktranslation": "Regenerate backtranslation",
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

    // — Column names, reused wherever the two sides are named ——————————
    "editor.column.source": "Source",
    "editor.column.target": "Target",

    // — View-settings popover ————————————————————————————————————————
    "editor.view.settings": "Editor settings",
    "editor.view.showLineNumbers": "Show line numbers",
    "editor.view.showCellLabels": "Show cell labels",
    "editor.view.showTranslationNotes": "Show translation notes",
    "editor.view.footnotesHidden": "Hidden",
    "editor.view.footnotesInline": "Inline under cells",
    "editor.view.footnotesTray": "Bottom tray",
    "editor.view.textDirection": "Text Direction",
    "editor.view.fontSize": "Font Size",
    "editor.view.directionAuto": "Auto",
    "editor.view.directionOf": "{side} direction",
    "editor.view.decreaseFontSize": "Decrease {side} font size",
    "editor.view.increaseFontSize": "Increase {side} font size",
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
    "editor.selection.removeMyValidations": "Remove my validations",
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

    // — Attach-video dialog for a timed file ————————————————————————
    "editor.video.title": "Attach Video",
    "editor.video.currentlyAttached": "Currently attached",
    "editor.video.removeAttachment": "Remove attachment",
    "editor.video.startOffset": "Start offset (s)",
    "editor.video.saveOffset": "Save offset",
    "editor.video.offsetHint":
      "Seconds to wait before cues align. If your video has an intro, set this to " +
      "the duration of the intro so subtitles line up correctly.",
    "editor.video.tabUrl": "From URL",
    "editor.video.tabUpload": "Upload file",
    "editor.video.urlLabel": "Video URL",
    "editor.video.urlHint":
      "Direct video URL (MP4, WebM, etc). URL syncs across collaborators.",
    "editor.video.displayNameLabel": "Display name (optional)",
    "editor.video.displayNamePlaceholder": "Episode 1",
    "editor.video.saveUrl": "Save URL",
    "editor.video.enterUrl": "Enter a video URL",
    "editor.video.storingLocally": "Storing video locally...",
    "editor.video.dropHint": "Drag a video file here, or",
    "editor.video.chooseFile": "Choose file",
    "editor.video.localOnlyHint": "Stored locally on this device only (not synced to peers).",
    "editor.video.uploadedFallbackName": "Uploaded video",

    // — Timeline lens (time-ordered files) ————————————————————————
    "editor.timeline.title": "Timeline",
    "editor.timeline.followPlayhead": "Follow playhead",
    "editor.timeline.linkVideo": "Link video",
    "editor.timeline.changeVideo": "Change video",
    "editor.timeline.coreVideoPrompt": "Core video URL (leave blank to clear)",
    "editor.timeline.zoomIn": "Zoom in",
    "editor.timeline.zoomOut": "Zoom out",
    "editor.timeline.laneSubtitle": "Subtitle",
    "editor.timeline.laneSubtitleSub": "text · reading",
    "editor.timeline.laneDialogue": "Dialogue",
    "editor.timeline.laneDialogueSub": "audio · recording",
    "editor.timeline.laneUntimed": "Untimed",
    "editor.timeline.laneUntimedSub": "no timecode",
    "editor.timeline.noUntimedClips": "No untimed clips.",

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

    // — Row chrome: numbering, selection, paragraph and timing markers ——
    "editor.row.noTimingAria": "No specific timing — ordered by sequence",
    "editor.row.noTimingBadge": "no timing",
    "editor.row.newParagraph": "New paragraph",
    "editor.row.lineAria": "Line {number}",
    "editor.row.cellAria": "{ref} cell",
    "editor.row.rowFallbackRef": "row {index}",
    "editor.row.editorAria": "{ref} — {state}",
    "editor.row.selectedTooltip": "Selected. Drag up or down to extend the range.",
    "editor.row.selectTooltip": "Select cell. Drag up or down to select a range.",
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
    "editor.lane.showArchived": "Show archived ({count})",
    "editor.empty.noMediaSegments": "No media segments yet",
    "editor.empty.noTextSegments": "No text segments in this file",
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
      "An AI reading of your translation back in your reference language. Use it " +
      "to check the meaning carried over — the AI can misread, so treat it as a " +
      "second opinion, not proof.",
    "editor.bt.needsAiTooltip":
      "Sign in or add an AI model in project settings to generate back-translations",
    "editor.bt.regenerateTooltip": "Regenerate with AI",
    "editor.bt.regenerateAria": "Regenerate the back-translation",
    "editor.bt.editTooltip": "Edit the back-translation",
    "editor.bt.contributorRequired": "Contributor+ required to edit back-translations",
    "editor.bt.translateFirst": "Translate this cell to read it back.",
    "editor.bt.staleWarning": "Your translation changed since this was written",
    "editor.bt.saving": "Saving…",
    "editor.bt.emptyPitch":
      "See what your translation says when read back, so you can check the " +
      "meaning carried over.",
    "editor.bt.readingItBack": "Reading it back…",
    "editor.bt.readItBack": "Read it back with AI",
    "editor.bt.needsAiHint":
      "Sign in or add an AI model in project settings to generate one.",
    "editor.bt.contributorCanGenerate": "A contributor can generate one with AI.",
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

    // — Expansion tabs: issues and metadata ————————————————————————
    "editor.expansion.issues": "Issues",
    "editor.expansion.metadata": "Metadata",
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
      "editor.cell.moreActions": {
        description:
          "Screen-reader name of the ellipsis (…) button in a cell's action rail " +
          "that opens the overflow menu of less-frequent cell actions. Never " +
          "visible; it only needs to be unambiguous when read aloud.",
      },
      "editor.cell.addComment": {
        description:
          "Overflow-menu item that starts a new comment thread on this cell. " +
          "Imperative; 'comment' here means a discussion note between team members " +
          "about the translation, not a footnote in the text.",
        maxLength: 24,
      },
      "editor.cell.reRecord": {
        description:
          "Overflow-menu item shown only when the cell already has audio; it " +
          "re-opens the recording modal to replace the existing take. The 'again' " +
          "sense of the prefix is the point — it discards nothing until the user " +
          "saves a new take.",
        maxLength: 28,
      },
      "editor.cell.transcribe": {
        description:
          "Overflow-menu item that runs speech-to-text on the cell's recording and " +
          "puts the result in the translation field. 'Whisper' is the product name " +
          "of the speech model — keep it untranslated.",
        maxLength: 32,
      },
      "editor.cell.generateVoice": {
        description:
          "Overflow-menu item that synthesizes a spoken recording of the " +
          "translation with a text-to-speech voice. Used when the cell has no audio " +
          "yet, so nothing is at risk.",
        maxLength: 32,
      },
      "editor.cell.generateVoiceReplace": {
        description:
          "The synthesize-voice menu item when the cell ALREADY has a recording: " +
          "the parenthetical is the warning that the existing take will be " +
          "overwritten. Keep the warning; it is the only thing separating this from " +
          "editor.cell.generateVoice.",
      },
      "editor.cell.historyCount": {
        description:
          "Overflow-menu item that opens this cell's edit history, with the number " +
          "of recorded edits in parentheses. 'History' is a noun naming the panel.",
        placeholders: { count: "Number of recorded edits on this cell." },
        maxLength: 24,
      },
      "editor.cell.generateBacktranslation": {
        description:
          "Overflow-menu item that asks the AI to translate the finished target " +
          "text back into the reference language, as a meaning check. Used when no " +
          "back-translation exists yet.",
        maxLength: 32,
      },
      "editor.cell.regenerateBacktranslation": {
        description:
          "The same item when a back-translation already exists and running it " +
          "again will replace it. The 're-' sense must survive translation.",
        maxLength: 32,
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
      "editor.view.directionMismatch": {
        description:
          "Warning bubble beside the settings gear when a column's direction has " +
          "been forced by hand but its actual text runs the other way — so the text " +
          "will look wrong. Two contrasting halves: what was chosen, then what was " +
          "detected. Rendered on one non-wrapping line, so keep it tight.",
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
      "editor.video.title": {
        description:
          "Title of the dialog that links a video to a subtitle/timed file so the " +
          "translator can watch it while timing cues. Title Case in English because " +
          "it is a dialog title. 'Attach' rather than 'upload' — a URL is not copied.",
        maxLength: 24,
      },
      "editor.video.currentlyAttached": {
        description:
          "Muted label above the name of the video already linked to this file. A " +
          "state description, not an action.",
        maxLength: 24,
      },
      "editor.video.removeAttachment": {
        description:
          "Tooltip and screen-reader name of the trash button that unlinks the " +
          "current video. For an uploaded file it also deletes the local copy; for a " +
          "URL nothing at the far end is touched.",
        maxLength: 26,
      },
      "editor.video.startOffset": {
        description:
          "Label of the numeric field holding how many seconds of the video come " +
          "BEFORE the first subtitle cue. The '(s)' is the unit abbreviation for " +
          "seconds — keep an equivalent short unit marker.",
        maxLength: 22,
      },
      "editor.video.saveOffset": {
        description:
          "Small button that stores the start-offset value without changing which " +
          "video is attached. Imperative.",
        maxLength: 18,
      },
      "editor.video.offsetHint": {
        description:
          "Help text under the start-offset field. Two sentences: what the number " +
          "means, then the common case (a title sequence) worked through so the user " +
          "knows what to type. 'Cues' are the timed subtitle entries.",
      },
      "editor.video.tabUrl": {
        description:
          "First of two tabs in the attach-video dialog: link a video already " +
          "hosted somewhere by pasting its address.",
        maxLength: 18,
      },
      "editor.video.tabUpload": {
        description:
          "Second tab: pick a video file from this computer, stored locally in the " +
          "browser rather than on the server.",
        maxLength: 18,
      },
      "editor.video.urlLabel": {
        description:
          "Form label for the field taking the video's web address.",
        maxLength: 18,
      },
      "editor.video.urlHint": {
        description:
          "Help text under the video URL field. Two points: it must be a direct " +
          "link to the video file itself (the formats in parentheses are file-format " +
          "names and stay as-is), and unlike an upload a URL is visible to the rest " +
          "of the team.",
      },
      "editor.video.displayNameLabel": {
        description:
          "Form label for the optional friendly name shown instead of the raw URL. " +
          "The '(optional)' must survive — it is what tells the user they can skip it.",
        maxLength: 28,
      },
      "editor.video.displayNamePlaceholder": {
        description:
          "Example value in the display-name field. It is a sample title, so " +
          "translate it as a plausible episode name in the target language rather " +
          "than as an instruction.",
        maxLength: 20,
      },
      "editor.video.saveUrl": {
        description:
          "Full-width confirming button on the URL tab; it attaches the pasted " +
          "address to the file. Imperative.",
        maxLength: 18,
      },
      "editor.video.enterUrl": {
        description:
          "Validation error under the URL field when the user pressed the button " +
          "with the field empty. Imperative — it says what to do, not what went " +
          "wrong.",
        maxLength: 28,
      },
      "editor.video.storingLocally": {
        description:
          "Status text while the chosen video is being written into this browser's " +
          "local storage. 'Locally' is the reassuring part: nothing is uploaded. " +
          "Trailing three periods are literal in the English source.",
      },
      "editor.video.dropHint": {
        description:
          "Line inside the upload drop zone offering drag-and-drop. It ends with " +
          "'or' on purpose: the file-picker button follows immediately below and " +
          "completes the sentence.",
      },
      "editor.video.chooseFile": {
        description:
          "Button under the drop zone that opens the operating system's file " +
          "picker. Imperative.",
        maxLength: 18,
      },
      "editor.video.localOnlyHint": {
        description:
          "Small print under the upload drop zone. The point is the limitation: an " +
          "uploaded video stays in this browser, so teammates will not see it — " +
          "unlike a URL. 'Peers' means the other people on the project.",
      },
      "editor.video.uploadedFallbackName": {
        description:
          "Stand-in name shown for a locally stored video whose original file name " +
          "was not recorded. A noun phrase, not an action.",
        maxLength: 24,
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
      "editor.timeline.laneDialogue": {
        description:
          "Name of the timeline's second track, holding the spoken recordings. Sits " +
          "in a 128px-wide label column.",
        maxLength: 14,
      },
      "editor.timeline.laneDialogueSub": {
        description:
          "10px sub-label under the Dialogue track name: audio the team records. " +
          "Middle dot separates medium from activity.",
        maxLength: 22,
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
      "editor.timeline.noUntimedClips": {
        description:
          "Tiny (10px) empty state in the untimed area: every clip has timing, so " +
          "nothing is parked. Reassuring, not an error. Full sentence with a period.",
        maxLength: 26,
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
          "Tooltip of the add-person button in the voice card, which turns this " +
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
      "editor.empty.noTextSegments": {
        description:
          "Heading filling the editing area in the text lens when a timed file has " +
          "no text cells. A state, not an error.",
        maxLength: 34,
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
          "The caution after the dash is the important half and must survive.",
      },
      "editor.bt.needsAiTooltip": {
        description:
          "Tooltip on the disabled regenerate button when no AI model is available: " +
          "either nobody is signed in, or the project has no model configured. Both " +
          "routes are offered.",
      },
      "editor.bt.regenerateTooltip": {
        description:
          "Tooltip on the enabled regenerate button; it asks the model to read the " +
          "current translation back again, replacing the existing reading. " +
          "Imperative.",
        maxLength: 24,
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
      "editor.bt.translateFirst": {
        description:
          "Empty state of the back-translation tab when the cell has no translation " +
          "yet: there is nothing to read back. Full sentence.",
      },
      "editor.bt.staleWarning": {
        description:
          "Amber warning inside the back-translation tab: the translation was edited " +
          "after this reading was produced, so the reading may describe older text. " +
          "A Refresh button sits beside it.",
      },
      "editor.bt.saving": {
        description:
          "Label of the back-translation Save button while the edit is being " +
          "written. Present participle — it replaces common.save, so it must be " +
          "clearly a status and not the command.",
        maxLength: 14,
      },
      "editor.bt.emptyPitch": {
        description:
          "Invitation shown when no back-translation exists yet, explaining what the " +
          "feature is for before the user spends a model call on it. One sentence, " +
          "wrapped at about 34 characters, so avoid very long words.",
      },
      "editor.bt.readingItBack": {
        description:
          "Label of the generate button while the model is working. Present " +
          "participle of the same idiom as editor.bt.readItBack.",
        maxLength: 24,
      },
      "editor.bt.readItBack": {
        description:
          "Primary button that generates the first back-translation. 'Read it back' " +
          "is the plain-language version of 'back-translate' — keep it approachable " +
          "rather than technical. Imperative.",
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
