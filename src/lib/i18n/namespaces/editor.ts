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
