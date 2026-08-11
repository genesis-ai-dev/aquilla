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

import { defineNamespace } from "./types"

export const editor = defineNamespace({
  keys: {
    // — Lens switch (text vs audio/media) ————————————————————————————
    "editor.lens.text": "Text",

    // — Batch AI translation banner ————————————————————————————————
    "editor.completion.translating": "Translating",
    "editor.completion.stop": "Stop translating",
    "editor.completion.cancelling": "cancelling…",
    "editor.completion.failed": "{failed} of {total} cells failed.",
    "editor.completion.failedPartial":
      "{failed} of {total} cells failed — {done} completed.",

    // — Health / decay breakdown popover ——————————————————————————
    "editor.health.needsAttention": "{percent}% of cells need attention",
    "editor.health.noneNeedAttention": "No cells need attention.",
    "editor.health.biggestDrags": "Biggest drags",
    "editor.health.staleSourceOne": "{count} cell with stale source",
    "editor.health.staleSourceMany": "{count} cells with stale source",

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
    "editor.cell.transcribing": "Transcribing…",
    "editor.cell.generateVoice": "Generate AI voice",
    "editor.cell.generateVoiceReplace": "Generate AI voice (replaces audio)",
    "editor.cell.synthesizing": "Synthesizing…",
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
    "editor.audio.uploading": "Uploading…",
    "editor.audio.uploadFailed": "Upload failed",
    "editor.audio.uploadSignIn": "Sign in to upload recordings",
    "editor.audio.pause": "Pause",

    // — Audio crop popover ————————————————————————————————————————
    "editor.crop.open": "Crop audio",
    "editor.crop.title": "Crop",
    "editor.crop.reset": "Reset to full clip",
    "editor.crop.resetShort": "Reset",
    "editor.crop.start": "Crop start",
    "editor.crop.end": "Crop end",
    "editor.crop.preview": "Preview",

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
    "editor.milestone.region": "Milestone navigation",
    "editor.milestone.moveBetween": "Move between {plural}",
    "editor.milestone.previous": "Previous {singular}",
    "editor.milestone.next": "Next {singular}",
    "editor.milestone.current": "Current {singular}: {label}. Choose {singular}",
    "editor.milestone.currentWithCells":
      "Current {singular}: {label}, cells {cells}. Choose {singular}",
    "editor.milestone.findPlaceholder": "Find a {singular}…",
    "editor.milestone.find": "Find a {singular}",
    "editor.milestone.empty": "No {plural} found.",
    "editor.milestone.cellRange": "Cells {range}",
    "editor.milestone.percentTranslated": "{percent}% translated",
    "editor.milestone.percentValidated": "{percent}% validated",
    "editor.milestone.vocab.chapter": "chapter",
    "editor.milestone.vocab.chapterPlural": "Chapters",
    "editor.milestone.vocab.slide": "slide",
    "editor.milestone.vocab.slidePlural": "Slides",
    "editor.milestone.vocab.story": "story",
    "editor.milestone.vocab.storyPlural": "Stories",
    "editor.milestone.vocab.section": "section",
    "editor.milestone.vocab.sectionPlural": "Sections",
    "editor.milestone.vocab.timeRange": "time range",
    "editor.milestone.vocab.timeRangePlural": "Time ranges",
    "editor.milestone.vocab.part": "part",
    "editor.milestone.vocab.partPlural": "Parts",
    "editor.milestone.vocab.group": "group",
    "editor.milestone.vocab.groupPlural": "Groups",
    "editor.milestone.vocab.milestone": "milestone",
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
    "editor.ebible.matchedOne": "{count} verse matched",
    "editor.ebible.matchedMany": "{count} verses matched",
    "editor.ebible.conflictsOne": "{count} conflict (existing target content)",
    "editor.ebible.conflictsMany": "{count} conflicts (existing target content)",
    "editor.ebible.orphansOne": "{count} orphan",
    "editor.ebible.orphansMany": "{count} orphans",
    "editor.ebible.selectedCount": "{selected} / {total} selected",
    "editor.ebible.willOverwrite": "({count} will overwrite existing content)",
    "editor.ebible.selectAll": "All",
    "editor.ebible.selectClean": "Clean only",
    "editor.ebible.noMatches":
      "No source cells matched — the eBible translation may use different book " +
      "references.",
    "editor.ebible.orphanSummaryOne":
      "{count} orphan verse (in eBible but no matching source cell)",
    "editor.ebible.orphanSummaryMany":
      "{count} orphan verses (in eBible but no matching source cell)",
    "editor.ebible.andMore": "…and {count} more",
    "editor.ebible.unmatchedOne": "{count} source cell had no matching eBible verse.",
    "editor.ebible.unmatchedMany": "{count} source cells had no matching eBible verse.",
    "editor.ebible.applyOne": "Apply {count} verse",
    "editor.ebible.applyMany": "Apply {count} verses",
    "editor.ebible.conflictBadge": "conflict",
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
      "editor.completion.cancelling": {
        description:
          "Status text replacing the stop button after the user asked to stop, " +
          "while in-flight cells finish. Deliberately lowercase in English " +
          "because it sits mid-row as a quiet aside; follow whatever the target " +
          "language does for such inline status text.",
        maxLength: 18,
      },
      "editor.completion.failed": {
        description:
          "Summary sentence replacing the progress bar when a batch AI translation " +
          "run finished and every attempted cell failed. Full sentence with a " +
          "period. Honest failure reporting, so do not soften it.",
        placeholders: {
          failed: "Number of cells that could not be translated.",
          total: "Number of cells the run attempted in total.",
        },
      },
      "editor.completion.failedPartial": {
        description:
          "Same summary as editor.completion.failed but for a partially successful " +
          "run: some cells failed and some were drafted. Full sentence with a " +
          "period; the dash separates the failure count from the success count.",
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
      "editor.health.staleSourceOne": {
        description:
          "Singular form of the amber warning row in the health popover counting " +
          "cells whose pinned source text has changed since the translation was " +
          "last revised. Only ever rendered with count = 1.",
        placeholders: { count: "Always the number 1 for this form." },
      },
      "editor.health.staleSourceMany": {
        description:
          "Plural form of the amber warning row in the health popover counting " +
          "cells whose pinned source text has changed since the translation was " +
          "last revised. Rendered for any count other than 1, including 0.",
        placeholders: {
          count: "Number of cells whose source has advanced past the translation.",
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
      "editor.cell.transcribing": {
        description:
          "The same menu item's label while transcription is running; the item is " +
          "disabled. Present-participle status text, not a command.",
        maxLength: 24,
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
      "editor.cell.synthesizing": {
        description:
          "The synthesize-voice menu item's label while text-to-speech is running; " +
          "the item is disabled. Present-participle status text.",
        maxLength: 24,
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
      "editor.audio.uploading": {
        description:
          "The upload button's tooltip while the chosen audio file is being sent to " +
          "storage. Present-participle status text.",
        maxLength: 18,
      },
      "editor.audio.uploadFailed": {
        description:
          "Bold heading of the small popover shown when attaching an audio file " +
          "failed; the underlying error message appears beneath it in English. A " +
          "short state phrase, not a sentence.",
        maxLength: 24,
      },
      "editor.audio.uploadSignIn": {
        description:
          "Error shown in that popover when the user is signed out: uploading a " +
          "recording needs an account. Imperative sentence telling them what to do, " +
          "not an accusation.",
      },
      "editor.audio.pause": {
        description:
          "Label/tooltip of the transport button while a clip is playing; pressing " +
          "it halts playback where it is (it does not stop and rewind). Imperative " +
          "verb, shown in place of Play.",
        maxLength: 12,
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
      "editor.crop.resetShort": {
        description:
          "Visible 11px label of that same reset control, beside a counter-clockwise " +
          "arrow icon; editor.crop.reset is its longer accessible name. Extremely " +
          "tight — one short word.",
        maxLength: 10,
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
      "editor.crop.preview": {
        description:
          "Button in the crop popover that plays the cropped selection so the user " +
          "can hear the result before keeping it. Swaps to editor.audio.pause while " +
          "playing. Imperative verb.",
        maxLength: 12,
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
            "come from the project's data — do not translate the substituted value.",
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
          "editor header that moves between the file's major divisions. It is " +
          "generic because the divisions differ by file type (chapters, slides, " +
          "stories…); the specific words come from the editor.milestone.vocab.* keys.",
      },
      "editor.milestone.moveBetween": {
        description:
          "Screen-reader name of the button group holding the previous/next arrows " +
          "and the picker.",
        placeholders: {
          plural:
            "Lower-cased plural noun for this file's divisions, from " +
            "editor.milestone.vocab.*Plural — e.g. 'chapters', 'slides'.",
        },
      },
      "editor.milestone.previous": {
        description:
          "Screen-reader name of the left-arrow button; it steps back one division " +
          "(or one cell range within a split division). Icon-only, so this string " +
          "is the only name it has.",
        placeholders: {
          singular:
            "Singular noun for this file's divisions, from editor.milestone.vocab.* " +
            "— e.g. 'chapter', 'slide'.",
        },
      },
      "editor.milestone.next": {
        description:
          "Screen-reader name of the right-arrow button; it steps forward one " +
          "division. Icon-only, so this string is the only name it has.",
        placeholders: {
          singular:
            "Singular noun for this file's divisions, from editor.milestone.vocab.* " +
            "— e.g. 'chapter', 'slide'.",
        },
      },
      "editor.milestone.current": {
        description:
          "Screen-reader name of the picker button between the two arrows. It does " +
          "double duty: it states where the user currently is, then says what the " +
          "button does. Keep both halves.",
        placeholders: {
          singular:
            "Singular noun for this file's divisions — e.g. 'chapter', 'slide'.",
          label:
            "The division's own display label ('Matthew 1', a slide title). Content, " +
            "so never translate the substituted value.",
        },
      },
      "editor.milestone.currentWithCells": {
        description:
          "Same picker name as editor.milestone.current, for a division that is " +
          "split into cell ranges, naming the range the user is inside.",
        placeholders: {
          singular:
            "Singular noun for this file's divisions — e.g. 'chapter', 'slide'.",
          label: "The division's own display label. Content — do not translate.",
          cells:
            "The cell range within the division, already formatted, e.g. '101–117'. " +
            "Numbers only — do not translate.",
        },
      },
      "editor.milestone.findPlaceholder": {
        description:
          "Placeholder in the search field inside the open division picker. Ends " +
          "with an ellipsis glyph (…). It prompts typing, so it should read as an " +
          "invitation rather than a label.",
        placeholders: {
          singular:
            "Singular noun for this file's divisions — e.g. 'chapter', 'slide'.",
        },
      },
      "editor.milestone.find": {
        description:
          "Screen-reader name of that same search field — the placeholder without " +
          "its trailing ellipsis.",
        placeholders: {
          singular:
            "Singular noun for this file's divisions — e.g. 'chapter', 'slide'.",
        },
      },
      "editor.milestone.empty": {
        description:
          "Message inside the picker when the typed query matches no division. Full " +
          "sentence with a period.",
        placeholders: {
          plural:
            "Lower-cased plural noun for this file's divisions — e.g. 'chapters'.",
        },
      },
      "editor.milestone.cellRange": {
        description:
          "Label of a cell-range row nested under a division in the picker, and the " +
          "same row's text value. 'Cells' are the numbered translation units; the " +
          "range is inclusive.",
        placeholders: {
          range:
            "The inclusive range as already formatted by the app, e.g. '101–117' " +
            "(en dash). Numbers only — do not translate.",
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
      "editor.milestone.vocab.chapter": {
        description:
          "Singular noun substituted into the milestone navigator's labels for a " +
          "scripture file: a chapter of a biblical book. Lower-case in English " +
          "because it appears mid-sentence ('Previous chapter').",
        maxLength: 16,
      },
      "editor.milestone.vocab.chapterPlural": {
        description:
          "Plural of editor.milestone.vocab.chapter, used as a group heading and " +
          "lower-cased by the app when it appears mid-sentence. Capitalised in " +
          "English because its primary use is a heading.",
        maxLength: 18,
      },
      "editor.milestone.vocab.slide": {
        description:
          "Singular noun for a division of a presentation-shaped file — one slide. " +
          "Lower-case, used mid-sentence.",
        maxLength: 16,
      },
      "editor.milestone.vocab.slidePlural": {
        description: "Plural of editor.milestone.vocab.slide; heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.story": {
        description:
          "Singular noun for a division of an oral-Bible or story-set file — one " +
          "story. Lower-case, used mid-sentence.",
        maxLength: 16,
      },
      "editor.milestone.vocab.storyPlural": {
        description: "Plural of editor.milestone.vocab.story; heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.section": {
        description:
          "Singular noun for a generic titled division of a document. Lower-case, " +
          "used mid-sentence.",
        maxLength: 16,
      },
      "editor.milestone.vocab.sectionPlural": {
        description: "Plural of editor.milestone.vocab.section; heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.timeRange": {
        description:
          "Singular noun for a division of an audio or video file: a span of time on " +
          "the timeline. Lower-case, used mid-sentence.",
        maxLength: 18,
      },
      "editor.milestone.vocab.timeRangePlural": {
        description: "Plural of editor.milestone.vocab.timeRange; heading form.",
        maxLength: 20,
      },
      "editor.milestone.vocab.part": {
        description:
          "Singular noun for a division of a file split into numbered parts. " +
          "Lower-case, used mid-sentence.",
        maxLength: 16,
      },
      "editor.milestone.vocab.partPlural": {
        description: "Plural of editor.milestone.vocab.part; heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.group": {
        description:
          "Singular noun for an arbitrary grouping of cells, used when the file's " +
          "divisions have no more specific name. Lower-case, used mid-sentence.",
        maxLength: 16,
      },
      "editor.milestone.vocab.groupPlural": {
        description: "Plural of editor.milestone.vocab.group; heading form.",
        maxLength: 18,
      },
      "editor.milestone.vocab.milestone": {
        description:
          "The catch-all singular noun used when a file mixes several kinds of " +
          "division, so none of the specific words fits. Choose a neutral word for " +
          "'a marked point or stretch in the file'. Lower-case, used mid-sentence.",
        maxLength: 18,
      },
      "editor.milestone.vocab.milestonePlural": {
        description: "Plural of editor.milestone.vocab.milestone; heading form.",
        maxLength: 20,
      },
      "editor.column.source": {
        description:
          "The name of the left-hand column of the editing table and of the " +
          "'source' side generally: the text being translated FROM. Used as a table " +
          "heading, as a settings row label, and interpolated into other strings " +
          "('Source direction'). One word, and it must pair contrastively with " +
          "editor.column.target.",
        maxLength: 14,
      },
      "editor.column.target": {
        description:
          "The name of the right-hand, editable column of the editing table and of " +
          "the 'target' side generally: the language being translated INTO. Used as " +
          "a table heading, a settings row label, and interpolated into other " +
          "strings. Must pair contrastively with editor.column.source.",
        maxLength: 14,
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
            "The direction the user forced, from editor.view.dirLtr / dirRtl.",
          detected:
            "The direction the text actually appears to run, from " +
            "editor.view.dirLtr / dirRtl / dirMixed.",
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
            "translate.",
        },
      },
      "editor.ebible.matchedOne": {
        description:
          "Singular form of the summary line in the eBible import review: how many " +
          "verses of the chosen public translation line up with cells in this " +
          "project. Only rendered for count = 1.",
        placeholders: { count: "Always 1 for this form." },
      },
      "editor.ebible.matchedMany": {
        description:
          "Plural of editor.ebible.matchedOne. 'Matched' means paired to an " +
          "existing source cell by verse reference.",
        placeholders: {
          count: "Number of verses paired with a cell, already digit-grouped.",
        },
      },
      "editor.ebible.conflictsOne": {
        description:
          "Singular amber warning fragment appended to the match summary: matched " +
          "cells that ALREADY have translated text, which importing would " +
          "overwrite. The parenthetical is the reason it is a conflict.",
        placeholders: { count: "Always 1 for this form." },
      },
      "editor.ebible.conflictsMany": {
        description: "Plural of editor.ebible.conflictsOne.",
        placeholders: {
          count: "Number of matched cells that already contain a translation.",
        },
      },
      "editor.ebible.orphansOne": {
        description:
          "Singular fragment appended to the match summary counting verses present " +
          "in the eBible translation with no cell to import into. 'Orphan' is used " +
          "in the sense 'has no counterpart here'.",
        placeholders: { count: "Always 1 for this form." },
      },
      "editor.ebible.orphansMany": {
        description: "Plural of editor.ebible.orphansOne.",
        placeholders: { count: "Number of eBible verses with no matching cell." },
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
      "editor.ebible.orphanSummaryOne": {
        description:
          "Singular summary of the collapsed list of eBible verses that had no cell " +
          "to import into. The parenthetical explains what 'orphan' means here.",
        placeholders: { count: "Always 1 for this form." },
      },
      "editor.ebible.orphanSummaryMany": {
        description: "Plural of editor.ebible.orphanSummaryOne.",
        placeholders: { count: "Number of eBible verses with no matching cell." },
      },
      "editor.ebible.andMore": {
        description:
          "Last row of the truncated orphan list, standing for the entries not " +
          "shown. The leading ellipsis glyph continues the list visually — keep a " +
          "leading continuation mark if the target language uses one.",
        placeholders: { count: "Number of orphan entries not listed." },
      },
      "editor.ebible.unmatchedOne": {
        description:
          "Singular note counting the project's own source cells that the eBible " +
          "translation had nothing for — the mirror image of an orphan. Full " +
          "sentence.",
        placeholders: { count: "Always 1 for this form." },
      },
      "editor.ebible.unmatchedMany": {
        description: "Plural of editor.ebible.unmatchedOne.",
        placeholders: {
          count: "Number of source cells with no eBible verse, already digit-grouped.",
        },
      },
      "editor.ebible.applyOne": {
        description:
          "Singular label of the confirming button that writes the ticked verses " +
          "into the project's target column. Imperative, with the count so the user " +
          "sees the scope before committing.",
        placeholders: { count: "Always 1 for this form." },
      },
      "editor.ebible.applyMany": {
        description: "Plural of editor.ebible.applyOne.",
        placeholders: { count: "Number of ticked verses that will be written." },
      },
      "editor.ebible.conflictBadge": {
        description:
          "Tiny (9px) amber badge on a review row whose cell already has translated " +
          "text. Lower-case in English because it is a badge, not a sentence. One " +
          "word — there is almost no room.",
        maxLength: 12,
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
