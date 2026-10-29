import { defineNamespace, plural } from "./types"

export const transcribe = defineNamespace({
  keys: {
    "transcribe.heard": "Heard",
    "transcribe.notTranscribed": "Not transcribed yet",
    "transcribe.transcriptLabel": "Transcript",
    "transcribe.run": "Transcribe and clean up",
    "transcribe.rerun": "Transcribe again and clean up",
    "transcribe.play": "Play",
    "transcribe.pause": "Pause",
    "transcribe.cleaned": plural({
      one: "Cleaned up · {count} change",
      other: "Cleaned up · {count} changes",
    }),
    "transcribe.status.working": "Working",
    "transcribe.status.unchanged": "Nothing to clean up",
    "transcribe.status.tooDifferent": "Cleanup changed too much",
    "transcribe.status.noSpeech": "No speech heard",
    "transcribe.status.validated": "Validated takes stay as they are",
    "transcribe.status.allowance": "AI allowance reached",
    "transcribe.status.failedAsr": "Transcription failed",
    "transcribe.status.failedCleanup": "Cleanup failed",
    "transcribe.status.failedSave": "Couldn't save",
    "transcribe.confirmReplace": "Replace your corrected transcript with an AI cleanup?",
    "transcribe.runAll": "Transcribe all",
    "transcribe.runAllProgress": "{done} of {total}",
    "transcribe.stop": "Stop",
    "transcribe.empty": "This file has no audio yet. Record or import audio, then come back to transcribe it.",
    "transcribe.signIn": "Sign in to transcribe",
    "transcribe.select": "Select line {line}",
    "transcribe.selectNone": "Clear selection",
    "transcribe.cleanSelected": plural({
      one: "Clean up {count} line",
      other: "Clean up {count} lines",
    }),
    "transcribe.confirmReplaceSelected": plural({
      one: "{count} selected line was corrected by hand. Replace it with an AI cleanup?",
      other: "{count} selected lines were corrected by hand. Replace them with an AI cleanup?",
    }),
    "transcribe.clear": "Clear transcription",
    "transcribe.confirmClear": "Clear what speech recognition heard and the transcript of this line?",
    "transcribe.model.starting": "Starting the speech model…",
    "transcribe.model.ready": "Speech model ready",
  },
  context: {
    _context: {
      description:
        "Transcribe lens: a view of the editor for working through a file's audio. Each row shows " +
        "a play button and what speech recognition heard (left), and the transcript the person " +
        "edits (right). A sparkle button runs speech recognition, then an AI cleanup that follows " +
        "how the team has corrected transcripts before.",
    },
    keys: {
      "transcribe.heard": { description: "Small label above the read-only text speech recognition produced.", maxLength: 16 },
      "transcribe.transcriptLabel": { description: "Accessible name of the editable transcript field in a row." },
      "transcribe.run": { description: "Tooltip and accessible name of the sparkle button: run speech recognition, then the AI cleanup. Spends AI credits." },
      "transcribe.rerun": { description: "Menu item / long-press action: run speech recognition again from scratch, then clean up." },
      "transcribe.play": { description: "Accessible name of the row's play button." },
      "transcribe.pause": { description: "Accessible name of the row's play button while the audio plays." },
      "transcribe.cleaned": {
        description: "Small mark on a transcript the AI cleaned up and nobody has edited since.",
        placeholders: { count: "How many words the cleanup changed." },
        maxLength: 32,
      },
      "transcribe.status.working": { description: "Screen-reader name of the spinner while a row is transcribing or cleaning up." },
      "transcribe.status.unchanged": { description: "Brief row status: the AI found nothing to change.", maxLength: 28 },
      "transcribe.status.tooDifferent": { description: "Brief row status: the AI's result added or dropped too many words, so it was not saved.", maxLength: 32 },
      "transcribe.status.noSpeech": { description: "Brief row status: speech recognition returned no words.", maxLength: 28 },
      "transcribe.status.validated": { description: "Brief row status: a validated take is never changed by the AI.", maxLength: 36 },
      "transcribe.status.allowance": { description: "Brief row status when the workspace's AI credits are used up.", maxLength: 28 },
      "transcribe.status.failedAsr": { description: "Brief row status when speech recognition failed. The technical reason shows on hover.", maxLength: 28 },
      "transcribe.status.failedCleanup": { description: "Brief row status when the AI cleanup request failed. The technical reason shows on hover.", maxLength: 28 },
      "transcribe.status.failedSave": { description: "Brief row status when the transcript could not be saved. The technical reason shows on hover.", maxLength: 28 },
      "transcribe.runAll": { description: "Toolbar button: run speech recognition (no AI cleanup) on every row that has no transcript yet.", maxLength: 36 },
      "transcribe.runAllProgress": {
        description: "Progress beside the toolbar button while it works through the rows.",
        placeholders: { done: "Rows finished so far.", total: "Rows it will work through." },
      },
      "transcribe.stop": { description: "Toolbar button: stop the run after the current rows.", maxLength: 16 },
      "transcribe.select": {
        description: "Accessible name of a row's checkbox. Ticked rows can be cleaned up together.",
        placeholders: { line: "The line's label, for example a verse reference." },
      },
      "transcribe.selectNone": { description: "Toolbar button: untick every row.", maxLength: 24 },
      "transcribe.cleanSelected": {
        description: "Toolbar button: run the AI cleanup on the ticked rows (speech recognition first where a row has none).",
        placeholders: { count: "How many rows are ticked." },
        maxLength: 32,
      },
      "transcribe.confirmReplaceSelected": {
        description: "Confirmation before the AI cleanup replaces transcripts a person corrected.",
        placeholders: { count: "How many of the ticked rows a person corrected." },
      },
      "transcribe.clear": { description: "Tooltip and accessible name of the button beside what speech recognition heard: removes it and the transcript, so the row is untranscribed again." },
      "transcribe.confirmClear": { description: "Confirmation before clearing one row's speech recognition text and transcript." },
      "transcribe.model.starting": { description: "Toolbar status while the speech recognition model starts up (it can take a minute or two).", maxLength: 40 },
      "transcribe.model.ready": { description: "Toolbar status, shown briefly, when the speech recognition model has started.", maxLength: 40 },
    },
  },
  surfaces: [],
})
