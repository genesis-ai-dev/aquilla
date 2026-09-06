import { defineNamespace, plural } from "./types"

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
    "audio.newVoice.kokoroLabel": "Voice",
    "audio.newVoice.kokoroPlaceholder": "e.g. af_bella",
    "audio.newVoice.kokoroGroupAmerican": "American English",
    "audio.newVoice.kokoroGroupBritish": "British English",
    "audio.newVoice.kokoroGenderFemale": "Female",
    "audio.newVoice.kokoroGenderMale": "Male",
    "audio.newVoice.kokoroEnglishOnlyHint":
      "On-device Kokoro speaks English. Pick an American or British voice, or switch this line to OmniVoice, Gemini, or MMS.",
    "audio.newVoice.kokoroPlaySample": "Play {name} sample",
    "audio.newVoice.kokoroStopSample": "Stop {name} sample",
    "audio.newVoice.mmsLanguageLabel": "Language",
    "audio.newVoice.singleVoiceHint":
      "{engine} uses a single neural voice. Use the Clone tab to make it sound like a specific person.",
    "audio.newVoice.referenceLabel": "Reference audio",
    "audio.newVoice.tabFromLine": "From a line",
    "audio.newVoice.referenceSourceGroupLabel": "Reference clip source",
    "audio.newVoice.referenceDescription":
      "A short clip is enough (5–15s of one clear speaker) — we generate a base voice and clone it to match.",
    "audio.newVoice.fromLineEmpty":
      "No line audio yet. Record or generate a take first, or use Reference audio.",
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
    "audio.recordingModal.muteVideoTooltip": "Mute the scene video",
    "audio.recordingModal.unmuteVideoTooltip": "Unmute the scene video",
    "audio.recordingModal.videoMutedBadge": "Muted",
    "audio.recordingModal.videoMutedWhileRecording":
      "The scene plays muted while recording so it can't bleed into your take.",
    "audio.recordingModal.videoScenePreview": "Scene for this line — plays while you record.",
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
    "audio.recordingModal.ttsNoLinkedLine": "No subtitle is linked to this heard line, so there are no words to speak. Pair it with a subtitle first.",
    "audio.recordingModal.ttsDoneTooltip": "Voice generated — it plays on the Target track",
    // AQU-646: leaving the recorder with a take that was never attached.
    "audio.recordingModal.unsavedTakeTitle": "Keep this take?",
    "audio.recordingModal.unsavedTakeBody":
      "You recorded a take and haven't saved it yet. Leaving this line without saving throws it away.",
    "audio.recordingModal.discardTake": "Throw it away",
    "audio.recordingModal.saveTake": "Save take",
    // AQU-646 stage 4c: what the button says when generation failed, while it
    // is downloading a local voice model, and while it is synthesizing.
    "audio.recordingModal.ttsFailedButton": "TTS failed",
    "audio.recordingModal.ttsFailedTooltip": "Generation failed: {error}",
    "audio.recordingModal.ttsDownloadingPct": "Downloading {percent}%",
    "audio.recordingModal.cancelCountdown": "Cancel countdown",

    // AudioRecordingModal, AQU-646 rebuild — the film panel beside the
    // recorder, the two-row header, the per-phase notices, and the utility
    // strip along the bottom (takes / recording format / recorder settings).
    // Keys above with near-identical wording belong to the pre-rebuild layout
    // and are still translated; these are the strings the dialog renders now.
    "audio.recordingModal.collapseFilmTooltip": "Hide the film and use the narrow recorder",
    "audio.recordingModal.collapseFilmAriaLabel": "Hide the film",
    "audio.recordingModal.collapseFilmButton": "Collapse video",
    "audio.recordingModal.expandFilmTooltip": "Show the film for this line beside the recorder",
    "audio.recordingModal.expandFilmAriaLabel": "Show the film",
    "audio.recordingModal.prevLineTooltip": "Previous line (⌥←)",
    "audio.recordingModal.nextLineTooltip": "Next line (⌥→)",
    "audio.recordingModal.veryShortWindowTitle":
      "This section is very short — you can still record, but there is barely room for anything.",
    "audio.recordingModal.lineCounter": "{index} / {total}",
    "audio.recordingModal.lineCounterWindow": "{index} / {total} · window {seconds}s",
    "audio.recordingModal.lineCounterVeryShort":
      "{index} / {total} · window {seconds}s · very short",
    "audio.tts.voicedSeveral": plural({
      one: "Voiced {count} heard line",
      other: "Voiced {count} heard lines",
    }),
    "audio.tts.voicedSeveralDetail":
      "This subtitle is performed by several heard lines, so each one was given the whole subtitle. Trim them to fit.",
    "audio.tts.mixedCharacters": plural({
      one: "{count} heard line had more than one character",
      other: "{count} heard lines had more than one character",
    }),
    "audio.tts.mixedCharactersDetail":
      "Each was voiced as the character on its first line. Check them if the wrong voice would matter.",
    "audio.tts.siblingFailed": plural({
      one: "{count} heard line could not be voiced",
      other: "{count} heard lines could not be voiced",
    }),
    "audio.tts.siblingFailedDetail":
      "The clip you played was saved. Delete it and press the button again to retry the rest.",
    "audio.recordingModal.cueReferenceLabel": "This cue:",
    "audio.recordingModal.ttsSharedNotice": plural({
      one: "{count} heard line performs this subtitle. A generated voice speaks the whole subtitle onto this one, and leaves the others silent.",
      other: "{count} heard lines perform this subtitle. A generated voice speaks the whole subtitle onto this one, and leaves the others silent.",
    }),
    "audio.recordingModal.maxDuration": "max {minutes}m",
    "audio.recordingModal.overrunNotice": "Past the window — this will overrun the cue.",
    "audio.recordingModal.nearLimitNotice":
      "Recording is {warnMinutes} minutes — it stops automatically at {hardStopMinutes}.",
    "audio.recordingModal.capturedNotice": "Captured — review, then keep or retake.",
    "audio.recordingModal.noTimedWindow": "This line has no timed window.",
    "audio.recordingModal.generateButton": "Generate",
    "audio.recordingModal.uploadTooltip": "Attach an audio file as a take",
    "audio.recordingModal.uploadButton": "Upload",
    "audio.recordingModal.takesLabel": "Takes",
    "audio.recordingModal.formatLockedTooltip":
      "This take is already captured — the format applies to the next one.",
    "audio.recordingModal.formatWavTooltip":
      "Recording at full WAV quality — about three times the file size. Click to record " +
      "compressed instead.",
    "audio.recordingModal.formatCompressedTooltip":
      "Recording compressed — much smaller files, slightly less detail. Click to record at " +
      "full WAV quality.",
    "audio.recordingModal.formatWavAriaLabel": "Recording format: WAV — click to record compressed",
    "audio.recordingModal.formatCompressedAriaLabel":
      "Recording format: compressed — click to record in WAV",
    "audio.recordingModal.settingsAriaLabel": "Recorder settings",
    "audio.recordingModal.autoAdvanceTitle": "Move on after saving",
    "audio.recordingModal.autoAdvanceOnDescription": "Jumps to the next line",
    "audio.recordingModal.autoAdvanceOffDescription": "Stays on this line",
    "audio.recordingModal.beepTitle": "Countdown beep",
    "audio.recordingModal.beepOnDescription": "3-2-1 tones before recording",
    "audio.recordingModal.beepOffDescription": "Silent countdown",
    "audio.recordingModal.noTakesYet": "No takes yet — record one and it lands here.",

    // RecordingVideoSurface — the film panel inside that dialog, and the
    // headphones-only control that lets its sound out.
    "audio.recordingModal.filmAriaLabel": "Film for the line being recorded",
    "audio.recordingModal.filmAudibleTooltip":
      "The film is playing out loud. Unless you are on headphones it is going into your take " +
      "— click to mute it.",
    "audio.recordingModal.filmMutedTooltip":
      "The film is muted. Unmuting is for headphones only — the mic records with echo " +
      "cancellation off, so on speakers the film goes into your take.",
    "audio.recordingModal.filmMuteAriaLabel": "Mute the film",
    "audio.recordingModal.filmUnmuteAriaLabel": "Unmute the film (headphones only)",
    "audio.recordingModal.filmAudibleWarning":
      "The film is not muted. Use headphones — on speakers it will be recorded into your take.",

    // TakesStrip — per-cell recorded-take management row.
    "audio.takesStrip.heading": "Takes ({count})",
    "audio.takesStrip.cleanedLabel": "Cleaned",
    "audio.takesStrip.takeFallback": "Take",
    "audio.takesStrip.renameTooltip": "Rename take",
    "audio.takesStrip.unknownLengthTooltip": "Length unknown — re-record or re-upload to fix",
    "audio.takesStrip.pendingSyncTooltip": "Saving — kept safe on this device until it syncs",
    "audio.takesStrip.syncFailedTooltip":
      "Couldn't save to the server — this take is still on this device. Retry to send it again.",
    "audio.takesStrip.syncFailedRetry": "Not saved — retry",
    "audio.takesStrip.textDriftBadge": "Text changed",
    "audio.takesStrip.textDriftTooltip":
      "Recorded {date}, when this line read: “{text}”. The text has changed since — " +
      "re-record to match, or keep this take if you are reviewing the older wording.",
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
    "audio.library.setNarrator": "Make narrator",
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
    "audio.clone.dropzoneTitle": "Add a reference clip",
    "audio.clone.dropzoneHint":
      "A short clip is enough (5–15s of one clear speaker) — we generate a base voice and clone it to match.",
    "audio.clone.dropzoneDrop": "Drop to use as the reference",
    "audio.clone.errorNotAudio": "That file isn't audio. Use a short recording.",
    "audio.clone.errorNoContext": "No project context for upload.",
    "audio.clone.errorTooLarge": "Reference clip too large (max 8 MB). Use a few seconds.",
    "audio.clone.previewTooltip": "Preview reference clip",
    "audio.clone.previewFailed": "Preview failed",

    // AudioBulkProgressBanner — batch transcribe-all / synth-all progress.
    "audio.bulkProgress.cancelTooltip": "Cancel batch",

    // GEMINI_TTS_VOICES (tts-providers.ts) — tone/character description for
    // each named Gemini voice. Several voices share the same description
    // (Google's own catalog repeats these words across voices), so this is
    // one key per DISTINCT description, not one per voice.
    "audio.voice.bright": "Bright",
    "audio.voice.upbeat": "Upbeat",
    "audio.voice.informative": "Informative",
    "audio.voice.firm": "Firm",
    "audio.voice.excitable": "Excitable",
    "audio.voice.youthful": "Youthful",
    "audio.voice.breezy": "Breezy",
    "audio.voice.easyGoing": "Easy-going",
    "audio.voice.breathy": "Breathy",
    "audio.voice.clear": "Clear",
    "audio.voice.smooth": "Smooth",
    "audio.voice.gravelly": "Gravelly",
    "audio.voice.soft": "Soft",
    "audio.voice.even": "Even",
    "audio.voice.mature": "Mature",
    "audio.voice.forward": "Forward",
    "audio.voice.friendly": "Friendly",
    "audio.voice.casual": "Casual",
    "audio.voice.gentle": "Gentle",
    "audio.voice.lively": "Lively",
    "audio.voice.knowledgeable": "Knowledgeable",
    "audio.voice.warm": "Warm",

    // TTS_PROVIDER_INFOS (tts-providers.ts) — one-line explanatory hint per
    // TTS engine, shown as a tooltip on the engine picker card in
    // NewVoiceModal. (Each engine's `title`/`shortTitle` stays plain English —
    // see audio.newVoice.singleVoiceHint's context note — so only the hint
    // sentence is keyed here.)
    "audio.provider.omnivoiceHint":
      "Runs on our servers. No key or download; usage is cloud-metered. Supports voice cloning from a reference recording.",
    "audio.provider.geminiHint": "BYOK Google AI key. Promptable, high-quality voices.",
    "audio.provider.kokoroHint": "Runs in-browser after a one-time local model download.",
    "audio.provider.mmsHintSherpa": "Local browser voices loaded from the Sherpa-ONNX MMS mirror.",
    "audio.provider.mmsHintHosted": "Local browser voices loaded from the hosted MMS model bucket.",
    "audio.provider.mmsHintFallback": "Local browser voices for supported MMS language repos.",

    // CastGutterVoice — the small per-row character/voice avatar in the
    // stacked media lens' text-table gutter.
    "audio.castGutter.namedTooltip": "{castName} — voiced by {voiceName}",
    "audio.castGutter.defaultTooltip": "{voiceName} — default (no one cast yet)",
    "audio.castGutter.chooseCharacterAriaLabel": "{tooltip}. Choose a character",
    "audio.castGutter.noCharacter": "No character",

    // useCellAudio — errors surfaced while loading/streaming a cell's audio.
    "audio.error.noAttachment": "No audio attachment on this cell",
    "audio.error.legacyLfsUnsupported": "Unsupported audio URL (legacy LFS): {url}",
    "audio.error.notSignedIn": "Not signed in",
    "audio.error.recordingDeleted": "This audio recording has been deleted and cannot be played.",
    "audio.error.streamingFailed": "Playback failed — the media source could not be streamed.",

    // play-queue — multi-cell playback queue error, shown in VoicePlaybackBar.
    "audio.error.queueLoadFailed": "Audio failed to load",

    // transcribe.ts — guard-clause errors before a per-cell transcription
    // attempt starts, categorized and shown via CellTranscribeBadge.
    "audio.error.noDownloadableAudio":
      "This recording has no downloadable audio yet. Try again after it finishes syncing.",
    "audio.error.notTranscribableLocation": "This audio isn't stored in a transcribable location.",
    "audio.error.signInToTranscribe": "Sign in to transcribe audio.",

    // ai-consent.ts — display name of each heavy in-browser AI model, shown
    // in the first-run download-consent dialog (AiModelConsentDialog).
    "audio.consent.whisperLabel": "Whisper (transcription)",
    "audio.consent.kokoroLabel": "Kokoro (text-to-speech)",
    "audio.consent.mmsLabel": "MMS (multilingual TTS)",

    // ai-error.ts categorizeAiError() — plain-language heading for each
    // failure category, shown as the popover title (InlineAiError et al.).
    "audio.aiError.dailyLimitTitle": "Daily AI limit reached",
    "audio.aiError.modelNotAvailableTitle": "Model not available",
    "audio.aiError.tooLargeTitle": "Too much text for this model",
    "audio.aiError.geminiKeyRequiredTitle": "Gemini API key required",
    "audio.aiError.geminiFailedTitle": "Gemini TTS failed",
    "audio.aiError.omnivoiceNotConfiguredTitle": "OmniVoice isn't configured",
    "audio.aiError.omnivoiceFailedTitle": "OmniVoice TTS failed",
    "audio.aiError.seedVcNotConfiguredTitle": "Voice cloning isn't configured",
    "audio.aiError.seedVcFailedTitle": "Voice cloning failed",
    "audio.aiError.signInRequiredTitle": "Sign in required",
    "audio.aiError.gitProjectUnsupportedTitle": "Not yet supported on git projects",
    "audio.aiError.nothingToReadTitle": "Nothing to read aloud",
    "audio.aiError.translationNotConfiguredTitle": "Translation not configured",
    "audio.aiError.ttsNotConfiguredTitle": "Voice generation isn't set up",
    "audio.aiError.translationFailedTitle": "Translation failed",
    "audio.aiError.networkTitle": "Network error",
    "audio.aiError.modelLoadFailedTitle": "Couldn't load model",
    "audio.aiError.audioFormatUnsupportedTitle": "Audio format not supported",
    "audio.aiError.timedOutTitle": "The request timed out",
    "audio.aiError.rateLimitedTitle": "Too many requests right now",
    "audio.aiError.providerUnavailableTitle": "The AI service is unavailable",
    "audio.aiError.providerRejectedTitle": "The AI provider rejected this request",
    "audio.aiError.unknownTitle": "Something went wrong",
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
          "Form label above the row of TTS engine choice cards. On the TTS tab " +
          "this is all four engines (OmniVoice, Gemini, Kokoro, MMS). On the Clone " +
          "tab it is only the cloud engines that can clone a reference clip " +
          "(OmniVoice, Gemini) — on-device engines are omitted, not shown disabled. " +
          "'Engine' means which speech-synthesis backend generates this voice's audio.",
      },
      "audio.newVoice.describeLabel": {
        description:
          "Label for a free-text field, shown when the Gemini engine is selected " +
          "(TTS tab or Clone tab). The user describes in plain words how the voice " +
          "should sound (tone, age, mood). On a clone this describes the base take " +
          "that is then re-voiced to match the reference clip — it is not the cloned " +
          "identity.",
      },
      "audio.newVoice.describePlaceholder": {
        description:
          "Placeholder example text inside the empty 'describe the voice' textarea, " +
          "showing the kind of description that works well.",
      },
      "audio.newVoice.kokoroLabel": {
        description:
          "Label for the voice-picker dropdown shown only when the Kokoro engine is " +
          "selected. Lists Kokoro's built-in American and British speakers. 'Kokoro' " +
          "is the engine's proper name — do not translate it if it appears nearby.",
      },
      "audio.newVoice.kokoroPlaceholder": {
        description:
          "Placeholder example inside the empty Kokoro voice-id field, showing the " +
          "format of a real id. The example code itself ('af_bella') is data, not " +
          "prose — keep it as-is; only 'e.g.' needs translating.",
      },
      "audio.newVoice.kokoroGroupAmerican": {
        description:
          "Section heading inside the Kokoro voice dropdown for American English speakers.",
      },
      "audio.newVoice.kokoroGroupBritish": {
        description:
          "Section heading inside the Kokoro voice dropdown for British English speakers.",
      },
      "audio.newVoice.kokoroGenderFemale": {
        description:
          "Short gender tag next to a female Kokoro speaker's name in the dropdown.",
      },
      "audio.newVoice.kokoroGenderMale": {
        description:
          "Short gender tag next to a male Kokoro speaker's name in the dropdown.",
      },
      "audio.newVoice.kokoroEnglishOnlyHint": {
        description:
          "Helper under the Kokoro voice dropdown when the project's target language " +
          "is not English. Tells the user Kokoro only speaks English and names the " +
          "other engines that can speak other languages. 'Kokoro', 'OmniVoice', " +
          "'Gemini', and 'MMS' are engine names — do not translate them.",
      },
      "audio.newVoice.kokoroPlaySample": {
        description:
          "Accessible name of the play button that previews a Kokoro speaker. " +
          "{name} is the speaker's given name (Heart, Bella, George).",
        placeholders: {
          name: "The Kokoro speaker's given name, e.g. Heart or Bella.",
        },
      },
      "audio.newVoice.kokoroStopSample": {
        description:
          "Accessible name of the same button while that speaker's sample is playing.",
        placeholders: {
          name: "The Kokoro speaker's given name, e.g. Heart or Bella.",
        },
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
          "Tab label (and formerly the field label) for recording or uploading a " +
          "fresh reference clip on the Clone tab. Paired with audio.newVoice.tabFromLine. " +
          "'Reference audio' is the short clip the cloned voice will be made to sound like.",
        maxLength: 22,
      },
      "audio.newVoice.tabFromLine": {
        description:
          "Tab label on the Clone tab for picking an existing take from a project " +
          "line as the clone reference, instead of recording or uploading a new clip. " +
          "Paired with audio.newVoice.referenceLabel.",
        maxLength: 18,
      },
      "audio.newVoice.referenceSourceGroupLabel": {
        description:
          "Accessible group label (not visible text) for the Reference audio / From a " +
          "line tab pair, read by screen readers to announce what the two tabs are " +
          "choosing between.",
      },
      "audio.newVoice.referenceDescription": {
        description:
          "Same wording as audio.clone.dropzoneHint. Kept so existing translations " +
          "do not go missing; the live UI reads dropzoneHint inside the dashed zone.",
      },
      "audio.newVoice.fromLineEmpty": {
        description:
          "Empty-state copy on the From a line tab when this file has no recorded or " +
          "generated takes to reuse as a clone reference.",
      },
      "audio.newVoice.reuseTakeSummary": {
        description:
          "Unused in the current UI (the Clone tab now uses audio.newVoice.tabFromLine). " +
          "Kept so existing translations do not go missing. Was the collapsed summary " +
          "label for reusing a line's audio as the clone reference.",
      },
      "audio.newVoice.takeRecorded": {
        description:
          "Unused in the current UI (From a line now uses a checkmark for the " +
          "chosen take, not a Recorded badge). Kept so existing translations do " +
          "not go missing.",
        maxLength: 16,
      },
      "audio.newVoice.takeGenerated": {
        description:
          "Accessible name and tooltip for a sparkle icon on a listed take meaning " +
          "this clip was produced by AI text-to-speech rather than recorded.",
        maxLength: 16,
      },
      "audio.newVoice.liftingTake": {
        description:
          "Accessible name on the in-row spinner shown while a reused take " +
          "(From a line tab) is being copied into this voice's clone reference. " +
          "Replaces the checkmark until the copy finishes.",
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
      "audio.recordingModal.muteVideoTooltip": {
        description:
          "Tooltip and accessible name for the button that mutes the linked scene " +
          "video shown inside the recording dialog, used while its sound is on.",
      },
      "audio.recordingModal.unmuteVideoTooltip": {
        description:
          "Tooltip and accessible name for the same button while the scene video is " +
          "already muted (pressing it turns the video's sound back on).",
      },
      "audio.recordingModal.videoMutedBadge": {
        description:
          "Very short badge drawn over the top-right corner of the scene video while " +
          "its sound is off. Keep it to one word if the language allows.",
      },
      "audio.recordingModal.videoMutedWhileRecording": {
        description:
          "Explains why the scene video's sound is forced off during a take: an " +
          "audible video would be picked up by the microphone ('bleed into your " +
          "take' is recording-studio idiom for exactly that).",
      },
      "audio.recordingModal.videoScenePreview": {
        description:
          "Caption under the scene video between takes, naming what the video is " +
          "(the footage for the line being dubbed) and when it will play.",
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
      "audio.tts.voicedSeveral": {
        description:
          "Toast title after one press of a line's voice button generated more " +
          "than one clip, which happens when the subtitle is performed by " +
          "several heard lines (about 8% of lines). Only one clip can be played " +
          "back, so without this the rest are invisible work. The count is how " +
          "many were actually written, not how many were attempted.",
        placeholders: { count: "How many clips were generated. Always 2 or more." },
      },
      "audio.tts.voicedSeveralDetail": {
        description:
          "Toast body for the above: why there is more than one clip, and what " +
          "to do about it — each clip says the whole subtitle rather than just " +
          "its own line's share, so they need trimming.",
      },
      "audio.tts.mixedCharacters": {
        description:
          "Toast title after a bulk voice generation, when a heard line was " +
          "performed by subtitle lines with DIFFERENT characters assigned. " +
          "Measured on the client's own episode: 96 heard lines cover two or " +
          "more subtitles, of which 5 disagree about the character. The run " +
          "generates in the first line's character (Sam's ruling) and reports " +
          "the rest here rather than silently choosing.",
        placeholders: { count: "How many heard lines had disagreeing characters." },
      },
      "audio.tts.mixedCharactersDetail": {
        description:
          "Toast body for the above: which character was used, and that it is " +
          "worth a look rather than an error.",
      },
      "audio.tts.siblingFailed": {
        description:
          "Error toast after one press of a line's voice button, when the " +
          "subtitle is performed by several heard lines and some of the extra " +
          "clips failed to generate. The primary clip succeeded (the user just " +
          "heard it), so without this the failure is invisible and those lines " +
          "stay silent in the dub.",
        placeholders: { count: "How many heard lines failed." },
      },
      "audio.tts.siblingFailedDetail": {
        description:
          "Toast body for the above: reassures that the clip they heard is " +
          "safe, and names the only recovery path — the button becomes a replay " +
          "button once the first clip lands, so retrying means removing it.",
      },
      "audio.recordingModal.ttsSharedNotice": {
        description:
          "Notice in the recorder, shown AFTER a voice has been generated, and " +
          "only when the subtitle being performed is split across several " +
          "heard lines (about 8% of lines). It explains what the generation " +
          "just did: the synthesized clip says the whole subtitle rather than " +
          "only this line's share, and the other heard lines performing the " +
          "same subtitle got no audio from it — so it reads as a to-do, naming " +
          "what is still silent. Always at least 2, so the plural is safe.",
        placeholders: { count: "How many heard lines perform this subtitle. Always 2 or more." },
      },
      "audio.recordingModal.ttsNoLinkedLine": {
        description:
          "Tooltip on the recorder's disabled Generate-voice button when this " +
          "heard line is not paired with any subtitle, so there are no words " +
          "to speak. Distinct from the untranslated case, which is a different " +
          "problem with a different fix.",
      },
      "audio.recordingModal.ttsNeedsTranslation": {
        description:
          "Tooltip for the synthesize button while it is disabled because the line " +
          "has no translated text yet — there is nothing for a voice to read. " +
          "Phrased as the action that unblocks it.",
      },
      "audio.recordingModal.unsavedTakeTitle": {
        description:
          "Heading of the confirmation shown when someone tries to leave the " +
          "recorder while a take they just recorded has not been saved. Asked " +
          "as a question because both answers are reasonable.",
      },
      "audio.recordingModal.unsavedTakeBody": {
        description:
          "Body of that confirmation. States plainly that the recording is not " +
          "stored yet and what leaving would cost, because nothing on screen " +
          "otherwise distinguishes a saved take from an unsaved one. Says " +
          "LEAVING THIS LINE rather than closing: the same confirmation now " +
          "also covers the previous/next arrows, which step to another line " +
          "without closing the recorder (2026-08-27).",
      },
      "audio.recordingModal.discardTake": {
        description:
          "The button that leaves the recorder WITHOUT keeping the take. " +
          "Worded concretely rather than as 'Discard' so it cannot be misread " +
          "as merely dismissing the question.",
      },
      "audio.recordingModal.saveTake": {
        description:
          "The button that keeps the take, on that same confirmation. Matches " +
          "the recorder's own Save control, which is what it triggers.",
      },
      "audio.recordingModal.ttsFailedButton": {
        description:
          "Visible label of the recorder's voice button after generation " +
          "failed. Two words on purpose: the button is about half the panel " +
          "wide, and the actual reason is written out in full on the line " +
          "beneath it, so this only has to say THAT it failed. 'TTS' is the " +
          "industry abbreviation for text-to-speech; keep it if it is " +
          "recognised in the target language, otherwise use the local short " +
          "form.",
        maxLength: 16,
      },
      "audio.recordingModal.ttsFailedTooltip": {
        description:
          "Hover text on that failed button, carrying the verbatim technical " +
          "error. The user-facing explanation is the line beneath the button, " +
          "not this — this exists so the raw text can be read and passed on to " +
          "support without it being the first thing anyone sees.",
        placeholders: {
          error:
            "The underlying error message, usually untranslated technical text " +
            "from the browser or the voice server.",
        },
      },
      "audio.recordingModal.ttsDownloadingPct": {
        description:
          "Label on the recorder's voice button while a local voice model is " +
          "downloading, so a wait of tens of seconds does not read as a hang. " +
          "Only local engines (Kokoro, MMS) report progress. Keep it short — " +
          "the button is about half the panel wide.",
        placeholders: { percent: "Whole-number download progress, 0 to 100, without the % sign." },
        maxLength: 18,
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
      "audio.recordingModal.collapseFilmAriaLabel": {
        description:
          "Screen-reader name of the small button in the top-right corner of the " +
          "film panel that hides the film, leaving the narrow recorder column on " +
          "its own. Its visible caption is the shorter " +
          "audio.recordingModal.collapseFilmButton; this is the fuller phrase " +
          "assistive tech reads instead.",
      },
      "audio.recordingModal.expandFilmAriaLabel": {
        description:
          "Screen-reader name of the button in the recorder's header that brings " +
          "the film back beside the recorder after it was hidden. Only offered " +
          "when this line actually has a film. Its visible caption is the single " +
          "word 'Video'.",
      },
      "audio.recordingModal.lineCounter": {
        description:
          "Position readout under the line's name in the recording dialog's " +
          "header, when the line has no timed window: which line of the file is " +
          "being recorded, out of how many. Rendered in a narrow fixed-width " +
          "strip between the previous/next arrows, so it must stay very short.",
        placeholders: {
          index: "1-based position of the line being recorded.",
          total: "How many lines are in this recording run altogether.",
        },
      },
      "audio.recordingModal.lineCounterWindow": {
        description:
          "The same position readout as audio.recordingModal.lineCounter, with " +
          "the length of this line's timed window appended after a middle dot. " +
          "The 'window' is how many seconds the finished recording is meant to " +
          "fit into. The trailing 's' is the abbreviation for seconds.",
        placeholders: {
          index: "1-based position of the line being recorded.",
          total: "How many lines are in this recording run altogether.",
          seconds:
            "Length of the line's timed window in seconds, to two decimal places.",
        },
      },
      "audio.recordingModal.lineCounterVeryShort": {
        description:
          "The same readout as audio.recordingModal.lineCounterWindow, with a " +
          "third part warning that the window is so short there is barely room to " +
          "say anything. Shown in amber. Recording is still allowed — this is a " +
          "caution, never a refusal.",
        placeholders: {
          index: "1-based position of the line being recorded.",
          total: "How many lines are in this recording run altogether.",
          seconds:
            "Length of the line's timed window in seconds, to two decimal places.",
        },
      },
      "audio.recordingModal.maxDuration": {
        description:
          "Tiny readout in the corner of the live recording meter naming the " +
          "longest this take may run before it is stopped automatically. The " +
          "trailing 'm' is the abbreviation for minutes. Abbreviated hard: it " +
          "shares one narrow row with the running clock.",
        placeholders: {
          minutes: "Whole minutes at which recording stops by itself.",
        },
        maxLength: 12,
      },
      "audio.recordingModal.nearLimitNotice": {
        description:
          "Amber warning under the meter once a take has been running a long " +
          "time, telling the performer how long it has been and when it will be " +
          "cut off. Both numbers are whole minutes and the second one has no unit " +
          "word of its own — it borrows 'minutes' from the first clause.",
        placeholders: {
          warnMinutes: "How many minutes the take has been running.",
          hardStopMinutes:
            "How many minutes in total the recorder allows before stopping by itself.",
        },
      },
      "audio.recordingModal.formatWavAriaLabel": {
        description:
          "Screen-reader name of the recording-format toggle while it is set to " +
          "WAV, stating the current setting and what pressing it would do. WAV is " +
          "the uncompressed, larger, higher-quality file format; 'compressed' is " +
          "the smaller alternative. The visible caption is just the word 'WAV'.",
      },
      "audio.recordingModal.formatCompressedAriaLabel": {
        description:
          "Screen-reader name of the same toggle while it is set to the " +
          "compressed format, stating the current setting and what pressing it " +
          "would do. The visible caption is the single word 'COMPRESSED'.",
      },
      "audio.recordingModal.settingsAriaLabel": {
        description:
          "Screen-reader name of the gear button at the end of the recorder's " +
          "bottom strip. It opens a small menu holding two preferences: whether " +
          "to move on to the next line after each save, and whether the countdown " +
          "beeps.",
      },
      "audio.recordingModal.filmAriaLabel": {
        description:
          "Screen-reader name of the video element showing the film for the line " +
          "being recorded. The film is reference only — the performer watches it " +
          "to time their delivery — so this names what the picture is, not " +
          "something to operate.",
      },
      "audio.recordingModal.filmMuteAriaLabel": {
        description:
          "Screen-reader name of the button under the film while its sound is " +
          "playing: pressing it silences the film. Imperative.",
      },
      "audio.recordingModal.filmUnmuteAriaLabel": {
        description:
          "Screen-reader name of the same button while the film is silent: " +
          "pressing it lets the film's sound out. The parenthetical is a warning, " +
          "not a condition of the button — on speakers the film would be recorded " +
          "into the take, so this is only safe on headphones.",
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
      "audio.takesStrip.syncFailedTooltip": {
        description:
          "Hover title on the red badge of a take whose save to the server FAILED " +
          "and will not be retried automatically. Distinct from the 'saving' badge: " +
          "that one is still on its way, this one is stuck and needs the user to " +
          "retry. Reassures that the recording itself is not lost.",
      },
      "audio.takesStrip.syncFailedRetry": {
        description:
          "Label on the small red button shown on a take that failed to save to the " +
          "server; pressing it queues the save again. Very short — it sits inline on " +
          "a compact take row.",
      },
      "audio.takesStrip.textDriftBadge": {
        description:
          "Very short label on an amber badge marking a take that was recorded " +
          "against an OLDER version of this line's text — the wording has been " +
          "edited since the recording was made, so the audio and the text no longer " +
          "agree. Not an error: the take is fine, it just speaks the old wording. " +
          "Sits inline on a compact take row beside the take's name.",
        maxLength: 16,
      },
      "audio.takesStrip.textDriftTooltip": {
        description:
          "Hover title on that badge. Gives the date the take was recorded and " +
          "quotes the line's wording AS IT READ THEN, then says the text has since " +
          "changed and names the two reasonable responses. Deliberately not a " +
          "warning — reviewing audio against its own older wording is a normal " +
          "workflow, so the tone is informative.",
        placeholders: {
          date: "Date the recording was made, already formatted for the user's locale.",
          text: "The line's text as it read at the moment of recording, quoted verbatim.",
        },
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
      "audio.clone.dropzoneTitle": {
        description:
          "Heading inside the empty dashed dropzone on the Clone tab's Reference " +
          "audio panel, inviting the user to attach a clip.",
      },
      "audio.clone.dropzoneHint": {
        description:
          "Subtitle under audio.clone.dropzoneTitle. Tells the user a 5–15 second " +
          "clip of one speaker is enough, and that we generate a base voice then " +
          "clone it to match. Record, upload, and drag-and-drop are the zone itself.",
      },
      "audio.clone.dropzoneDrop": {
        description:
          "Temporary subtitle shown while an audio file is dragged over the " +
          "reference dropzone, replacing audio.clone.dropzoneHint.",
      },
      "audio.clone.errorNotAudio": {
        description:
          "Inline error when a dropped or picked file is not audio (e.g. an image " +
          "or document), telling the user to use a short recording instead.",
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
      "audio.voice.bright": {
        description:
          "One of a fixed set of one-word tone/character descriptions for a named " +
          "Gemini TTS voice (e.g. 'Zephyr — Bright'), reused verbatim across several " +
          "voices that share the same description in Google's own voice catalog. Not " +
          "yet rendered anywhere in the app (data reserved for a future voice-picker " +
          "list) — keep it a short, standalone adjective, not a sentence.",
      },
      "audio.voice.upbeat": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.informative": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.firm": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.excitable": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.youthful": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.breezy": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.easyGoing": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.breathy": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.clear": {
        description:
          "See audio.voice.bright — same class of key. Describes a VOICE's tone " +
          "(distinct, easy to make out), an adjective — not the 'Clear' button " +
          "(common.clear) that resets a filter or field, which is an imperative verb.",
      },
      "audio.voice.smooth": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.gravelly": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.soft": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.even": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.mature": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.forward": {
        description:
          "See audio.voice.bright — same class of key. Describes a VOICE's personality " +
          "(direct, assertive), an adjective — not the browser-style 'Forward' history " +
          "button (nav.historyControls.forward), which is a navigation command.",
      },
      "audio.voice.friendly": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.casual": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.gentle": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.lively": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.knowledgeable": { description: "See audio.voice.bright — same class of key." },
      "audio.voice.warm": { description: "See audio.voice.bright — same class of key." },
      "audio.provider.omnivoiceHint": {
        description:
          "Tooltip on the OmniVoice engine card in the TTS engine picker (New " +
          "Voice dialog), explaining what running 'on our servers' means: no API key " +
          "or download, usage-metered, and it supports cloning from a reference clip.",
      },
      "audio.provider.geminiHint": {
        description:
          "Tooltip on the Gemini engine card in the TTS engine picker. 'BYOK' = " +
          "bring your own key — the user must supply their own Google AI key for this " +
          "engine to work.",
      },
      "audio.provider.kokoroHint": {
        description:
          "Tooltip on the Kokoro engine card in the TTS engine picker, explaining the " +
          "one-time local model download that happens before this on-device engine " +
          "can generate audio.",
      },
      "audio.provider.mmsHintSherpa": {
        description:
          "Tooltip on the MMS engine card in the TTS engine picker, shown in the " +
          "build variant that loads on-device voices from the Sherpa-ONNX MMS " +
          "mirror. 'Sherpa-ONNX' is a proper name for the runtime — do not translate " +
          "it.",
      },
      "audio.provider.mmsHintHosted": {
        description:
          "Tooltip on the MMS engine card, shown in the build variant that loads " +
          "on-device voices from Aquilla's own hosted MMS model bucket rather than " +
          "the Sherpa-ONNX mirror.",
      },
      "audio.provider.mmsHintFallback": {
        description:
          "Tooltip on the MMS engine card, shown when neither the Sherpa-ONNX mirror " +
          "nor a hosted model bucket is configured — a generic fallback description.",
      },
      "audio.castGutter.namedTooltip": {
        description:
          "Hover/accessible text on a line's small voice-avatar circle (the 'cast " +
          "gutter'), shown when the line has an explicitly cast character whose name " +
          "differs from the voice's own name — e.g. 'Peter — voiced by Kore'.",
        placeholders: {
          castName: "The diarized/VTT speaker (character) name. User content — do not translate.",
          voiceName: "The TTS voice's own name (e.g. 'Kore'). Proper name — do not translate.",
        },
      },
      "audio.castGutter.defaultTooltip": {
        description:
          "Hover/accessible text on the cast-gutter avatar, shown when the line falls " +
          "back to the default/narrator voice instead of an explicit cast choice — " +
          "e.g. 'Kore — default (no one cast yet)'.",
        placeholders: {
          voiceName: "The fallback voice's own name (e.g. 'Kore'). Proper name — do not translate.",
        },
      },
      "audio.castGutter.chooseCharacterAriaLabel": {
        description:
          "Accessible name of the cast-gutter avatar's popover-trigger button, which " +
          "opens the voice picker. Appends an action to whichever hover text " +
          "(audio.castGutter.namedTooltip or .defaultTooltip) already describes the " +
          "current cast state, so a screen-reader user hears both the state and what " +
          "clicking does.",
        placeholders: {
          tooltip:
            "The already-resolved hover text for this avatar (see " +
            "audio.castGutter.namedTooltip / .defaultTooltip), inserted verbatim.",
        },
      },
      "audio.error.noAttachment": {
        description:
          "Internal error message on a thrown AudioError when a cell's audio bytes " +
          "are requested but the cell has no audio attachment pointer at all.",
      },
      "audio.error.legacyLfsUnsupported": {
        description:
          "Internal error message on a thrown AudioError when a cell's audio URL is " +
          "an old GitLab-LFS-style pointer that codex-web can no longer fetch, " +
          "surfaced so the UI can offer a 're-record' affordance.",
        placeholders: {
          url: "The unsupported attachment URL. Technical value — do not translate.",
        },
      },
      "audio.error.notSignedIn": {
        description:
          "Internal error message on a thrown AudioError when a network fetch of a " +
          "cell's audio needs an authenticated session but none is present.",
      },
      "audio.error.recordingDeleted": {
        description:
          "Internal error message on a thrown AudioError when the server reports a " +
          "404 for a cell's audio — the recording was permanently deleted, so the UI " +
          "should not offer a retry, only re-record.",
      },
      "audio.error.streamingFailed": {
        description:
          "Internal error message on a thrown AudioError when both the streamed " +
          "playback URL and the full-bytes fallback fail to play.",
      },
      "audio.error.queueLoadFailed": {
        description:
          "Error status message for the multi-cell playback queue (play-queue.ts) " +
          "when an audio element fails to load and no blob-fallback retry applies. " +
          "Rendered directly in VoicePlaybackBar in place of the current voice's name.",
      },
      "audio.error.noDownloadableAudio": {
        description:
          "Error status for a single-cell transcription attempt (shown via " +
          "CellTranscribeBadge) when the cell's audio pointer exists but has no " +
          "downloadable URL yet — e.g. it is still syncing from another device.",
      },
      "audio.error.notTranscribableLocation": {
        description:
          "Error status for a single-cell transcription attempt when the cell's " +
          "audio URL isn't a location transcription can read from (e.g. an " +
          "unsupported legacy pointer).",
      },
      "audio.error.signInToTranscribe": {
        description:
          "Error status for a single-cell transcription attempt when it needs a " +
          "network fetch (no local cache hit) but the user has no signed-in session.",
      },
      "audio.consent.whisperLabel": {
        description:
          "Display name for the Whisper transcription model in the first-run AI-" +
          "model download consent dialog (AiModelConsentDialog) — names the feature " +
          "in parentheses since 'Whisper' alone doesn't say what it's for.",
      },
      "audio.consent.kokoroLabel": {
        description:
          "Display name for the Kokoro text-to-speech model in the same consent " +
          "dialog as audio.consent.whisperLabel, same naming pattern.",
      },
      "audio.consent.mmsLabel": {
        description:
          "Display name for the MMS multilingual text-to-speech model in the same " +
          "consent dialog as audio.consent.whisperLabel, same naming pattern.",
      },
      "audio.aiError.dailyLimitTitle": {
        description:
          "Popover heading from categorizeAiError() when the platform's shared daily " +
          "AI budget has been exhausted (429 from the Aquilla proxy, not a specific " +
          "provider). Short, plain-language — the explanatory sentence is a separate, " +
          "not-yet-keyed body string shown underneath.",
      },
      "audio.aiError.modelNotAvailableTitle": {
        description:
          "Popover heading when the requested model isn't on this platform's " +
          "allowlist for the signed-in tier.",
      },
      "audio.aiError.tooLargeTitle": {
        description:
          "Popover heading when a completion/TTS request exceeded the selected " +
          "model's context window (a 413 or an explicit 'too large' provider error).",
      },
      "audio.aiError.geminiKeyRequiredTitle": {
        description:
          "Popover heading when a Gemini-voice TTS request fails because no Gemini " +
          "API key is configured for the project.",
      },
      "audio.aiError.geminiFailedTitle": {
        description:
          "Popover heading when Gemini TTS ran (a key was present) but the request " +
          "failed or returned no audio. Distinct from geminiKeyRequiredTitle — the " +
          "engine is named so it is not confused with an OmniVoice failure.",
      },
      "audio.aiError.omnivoiceNotConfiguredTitle": {
        description:
          "Popover heading when hosted OmniVoice TTS is not wired on this server " +
          "(typical for local pnpm dev: missing OMNIVOICE_URL / OMNIVOICE_TOKEN). " +
          "Must not be read as a Gemini-key problem.",
      },
      "audio.aiError.omnivoiceFailedTitle": {
        description:
          "Popover heading when OmniVoice TTS was configured but the synthesize " +
          "call itself failed (Modal/upstream error).",
      },
      "audio.aiError.seedVcNotConfiguredTitle": {
        description:
          "Popover heading when a non-OmniVoice clone voice needs Seed-VC conversion " +
          "and the sync-worker has no SEED_VC_URL / SEED_VC_TOKEN. Distinct from " +
          "omnivoiceNotConfiguredTitle — OmniVoice clones skip this step.",
      },
      "audio.aiError.seedVcFailedTitle": {
        description:
          "Popover heading when Seed-VC voice conversion ran but failed after TTS.",
      },
      "audio.aiError.signInRequiredTitle": {
        description:
          "Popover heading when an AI feature (TTS, transcription, drafting) needs " +
          "an authenticated session and none is present.",
      },
      "audio.aiError.gitProjectUnsupportedTitle": {
        description:
          "Popover heading when the attempted AI feature isn't yet supported for " +
          "git-linked projects.",
      },
      "audio.aiError.nothingToReadTitle": {
        description:
          "Popover heading when a 'read aloud'/TTS request has no source or " +
          "translated text to synthesize from.",
      },
      "audio.aiError.translationNotConfiguredTitle": {
        description:
          "Popover heading when generating voice for an untranslated cell needs " +
          "on-the-fly translation, but the project has no completion provider set up.",
      },
      "audio.aiError.ttsNotConfiguredTitle": {
        description:
          "Popover heading when the voice service itself was never configured, " +
          "so generating audio cannot work at all until someone sets it up. " +
          "Distinct from a server being temporarily down: retrying will never " +
          "help, which is why it is worded as a state ('isn't set up') rather " +
          "than as a failure that just happened.",
      },
      "audio.aiError.translationFailedTitle": {
        description:
          "Popover heading when an on-the-fly translation attempt (see " +
          "audio.aiError.translationNotConfiguredTitle) ran but produced no usable " +
          "text.",
      },
      "audio.aiError.networkTitle": {
        description:
          "Popover heading for a connectivity failure (fetch failed / offline) " +
          "while calling an AI feature.",
      },
      "audio.aiError.modelLoadFailedTitle": {
        description:
          "Popover heading when an on-device model (Whisper/Kokoro/MMS/transformers " +
          "runtime) fails to download or initialize.",
      },
      "audio.aiError.audioFormatUnsupportedTitle": {
        description:
          "Popover heading when an uploaded/recorded audio file can't be decoded — " +
          "the explanatory body suggests re-uploading as .wav/.mp3/.ogg.",
      },
      "audio.aiError.timedOutTitle": {
        description: "Popover heading when an AI provider request exceeded its time budget.",
      },
      "audio.aiError.rateLimitedTitle": {
        description:
          "Popover heading when a specific AI provider (not the platform's own " +
          "daily budget, see audio.aiError.dailyLimitTitle) is rate-limiting requests.",
      },
      "audio.aiError.providerUnavailableTitle": {
        description:
          "Popover heading for a 5xx response from the AI provider — framed as " +
          "usually temporary.",
      },
      "audio.aiError.providerRejectedTitle": {
        description:
          "Popover heading for a 4xx response from the AI provider that doesn't " +
          "match any more specific category above.",
      },
      "audio.aiError.unknownTitle": {
        description:
          "Popover heading (InlineAiError etc.) when a failure doesn't match any " +
          "specific category — the fallback of categorizeAiError()'s heuristic " +
          "classifier. Distinct from the app-wide error.generic.title heading (a " +
          "full failure-screen title): this is an inline popover heading inside an " +
          "AI-feature affordance, the same register split already documented for " +
          "audio.recordingModal.genericError just above.",
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
