# Supported audio import formats

What Aquilla accepts when you bring recorded audio in, and where that list is
enforced. Written for AQU-1922 ("Amanda asked which audio formats Aquilla
supports"), and kept honest by tests rather than by memory.

## The list

| Format | Extensions | Notes |
| --- | --- | --- |
| WAV | `.wav` | PCM; what the in-app recorder saves |
| MP3 | `.mp3` | |
| MPEG-4 / AAC | `.m4a`, `.mp4`, `.aac` | `.m4a` and `.mp4` are the same container |
| Ogg | `.ogg`, `.oga`, `.opus` | Opus in Ogg included |
| WebM | `.webm` | what browser `MediaRecorder` produces |
| FLAC | `.flac` | |

Anything else is refused at the picker. These are refused **by name**, with
their own message, because they declare a real `audio/*` MIME type and would
otherwise upload fine and then sit on the line as a take that never plays:

`.wma`, `.aif`, `.aiff`, `.amr`, `.3gp`, `.caf`

Per-file size caps: **100 MB** for the one-file cell upload
(`MAX_ATTACH_BYTES`), and the bulk recordings upload's own
`BULK_MAX_FILE_BYTES`. The R2 upload layer has a slightly lower hard object cap
and reports it in its own words.

## Where the list lives

**One place: `src/lib/audio/mime.ts`.** `AUDIO_FILE_EXTS` /
`AUDIO_FILE_EXT_SET` is the accepted set, `UNPLAYABLE_AUDIO_EXTS` the refused
set, `AUDIO_FILE_ACCEPT` the `accept` string every audio picker uses, and
`AUDIO_FORMATS_LABEL` the sentence shown to a person.

Never re-type the list at a call site. Before AQU-1922 three call sites kept
their own copy and they had drifted: the one-file cell picker's `accept` named
4 of the 10 supported extensions, so a FLAC/Opus/AAC/WebM file picked off a
phone's Files app — where the OS reports an empty or wrong MIME type, which is
the whole reason the extension list exists — could not be selected at all,
though the validator and playback both handled it.

Consumers:

- `src/lib/audio/attach-file.ts` — `ACCEPT` and `validateAudioFile()`, the
  one-file cell upload (action rail + recording modal's "upload a file").
- `src/lib/audio/bulk-upload/match.ts` — `precheckFile()`, the bulk recordings
  upload; refusals surface per row as `notAudio` / `unplayableFormat`.
- `src/components/import/RecordingsUpload.tsx` — the bulk picker's `accept`.

The accepted set is also exactly the set `audioMimeForExt()` maps explicitly.
That is not a coincidence and must not become one: playback stamps the Blob
with that MIME type, and Safari and Firefox refuse a wrongly-labelled Blob
outright, so an extension the mapper has to guess for is one playback cannot
label honestly. `src/lib/audio/mime.test.ts` fails if the two sets part ways.

The timeline's media pickers (`TimelineAddMedia.tsx`,
`TimelineLinkedVideoEmpty.tsx`) accept video containers as well and still carry
their own literal; folding them in is follow-up work.

## Honest limits

- **Extension and declared type only — no byte sniffing.** A renamed `.txt`
  still passes the picker; it fails later, when nothing decodes it.
- **Decoding is the browser's.** Everything above is accepted on the strength
  of baseline Chromium/Firefox/Safari support, not a per-format decode walk in
  CI. A format the user's particular browser lacks a codec for will be accepted
  and then fail to play.
- **Not yet walked end to end per format.** AQU-1922's first bullet — import →
  silence split → transcription for each of the six formats, on real files —
  remains open; it needs the dev stack, fixture audio in every format, and a
  transcription provider key. Only the accepted-list half is covered by tests.
