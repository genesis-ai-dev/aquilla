# Script alignment

Open **Sources → Align script** in the media timeline. Paste wording or choose
a UTF-8 text file. Paragraph breaks define editable segments.

Aquilla first reuses existing source word timings. Otherwise it uses the shared
transcription entry point, which follows your configured provider: hosted
OpenRouter Whisper by default, or local Whisper when explicitly enabled in
settings. No separate alignment provider receives your script or audio.

Word-match confidence measures supplied words found in the transcript. It is
not an acoustic confidence score. Missing or ambiguous matches require review.
You can edit wording and times, listen to ranges, and confirm uncertain matches.
Invalid times prevent publication. Large matches require shorter sections.

Saving creates a new text track by default. Backfilling a selected track requires
consent to overwrite its displayed segment count. Original media and uploaded
script bytes remain available.

True CTC forced alignment is deferred. Modal remains a future option, subject to
privacy disclosure and verified near-zero retention. No Modal alignment routes,
job schema, client, or deployment code are part of the current workflow.
