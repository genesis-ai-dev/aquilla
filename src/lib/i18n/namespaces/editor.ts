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
