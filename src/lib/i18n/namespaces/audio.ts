import { defineNamespace } from "./types"

export const audio = defineNamespace({
  keys: {
    // Shared across more than one audio surface.
    "audio.narrator": "Narrator",

    // NewVoiceModal — create/edit a voice (TTS engine config, or a cloned
    // voice built from a reference clip).
    "audio.newVoice.createLabel": "New voice",
    "audio.newVoice.titleEdit": "Edit voice",
    "audio.newVoice.tabTts": "TTS voice",
    "audio.newVoice.tabClone": "Clone voice",
    "audio.newVoice.kindGroupLabel": "Voice kind",
    "audio.newVoice.namePlaceholder": "e.g. Narrator",
    "audio.newVoice.nameAriaLabel": "Voice name",
    "audio.newVoice.engineLabel": "Engine",
    "audio.newVoice.describeLabel": "Describe the voice",
    "audio.newVoice.describePlaceholder": "e.g. a warm older man, calm and clear",
    "audio.newVoice.kokoroLabel": "Kokoro voice id",
    "audio.newVoice.kokoroPlaceholder": "e.g. af_bella",
    "audio.newVoice.mmsLanguageLabel": "Language",
    "audio.newVoice.singleVoiceHint":
      "{engine} uses a single neural voice. Use the Clone tab to make it sound like a specific person.",
    "audio.newVoice.referenceLabel": "Reference audio",
    "audio.newVoice.referenceDescription":
      "A short clip is enough — we generate a base voice and clone it to match.",
    "audio.newVoice.reuseTakeSummary": "Or reuse audio from a line",
    "audio.newVoice.takeRecorded": "Recorded",
    "audio.newVoice.takeGenerated": "AI-generated",
    "audio.newVoice.liftingTake": "Lifting take…",
    "audio.newVoice.errorNoProjectContext": "No project context to lift a take.",
    "audio.newVoice.errorAudioUnavailable": "That audio is no longer available.",
    "audio.newVoice.errorNameRequired": "Name the voice",
    "audio.newVoice.errorReferenceRequired": "Add a reference clip before creating a cloned voice",
    "audio.newVoice.makeNarratorHint":
      "Make this the narrator — used for lines without an explicit speaker.",
    "audio.newVoice.makeNarratorButton": "Make narrator",
    "audio.newVoice.createButton": "Create voice",
    "audio.newVoice.deleteDialogTitle": "Delete voice",
    "audio.newVoice.deleteDialogDescription":
      'Delete "{voiceName}"? This removes the voice for everyone in the project and cannot be undone.',
    "audio.newVoice.deleteDialogCheckbox":
      "I understand this deletes the voice for everyone in the project.",
    "audio.newVoice.unnamedVoiceFallback": "this voice",
    "audio.newVoice.mmsUnsupportedCode": "Unsupported code: {code}",
    "audio.newVoice.mmsChooseLanguage": "Choose a language",
    "audio.newVoice.mmsOtherCode": "Other MMS code",
    "audio.newVoice.mmsCodeLabel": "MMS code",

    // VoicePlaybackBar — the Audio lens' bottom transport bar.
    "audio.playbackBar.lineFallback": "Line",
    "audio.playbackBar.nothingPlaying": "Nothing playing",
    "audio.playbackBar.pressPlayToListen": "Press play to listen",
    "audio.playbackBar.noVoicedLines": "No voiced lines yet",
    "audio.playbackBar.previousLine": "Previous line",
    "audio.playbackBar.nextLine": "Next line",
    "audio.playbackBar.playAll": "Play all",
    "audio.playbackBar.playbackSpeed": "Playback speed",
    "audio.playbackBar.unmute": "Unmute",
    "audio.playbackBar.mute": "Mute",

    // CombinedBoundaryEditor — split a multi-line "Voice together" clip.
    "audio.boundaryEditor.title": "Split the combined clip by line",
    "audio.boundaryEditor.description":
      "Drag the dividers so each marker sits at the end of a line. Click a segment to hear just that line. Defaults to an even split by text length.",
    "audio.boundaryEditor.previewSegment": "Preview {snippet}",
    "audio.boundaryEditor.dividerLabel": "Divider {index}",
    "audio.boundaryEditor.loadingClip": "Loading clip…",
    "audio.boundaryEditor.saveSplits": "Save splits",

    // AudioRecordingModal — full-screen mic-recording flow.
    "audio.recordingModal.signInRequired": "Sign in to save recordings",
    "audio.recordingModal.offlineMessage":
      "You're offline — recordings can't be saved without a connection. Reconnect and try again.",
    "audio.recordingModal.micBlocked":
      "Microphone access is blocked. To record audio, allow microphone access in your browser's site settings and reload the page.",
    "audio.recordingModal.dialogTitle": "Record audio — {cellLabel}",
    "audio.recordingModal.targetWindow": "{seconds}s window",
    "audio.recordingModal.cellFallback": "Cell {index}",
    "audio.recordingModal.autoAdvanceOnTooltip":
      "Moving to the next line after each save — click to stay here",
    "audio.recordingModal.autoAdvanceOffTooltip":
      "Staying on this line after each save — click to move on automatically",
    "audio.recordingModal.autoAdvanceDisableLabel": "Stay on this line after saving",
    "audio.recordingModal.autoAdvanceEnableLabel": "Move to the next line after saving",
    "audio.recordingModal.muteBeepTooltip": "Mute countdown beep",
    "audio.recordingModal.unmuteBeepTooltip": "Enable countdown beep",
    "audio.recordingModal.closeTooltip": "Close (Esc)",
    "audio.recordingModal.emptySource": "empty",
    "audio.recordingModal.readAloudLabel": "Read aloud",
    "audio.recordingModal.notTranslated": "not translated",
    "audio.recordingModal.countingHint": "Recording starts in…",
    "audio.recordingModal.countingGo": "GO",
    "audio.recordingModal.recordingStatus": "Recording",
    "audio.recordingModal.overrunWarning": "Past target duration — this will overrun the cue.",
    "audio.recordingModal.nearLimitWarning":
      "Recording is 25 minutes — it will stop automatically at 30 minutes.",
    "audio.recordingModal.capturedHint": "Captured — review and save, or retake.",
    "audio.recordingModal.saveFailedNotice":
      "Saving failed — the take is safe, try Save again. ({error})",
    "audio.recordingModal.savedStatus": "Saved — moving to next cell…",
    "audio.recordingModal.idleHintPrefix": "Press",
    "audio.recordingModal.idleHintSuffix":
      "or click Start. The beep plays a 3-2-1 countdown before recording.",
    "audio.recordingModal.genericError": "Something went wrong.",
    "audio.recordingModal.errorHint": "Press Space or Start to try again.",
    "audio.recordingModal.prevCellTooltip": "Previous cell (←)",
    "audio.recordingModal.prevButton": "Prev",
    "audio.recordingModal.nextCellTooltip": "Next cell (→)",
    "audio.recordingModal.retakeTooltip": "Retake (Esc)",
    "audio.recordingModal.retakeButton": "Retake",
    "audio.recordingModal.saveTooltip": "Save (Space or Enter)",
    "audio.recordingModal.stopTooltip": "Stop (Space or Esc)",
    "audio.recordingModal.startButton": "Start",
    "audio.recordingModal.startTooltip": "Start recording (Space)",
    "audio.recordingModal.generateTtsButton": "Generate TTS",
    "audio.recordingModal.ttsTooltip": "Generate this line's voice with the project's engine",
    "audio.recordingModal.ttsNeedsTranslation": "Translate this line first to generate voice",
    "audio.recordingModal.ttsDoneTooltip": "Voice generated — it plays on the Target track",
    "audio.recordingModal.cancelCountdown": "Cancel countdown",

    // TakesStrip — per-cell recorded-take management row.
    "audio.takesStrip.heading": "Takes ({count})",
    "audio.takesStrip.cleanedLabel": "Cleaned",
    "audio.takesStrip.takeFallback": "Take",
    "audio.takesStrip.renameTooltip": "Rename take",
    "audio.takesStrip.unknownLengthTooltip": "Length unknown — re-record or re-upload to fix",
    "audio.takesStrip.pendingSyncTooltip": "Saving — kept safe on this device until it syncs",
    "audio.takesStrip.playTakeTooltip": "Play take",
    "audio.takesStrip.removeNoiseTooltip": "Remove noise (adds a cleaned take)",
    "audio.takesStrip.revertTooltip": "Revert to the original recording",
    "audio.takesStrip.activeTakeTooltip": "Active take",
    "audio.takesStrip.useTakeTooltip": "Use this take",
    "audio.takesStrip.deleteTakeTooltip": "Delete take",

    // VoiceLibraryPanel — the Voices sidebar (select / assign / manage cast).
    "audio.library.searchPlaceholder": "Search voices…",
    "audio.library.noVoicesYet": "No voices yet",
    "audio.library.rowHint": "Click to select · drag onto a line to assign",
    "audio.library.narratorHint":
      "Narrator — lines without an explicit speaker use this voice.",
    "audio.library.moreActionsLabel": "More voice actions",
    "audio.library.moreTooltip": "More",
    "audio.library.setNarrator": "Set as narrator",
    "audio.library.voicedStats": "{voiced}/{assigned} voiced",
    "audio.library.noLinesYet": "no lines yet",
    "audio.library.cloneEngineLabel": "Clone",

    // VoiceCloneSection — record/upload the reference clip a cloned voice
    // is re-voiced to match.
    "audio.clone.title": "Voice profile (clone)",
    "audio.clone.activeBadge": "Active",
    "audio.clone.description":
      "Record or upload a short reference clip (5–15s of one clear speaker). This voice's generated audio is then re-voiced into that timbre via Seed-VC — so the whole project can speak in a single, consistent voice.",
    "audio.clone.needsContext":
      "Open this from a project workspace to record or upload a reference clip.",
    "audio.clone.removeButton": "Remove clone",
    "audio.clone.replaceButton": "Replace",
    "audio.clone.stopRecordingButton": "Stop ({seconds}s)",
    "audio.clone.recordButton": "Record reference",
    "audio.clone.uploadButton": "Upload audio",
    "audio.clone.errorNoContext": "No project context for upload.",
    "audio.clone.errorTooLarge": "Reference clip too large (max 8 MB). Use a few seconds.",
    "audio.clone.previewTooltip": "Preview reference clip",
    "audio.clone.previewFailed": "Preview failed",

    // AudioBulkProgressBanner — batch transcribe-all / synth-all progress.
    "audio.bulkProgress.cancelTooltip": "Cancel batch",
  },
  context: {
    _context: {
      description:
        "The Audio Studio (\"Audio lens\") — recording, TTS generation, voice " +
        "management, and playback for turning a translated project into narrated " +
        "audio. Domain terms translators will not know from the English alone: a " +
        "'take' is one recorded or generated audio attempt for a line (there can be " +
        "several; the user picks a keeper); a 'voice' is a named TTS configuration or " +
        "a cloned timbre that reads lines aloud; 'clone' means capturing a short " +
        "reference clip of a real voice so generated speech is re-voiced to sound " +
        "like it; a 'boundary' or 'divider' marks where one line ends and the next " +
        "begins inside a single combined audio clip that covers several lines at " +
        "once; 'diarization' (mentioned in code comments only, not user-facing here) " +
        "is unrelated to these keys.",
      screenshot: "audio-studio",
    },
    keys: {
      "audio.narrator": {
        description:
          "Status word/badge meaning this voice is the project's default narrator — " +
          "used for any line that has no explicit speaker assigned. Appears both as a " +
          "small badge on a voice's row in the Voices list and as inline status text " +
          "in the voice editor's footer. Noun, not a verb.",
      },
      "audio.newVoice.createLabel": {
        description:
          "Label meaning 'start creating a new voice'. Used twice with the same " +
          "wording: as the dialog's heading when the New Voice dialog is opened fresh " +
          "(not editing an existing voice), and as the button in the Voices sidebar " +
          "that opens that dialog. Short noun phrase, not a full sentence.",
      },
      "audio.newVoice.titleEdit": {
        description:
          "Heading of the same dialog as audio.newVoice.createLabel, shown instead " +
          "when the user opened it to edit a voice that already exists.",
      },
      "audio.newVoice.tabTts": {
        description:
          "Tab label for the 'generate speech with a TTS engine' way of making a " +
          "voice, as opposed to the Clone tab. TTS = text-to-speech; keep as a " +
          "recognizable acronym if the target language commonly does, otherwise spell " +
          "it out briefly.",
        maxLength: 18,
      },
      "audio.newVoice.tabClone": {
        description:
          "Tab label for the 'clone a real voice from a reference clip' way of " +
          "making a voice, as opposed to the TTS voice tab.",
        maxLength: 18,
      },
      "audio.newVoice.kindGroupLabel": {
        description:
          "Accessible group label (not visible text) for the TTS/Clone tab pair, " +
          "read by screen readers to announce what the two tabs are choosing between.",
      },
      "audio.newVoice.namePlaceholder": {
        description:
          "Placeholder text shown inside the empty voice-name text field, before the " +
          "user types anything. An example name ('Narrator'), not an instruction — " +
          "keep the 'e.g.' abbreviation or the target language's equivalent.",
      },
      "audio.newVoice.nameAriaLabel": {
        description:
          "Accessible name for the voice-name text input, read by screen readers. " +
          "Same meaning as the visible 'Name' field label beside it, just for " +
          "assistive tech.",
      },
      "audio.newVoice.engineLabel": {
        description:
          "Form label above the row of TTS engine choice cards (e.g. OmniVoice, " +
          "Gemini, Kokoro, MMS) — 'engine' means which speech-synthesis backend " +
          "generates this voice's audio.",
      },
      "audio.newVoice.describeLabel": {
        description:
          "Label for a free-text field, shown only when the Gemini engine is " +
          "selected, where the user describes in plain words how the voice should " +
          "sound (e.g. tone, age, mood). Gemini turns this description into a voice.",
      },
      "audio.newVoice.describePlaceholder": {
        description:
          "Placeholder example text inside the empty 'describe the voice' textarea, " +
          "showing the kind of description that works well.",
      },
      "audio.newVoice.kokoroLabel": {
        description:
          "Label for a text field, shown only when the Kokoro engine is selected, " +
          "where the user enters Kokoro's own voice identifier code. 'Kokoro' is the " +
          "engine's proper name — do not translate it.",
      },
      "audio.newVoice.kokoroPlaceholder": {
        description:
          "Placeholder example inside the empty Kokoro voice-id field, showing the " +
          "format of a real id. The example code itself ('af_bella') is data, not " +
          "prose — keep it as-is; only 'e.g.' needs translating.",
      },
      "audio.newVoice.mmsLanguageLabel": {
        description:
          "Label for the language-picker field shown only when the MMS engine is " +
          "selected — MMS needs to know which spoken language it is synthesizing, " +
          "not which language the app's own interface is in. Distinct from the " +
          "unrelated 'language.label' key, which is the UI-language switcher.",
      },
      "audio.newVoice.singleVoiceHint": {
        description:
          "Explanatory sentence shown when the OmniVoice engine is selected, telling " +
          "the user that engine offers only one built-in voice and pointing them to " +
          "the Clone tab if they want it to sound like someone specific.",
        placeholders: {
          engine:
            "The selected TTS engine's proper display name (e.g. 'OmniVoice'), " +
            "already resolved in English by the app — a brand name, do not translate " +
            "the substituted value.",
        },
      },
      "audio.newVoice.referenceLabel": {
        description:
          "Form label above the reference-clip recorder/uploader shown on the Clone " +
          "tab. 'Reference audio' is the short clip the cloned voice will be made to " +
          "sound like.",
      },
      "audio.newVoice.referenceDescription": {
        description:
          "One-line helper text under the reference-clip control on the Clone tab, " +
          "explaining that a short clip is sufficient.",
      },
      "audio.newVoice.reuseTakeSummary": {
        description:
          "Collapsed `<summary>` label for a disclosure panel on the Clone tab that, " +
          "when opened, lists audio already recorded or generated elsewhere in the " +
          "project so the user can reuse one as the clone reference instead of " +
          "recording fresh.",
      },
      "audio.newVoice.takeRecorded": {
        description:
          "Small badge on a listed take (inside the 'reuse audio from a line' " +
          "panel) meaning this particular clip was captured by a human with a " +
          "microphone, as opposed to generated by TTS. Paired with " +
          "audio.newVoice.takeGenerated.",
        maxLength: 16,
      },
      "audio.newVoice.takeGenerated": {
        description:
          "Small badge on a listed take meaning this particular clip was produced " +
          "by AI text-to-speech generation rather than recorded by a human.",
        maxLength: 16,
      },
      "audio.newVoice.liftingTake": {
        description:
          "Transient status text shown while a reused take (see " +
          "audio.newVoice.reuseTakeSummary) is being copied over to become this " +
          "voice's clone reference. 'Lifting' = copying that clip into place.",
      },
      "audio.newVoice.errorNoProjectContext": {
        description:
          "Inline error shown on the Clone tab when reusing a take fails because the " +
          "dialog has no project to copy audio from (an unexpected state, not a " +
          "normal user mistake).",
      },
      "audio.newVoice.errorAudioUnavailable": {
        description:
          "Inline error shown on the Clone tab when the take the user tried to reuse " +
          "no longer has playable audio behind it (e.g. it was deleted).",
      },
      "audio.newVoice.errorNameRequired": {
        description:
          "Inline validation error shown when the user tries to save a voice without " +
          "typing a name first.",
      },
      "audio.newVoice.errorReferenceRequired": {
        description:
          "Inline validation error shown when the user tries to save a Clone-tab " +
          "voice before attaching a reference clip.",
      },
      "audio.newVoice.makeNarratorHint": {
        description:
          "Tooltip on the 'Make narrator' button in the voice editor's footer, " +
          "explaining what the narrator role means before the user clicks it.",
      },
      "audio.newVoice.makeNarratorButton": {
        description:
          "Button in the voice editor's footer that sets this voice as the " +
          "project's default narrator (see audio.narrator). Imperative, short — " +
          "sits beside Cancel/Save.",
        maxLength: 20,
      },
      "audio.newVoice.createButton": {
        description:
          "Primary submit button in the voice editor's footer when creating a new " +
          "voice (as opposed to editing one, which shows Save instead). Imperative " +
          "verb phrase.",
        maxLength: 20,
      },
      "audio.newVoice.deleteDialogTitle": {
        description:
          "Both the heading of the confirmation dialog shown when deleting a voice, " +
          "and that dialog's affirmative confirm button. Destructive — should read " +
          "clearly as 'delete', matching common.delete's tone.",
      },
      "audio.newVoice.deleteDialogDescription": {
        description:
          "Body text of the delete-voice confirmation dialog, warning that deleting " +
          "affects everyone in the project and cannot be undone.",
        placeholders: {
          voiceName:
            "The voice's own name as the user named it, or a generic fallback " +
            "('this voice') if it has none. User-entered content — do not translate " +
            "the substituted value itself.",
        },
      },
      "audio.newVoice.deleteDialogCheckbox": {
        description:
          "Label beside the required acknowledgement checkbox in the delete-voice " +
          "confirmation dialog, which the user must tick before the destructive " +
          "confirm button becomes usable.",
      },
      "audio.newVoice.unnamedVoiceFallback": {
        description:
          "Fallback stand-in for the voice's name inside " +
          "audio.newVoice.deleteDialogDescription, used only when the voice being " +
          "deleted has no name at all.",
      },
      "audio.newVoice.mmsUnsupportedCode": {
        description:
          "Disabled placeholder option shown in the MMS language dropdown when the " +
          "voice already has a language code set that isn't in the popular-languages " +
          "list and extended codes aren't available to pick from.",
        placeholders: {
          code: "The raw language code that isn't recognized. Not translated.",
        },
      },
      "audio.newVoice.mmsChooseLanguage": {
        description:
          "Disabled placeholder option shown in the MMS language dropdown when no " +
          "language is set yet, prompting the user to pick one.",
      },
      "audio.newVoice.mmsOtherCode": {
        description:
          "Option at the end of the MMS language dropdown that switches to a raw " +
          "code-entry field, for languages not in the popular-languages shortlist.",
      },
      "audio.newVoice.mmsCodeLabel": {
        description:
          "Form label for the raw MMS language-code text field, shown only when " +
          "extended MMS models are available. 'MMS' is the engine's proper name — do " +
          "not translate it.",
      },
      "audio.playbackBar.lineFallback": {
        description:
          "Fallback title shown in the 'now playing' area of the bottom transport " +
          "bar for a line that has no other label. Short noun.",
      },
      "audio.playbackBar.nothingPlaying": {
        description:
          "Title shown in the 'now playing' area of the bottom transport bar when " +
          "playback is stopped and no line is loaded.",
      },
      "audio.playbackBar.pressPlayToListen": {
        description:
          "Subtitle under the 'now playing' title, shown when nothing has ever " +
          "played yet but audio is available — a soft call to action.",
      },
      "audio.playbackBar.noVoicedLines": {
        description:
          "Subtitle under the 'now playing' title, shown when the file has no " +
          "audio at all yet to play (nothing has been recorded or generated).",
      },
      "audio.playbackBar.previousLine": {
        description:
          "Tooltip and accessible name for the transport-bar button that jumps " +
          "playback back to the previous line.",
      },
      "audio.playbackBar.nextLine": {
        description:
          "Tooltip and accessible name for the transport-bar button that jumps " +
          "playback forward to the next line.",
      },
      "audio.playbackBar.playAll": {
        description:
          "Tooltip and accessible name for the central play/pause button, shown " +
          "while audio is stopped or paused (pressing it plays every line in " +
          "sequence, not just one).",
      },
      "audio.playbackBar.playbackSpeed": {
        description:
          "Tooltip for the speed control button (labelled e.g. '1x', '1.5x') that " +
          "opens a menu of playback speeds.",
      },
      "audio.playbackBar.unmute": {
        description:
          "Tooltip and accessible name for the volume button when audio is " +
          "currently muted (pressing it unmutes).",
      },
      "audio.playbackBar.mute": {
        description:
          "Tooltip and accessible name for the volume button when audio is " +
          "currently audible (pressing it mutes).",
      },
      "audio.boundaryEditor.title": {
        description:
          "Heading of the boundary-editor dialog. Several lines were synthesized " +
          "together into one combined audio clip ('Voice together'); this dialog " +
          "lets the user mark where each line starts and ends inside that one clip.",
      },
      "audio.boundaryEditor.description": {
        description:
          "Instructional paragraph under the dialog's heading, explaining the drag " +
          "and click-to-preview interactions and the default split behaviour.",
      },
      "audio.boundaryEditor.previewSegment": {
        description:
          "Tooltip on a clickable region of the waveform, offering to play just " +
          "that one line's segment of the combined clip.",
        placeholders: {
          snippet:
            "A short auto-generated label for the line: its position number plus " +
            "the start of its translated text, e.g. '1. In the beginning God…'. " +
            "User content — do not translate the substituted value.",
        },
      },
      "audio.boundaryEditor.dividerLabel": {
        description:
          "Accessible name for one draggable divider handle between two lines' " +
          "segments in the waveform. Screen-reader users navigate dividers by this " +
          "label plus its position.",
        placeholders: {
          index: "1-based position of this divider among all the dividers.",
        },
      },
      "audio.boundaryEditor.loadingClip": {
        description:
          "Status text shown over the waveform area while the combined clip's audio " +
          "is still being decoded and isn't ready to display or scrub yet.",
      },
      "audio.boundaryEditor.saveSplits": {
        description:
          "Primary submit button that saves the dividers' current positions as each " +
          "line's trim boundaries within the shared clip.",
        maxLength: 20,
      },
      "audio.recordingModal.signInRequired": {
        description:
          "Error shown if the user tries to start recording while signed out — " +
          "recordings must be uploaded to a signed-in session to be saved.",
      },
      "audio.recordingModal.offlineMessage": {
        description:
          "The one message used everywhere the recorder is blocked by lost " +
          "connectivity: as the error when the user tries to start recording " +
          "offline, as the amber notice under a captured take explaining why Save " +
          "is greyed out, and as the tooltip of the disabled Start, Save and " +
          "Generate-TTS buttons. Recording itself happens locally, so the take is " +
          "never lost — only saving it needs the network, which is why the second " +
          "sentence tells the user to reconnect and try again.",
      },
      "audio.recordingModal.micBlocked": {
        description:
          "Error shown when the browser reports microphone permission as denied, " +
          "with actionable next steps (change a browser setting, then reload).",
      },
      "audio.recordingModal.dialogTitle": {
        description:
          "Screen-reader-only title of the recording dialog (not visually shown), " +
          "naming which line is being recorded.",
        placeholders: {
          cellLabel:
            "The line's own label if it has one, otherwise the fallback from " +
            "audio.recordingModal.cellFallback (e.g. 'Cell 3').",
        },
      },
      "audio.recordingModal.targetWindow": {
        description:
          "Small badge in the recording dialog's header showing the target duration " +
          "(the timed cue window) this line's audio is expected to fit within.",
        placeholders: {
          seconds: "Target duration in seconds, to one decimal place.",
        },
      },
      "audio.recordingModal.cellFallback": {
        description:
          "Fallback name for a line that has no label of its own, used both in the " +
          "dialog title and in the visible header. 'Cell' here means one line/row of " +
          "the translation, not a spreadsheet cell in the ordinary sense.",
        placeholders: {
          index: "1-based position of this line among the cells being recorded.",
        },
      },
      "audio.recordingModal.autoAdvanceOnTooltip": {
        description:
          "Tooltip of the header toggle that controls what happens after a take is " +
          "saved, shown while auto-advance is ON: the first clause states the " +
          "current behaviour (the recorder jumps to the next line), the second " +
          "tells the user that clicking turns it off. Keep both halves.",
      },
      "audio.recordingModal.autoAdvanceOffTooltip": {
        description:
          "Tooltip of the same header toggle while auto-advance is OFF: the " +
          "recorder stays on the current line after each save, and clicking turns " +
          "jumping back on. Keep both halves.",
      },
      "audio.recordingModal.autoAdvanceDisableLabel": {
        description:
          "Accessible name of the auto-advance toggle while it is ON — never " +
          "visible. Unlike the tooltip it names what pressing the button WILL DO " +
          "(stop moving on, stay on this line), which is what a screen-reader user " +
          "needs to hear before activating it.",
      },
      "audio.recordingModal.autoAdvanceEnableLabel": {
        description:
          "Accessible name of the auto-advance toggle while it is OFF, naming what " +
          "pressing it will do: start jumping to the next line after each save. " +
          "Never visible.",
      },
      "audio.recordingModal.muteBeepTooltip": {
        description:
          "Tooltip and accessible name for the header button that silences the " +
          "3-2-1 countdown beep, shown when the beep is currently on.",
      },
      "audio.recordingModal.unmuteBeepTooltip": {
        description:
          "Tooltip and accessible name for the same header button, shown when the " +
          "beep is currently off (pressing it turns the beep back on).",
      },
      "audio.recordingModal.closeTooltip": {
        description:
          "Tooltip for the dialog's close button, including its keyboard shortcut " +
          "hint. '(Esc)' names the Escape key and is conventionally left " +
          "untranslated/abbreviated the way key names are elsewhere in this dialog.",
      },
      "audio.recordingModal.emptySource": {
        description:
          "Italic placeholder shown instead of the source text when the line has no " +
          "source text at all.",
      },
      "audio.recordingModal.readAloudLabel": {
        description:
          "Small caption above the translated text the user should read aloud into " +
          "the microphone — this is the actual script for the recording.",
      },
      "audio.recordingModal.notTranslated": {
        description:
          "Italic placeholder shown instead of the read-aloud script when the line " +
          "hasn't been translated yet, so there is nothing to record.",
      },
      "audio.recordingModal.countingHint": {
        description:
          "Small caption under the large 3-2-1 countdown numbers, shown while the " +
          "countdown is running before recording actually starts.",
      },
      "audio.recordingModal.countingGo": {
        description:
          "The word shown in place of a number at the very end of the countdown, " +
          "the instant recording begins. Should read as a short, energetic 'go'.",
        maxLength: 8,
      },
      "audio.recordingModal.recordingStatus": {
        description:
          "Status label beside a pulsing red dot, shown while the microphone is " +
          "actively capturing audio.",
      },
      "audio.recordingModal.overrunWarning": {
        description:
          "Warning shown while recording once the elapsed time exceeds the line's " +
          "target duration (its timed cue window), so the user knows they've gone " +
          "past where the line is supposed to end.",
      },
      "audio.recordingModal.nearLimitWarning": {
        description:
          "Warning shown while recording once it has run for 25 minutes, telling " +
          "the user the hard 30-minute cutoff is approaching.",
      },
      "audio.recordingModal.capturedHint": {
        description:
          "Status line shown after stopping a recording, above the audio preview " +
          "player, telling the user they can now listen back before deciding to " +
          "keep it or record again.",
      },
      "audio.recordingModal.saveFailedNotice": {
        description:
          "Red notice under the audio preview after an upload attempt failed for a " +
          "reason other than being offline. The reassurance matters most: the " +
          "recording is still in hand and the Save button is still there, so the " +
          "user can simply press it again. The raw technical error is appended in " +
          "parentheses — keep the parentheses.",
        placeholders: {
          error:
            "The underlying error message, usually untranslated technical text from " +
            "the browser or server.",
        },
      },
      "audio.recordingModal.savedStatus": {
        description:
          "Brief success message shown right after a recording is saved, just " +
          "before the dialog auto-advances to the next line.",
      },
      "audio.recordingModal.idleHintPrefix": {
        description:
          "First half of a two-part instructional sentence shown before recording " +
          "starts: '{this} <Space key> {suffix}'. The literal word 'Space' between " +
          "this and audio.recordingModal.idleHintSuffix is rendered as a keyboard-key " +
          "chip and is not itself a translatable key (keyboard key names are kept as " +
          "printed on the key). Word order may need to move the whole sentence around " +
          "the key chip in the target language; approximate the same meaning.",
      },
      "audio.recordingModal.idleHintSuffix": {
        description:
          "Second half of the same instructional sentence as " +
          "audio.recordingModal.idleHintPrefix, continuing after the 'Space' key chip.",
      },
      "audio.recordingModal.genericError": {
        description:
          "Fallback error text shown in the recording dialog's error state when the " +
          "underlying failure has no specific message of its own. Distinct from the " +
          "app-wide error.generic.title heading — this is inline status text inside " +
          "the recorder, not a full failure screen.",
      },
      "audio.recordingModal.errorHint": {
        description:
          "Small caption under the error message, telling the user how to try " +
          "again. 'Space' here is the same kind of keyboard-key reference as in " +
          "audio.recordingModal.idleHintPrefix.",
      },
      "audio.recordingModal.prevCellTooltip": {
        description:
          "Tooltip for the footer's previous-line navigation button, including its " +
          "arrow-key shortcut hint.",
      },
      "audio.recordingModal.prevButton": {
        description:
          "Visible label of the footer's previous-line navigation button (paired " +
          "with a left-chevron icon).",
        maxLength: 12,
      },
      "audio.recordingModal.nextCellTooltip": {
        description:
          "Tooltip for the footer's next-line navigation button, including its " +
          "arrow-key shortcut hint.",
      },
      "audio.recordingModal.retakeTooltip": {
        description:
          "Tooltip for the 'record again' button shown after a take is captured, " +
          "including its keyboard shortcut hint.",
      },
      "audio.recordingModal.retakeButton": {
        description:
          "Visible label of the 'record again' button, discarding the current " +
          "preview and starting a fresh recording.",
        maxLength: 14,
      },
      "audio.recordingModal.saveTooltip": {
        description:
          "Tooltip for the button that saves the previewed recording as the line's " +
          "take, including its keyboard shortcut hint. The button's own visible " +
          "label reuses common.save.",
      },
      "audio.recordingModal.stopTooltip": {
        description:
          "Tooltip for the button that stops an in-progress recording, including " +
          "its keyboard shortcut hint.",
      },
      "audio.recordingModal.startButton": {
        description:
          "Visible label of the button that begins the countdown-then-record flow " +
          "from the idle or error state.",
        maxLength: 14,
      },
      "audio.recordingModal.startTooltip": {
        description:
          "Tooltip for the Start button, naming its keyboard shortcut. 'Space' is " +
          "the space bar and is kept as printed on the key, like the other key " +
          "hints in this dialog.",
      },
      "audio.recordingModal.generateTtsButton": {
        description:
          "Visible label of the button beside Start that synthesizes this line's " +
          "audio with a text-to-speech voice instead of recording a human one. " +
          "'TTS' is the industry abbreviation for text-to-speech; keep it if it is " +
          "recognised in the target language, otherwise use the local short form.",
        maxLength: 18,
      },
      "audio.recordingModal.ttsTooltip": {
        description:
          "Tooltip for that synthesize button in its ready state. 'The project's " +
          "engine' means the text-to-speech service configured for this project, so " +
          "the user knows no choice is being asked of them here.",
      },
      "audio.recordingModal.ttsNeedsTranslation": {
        description:
          "Tooltip for the synthesize button while it is disabled because the line " +
          "has no translated text yet — there is nothing for a voice to read. " +
          "Phrased as the action that unblocks it.",
      },
      "audio.recordingModal.ttsDoneTooltip": {
        description:
          "Tooltip for the synthesize button right after it succeeded, saying where " +
          "the result can be heard. 'Target track' is the name of the timeline lane " +
          "holding the translated audio — translate it the same way as the lane's " +
          "own label.",
      },
      "audio.recordingModal.cancelCountdown": {
        description:
          "Button shown only during the 3-2-1 countdown that aborts it before " +
          "recording starts, returning to the idle state.",
        maxLength: 20,
      },
      "audio.takesStrip.heading": {
        description:
          "Small caption above the row of take chips for the current line, naming " +
          "how many takes exist. A 'take' is one recorded attempt at this line — " +
          "there can be several, and the user picks which one to keep.",
        placeholders: {
          count: "Number of takes recorded for this line so far.",
        },
      },
      "audio.takesStrip.cleanedLabel": {
        description:
          "Label on a take chip meaning this take is a noise-reduced ('denoised') " +
          "copy of an earlier take, not an original recording. Short, sits beside a " +
          "small icon.",
        maxLength: 12,
      },
      "audio.takesStrip.takeFallback": {
        description:
          "Placeholder name for a take row that has no stored name yet — takes are " +
          "named ('Take 1', 'Take 2', …) and users can rename them, but those names " +
          "are stored data and are never translated. This word only fills the gap " +
          "for an older recording until its name is filled in, so it should be the " +
          "bare noun for one recorded attempt, with no number.",
        maxLength: 12,
      },
      "audio.takesStrip.renameTooltip": {
        description:
          "Tooltip and accessible name for the small pencil button on a take row " +
          "that turns its name into an editable text box.",
      },
      "audio.takesStrip.unknownLengthTooltip": {
        description:
          "Hover title on the '?' shown in place of a take's duration when the app " +
          "never captured how long that recording is — an older take saved before " +
          "durations were measured. Names the two ways to fix it.",
      },
      "audio.takesStrip.pendingSyncTooltip": {
        description:
          "Hover title on the cloud badge of a take that has been saved on this " +
          "device but not yet uploaded to the server. Reassurance: nothing is lost " +
          "while it waits.",
      },
      "audio.takesStrip.playTakeTooltip": {
        description:
          "Tooltip and accessible name for a take chip's play button, shown while " +
          "that take is not playing (pressing it plays this one take).",
      },
      "audio.takesStrip.removeNoiseTooltip": {
        description:
          "Tooltip and accessible name for the button on an original take that runs " +
          "on-device noise removal, producing a new 'Cleaned' take alongside it.",
      },
      "audio.takesStrip.revertTooltip": {
        description:
          "Tooltip and accessible name for the button on a cleaned take that " +
          "switches selection back to the original recording it was cleaned from.",
      },
      "audio.takesStrip.activeTakeTooltip": {
        description:
          "Tooltip and accessible name for a take chip's selection button, shown " +
          "when that take is already the one currently in use for this line (the " +
          "button is disabled in this state).",
      },
      "audio.takesStrip.useTakeTooltip": {
        description:
          "Tooltip and accessible name for a take chip's selection button, shown " +
          "for a take that is NOT currently in use — pressing it makes this the " +
          "active take for the line.",
      },
      "audio.takesStrip.deleteTakeTooltip": {
        description:
          "Tooltip and accessible name for the button that permanently deletes one " +
          "take from the line.",
      },
      "audio.library.searchPlaceholder": {
        description:
          "Placeholder in the search box above a list of voices, which filters the list by " +
          "name as the user types. Used by the Voices sidebar panel and by the voice picker " +
          "on a single cell, either of which can hold dozens of voices. Ends with a single " +
          "ellipsis glyph.",
      },
      "audio.library.noVoicesYet": {
        description:
          "Empty-state message shown in the Voices list when the project has no " +
          "voices at all yet (before any search is typed).",
      },
      "audio.library.rowHint": {
        description:
          "Tooltip on a voice row in the sidebar, explaining its two interactions: " +
          "click to make it the active/selected voice, or drag it onto a line in the " +
          "editor to assign that voice to that line.",
      },
      "audio.library.narratorHint": {
        description:
          "Tooltip on the small narrator badge/star shown on the project's default " +
          "voice, explaining what 'narrator' means here (see audio.narrator).",
      },
      "audio.library.moreActionsLabel": {
        description:
          "Accessible name (not visible text) for the '⋯' overflow-menu button on a " +
          "voice row, which opens Edit / Set as narrator / Delete actions.",
      },
      "audio.library.moreTooltip": {
        description:
          "Tooltip for the same '⋯' overflow-menu button, shown as visible hover " +
          "text rather than to assistive tech.",
        maxLength: 12,
      },
      "audio.library.setNarrator": {
        description:
          "Item in a voice row's overflow menu that sets this voice as the " +
          "project's default narrator (see audio.narrator). Hidden once a voice is " +
          "already the narrator.",
      },
      "audio.library.voicedStats": {
        description:
          "Small status text on a voice row showing how many of the lines assigned " +
          "to this voice already have generated/recorded audio, out of how many are " +
          "assigned in total.",
        placeholders: {
          voiced: "Count of assigned lines that already have audio.",
          assigned: "Total count of lines assigned to this voice in the current file.",
        },
      },
      "audio.library.noLinesYet": {
        description:
          "Fallback status text on a voice row (instead of audio.library.voicedStats) " +
          "when this voice isn't the narrator and has no lines assigned to it at all.",
      },
      "audio.library.cloneEngineLabel": {
        description:
          "Small label on a voice row naming its engine, shown for voices that are " +
          "clones (built from a reference clip) rather than plain TTS voices.",
        maxLength: 12,
      },
      "audio.clone.title": {
        description:
          "Section heading inside the voice editor's Clone tab, above the " +
          "record/upload controls for the reference clip.",
      },
      "audio.clone.activeBadge": {
        description:
          "Small badge shown beside audio.clone.title once a reference clip has " +
          "been attached, confirming cloning is set up for this voice.",
        maxLength: 12,
      },
      "audio.clone.description": {
        description:
          "Explanatory paragraph under the Clone section heading, describing what a " +
          "reference clip is for and naming the underlying technology (Seed-VC) that " +
          "does the re-voicing. 'Seed-VC' is a proper name — do not translate it.",
      },
      "audio.clone.needsContext": {
        description:
          "Message shown instead of the record/upload controls when this section is " +
          "opened without an active project/file context to upload into (e.g. a " +
          "detached preview).",
      },
      "audio.clone.removeButton": {
        description:
          "Button shown once a reference clip is attached that deletes it, reverting " +
          "the voice back to plain (non-cloned) TTS.",
        maxLength: 16,
      },
      "audio.clone.replaceButton": {
        description:
          "Button shown once a reference clip is attached that lets the user pick a " +
          "new audio file to replace it.",
        maxLength: 16,
      },
      "audio.clone.stopRecordingButton": {
        description:
          "Button shown while recording a reference clip that stops the capture, " +
          "with the elapsed time counting up beside the label.",
        placeholders: {
          seconds: "Elapsed recording time in seconds, to one decimal place.",
        },
      },
      "audio.clone.recordButton": {
        description:
          "Button that starts recording a fresh reference clip from the microphone, " +
          "shown when no clip is attached yet.",
        maxLength: 20,
      },
      "audio.clone.uploadButton": {
        description:
          "Button that opens a file picker to upload an existing audio file as the " +
          "reference clip, shown when no clip is attached yet.",
        maxLength: 20,
      },
      "audio.clone.errorNoContext": {
        description:
          "Inline error shown if an upload is attempted with no project/file to " +
          "upload into (an unexpected state, not a normal user mistake).",
      },
      "audio.clone.errorTooLarge": {
        description:
          "Inline error shown when the chosen reference file exceeds the 8 MB size " +
          "limit, with guidance that only a short clip is actually needed.",
      },
      "audio.clone.previewTooltip": {
        description:
          "Tooltip on the small play button next to an attached reference clip, " +
          "offering to play it back so the user can confirm it's the right audio.",
      },
      "audio.clone.previewFailed": {
        description:
          "Visible label the preview button switches to if playback of the " +
          "reference clip fails to load.",
        maxLength: 16,
      },
      "audio.bulkProgress.cancelTooltip": {
        description:
          "Tooltip and accessible name for the small 'x' button on the bulk-progress " +
          "banner that cancels the running batch job.",
      },
    },
  },
  surfaces: [
    {
      id: "audio-studio",
      title: "Audio Studio",
      route: "/project/:projectId/voice",
      notes:
        "The Audio lens: left Voices sidebar (select/create/edit/delete voices), " +
        "center editor rows with per-line record/generate controls, and a bottom " +
        "transport bar for playback. Take chips, record dialog, and clone-reference " +
        "controls all nest inside this surface's dialogs and panels.",
    },
  ],
})
