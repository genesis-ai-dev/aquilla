import { defineNamespace, plural, type ContextEntry, type MessageValue } from "./types"

/** What each placeholder holds, for the translator. */
const PLACEHOLDERS: Record<string, string> = {
  count: "A number, already formatted for the locale.",
  fileName: "The name of a file in the project, such as a Bible book (Genesis) or a document.",
  name: "A file name: either an audio file's name or a project file's name.",
  language: "The name of the language the recordings are for.",
  lane: "The name of a target language of the project.",
  mb: "A file size in megabytes, a whole number.",
  limit: "The largest file size allowed, in megabytes.",
  book: "The name of a Bible book, such as Genesis, or of a project file.",
  chapter: "A chapter number.",
  ref: "A verse reference such as 'Genesis 1:40'.",
  verse: "A verse number.",
  line: "A line number, counted from the top of the file.",
  other: "The name of another audio file in the same upload.",
  target: "A verse reference or line, such as 'Genesis 1:1' or 'line 12'.",
  folder: "The name of a folder on the person's computer, or the phrase for the chosen files.",
  first: "Where the order starts, such as 'Genesis 1:1' or 'line 1'.",
  n: "A part or take number.",
  total: "A total number of files or parts.",
  done: "How many recordings uploaded.",
  failed: "How many recordings failed.",
  notStarted: "How many recordings were never uploaded because the person stopped the upload.",
  message: "A technical error message, in English.",
  recordings: "A phrase with a count, such as '12 recordings'.",
  lines: "A phrase with a count, such as '12 lines'.",
}

/** Where a key sits, by its prefix, for keys without a hand-written note. */
const SURFACE_NOTES: ReadonlyArray<readonly [string, string]> = [
  ["recordingsUpload.intent.", "The Recordings card in the Import dialog's 'What are you importing?' choice, or why it is unavailable."],
  ["recordingsUpload.title", "Title of the Import dialog while recordings are being chosen and checked."],
  ["recordingsUpload.pick.", "The screen where the person chooses recordings or a folder of them."],
  ["recordingsUpload.rules.", "One rule in the explanation behind the (i) of how each recording finds its line."],
  ["recordingsUpload.loading.", "Shown while the recordings' names are read and the project's lines are loaded."],
  ["recordingsUpload.preview.", "The preview that lists every recording and the line it will go onto, before anything uploads."],
  ["recordingsUpload.reason.", "Why one file will not be uploaded, shown beside its name in the preview. A full sentence."],
  ["recordingsUpload.banner.", "The progress banner shown while recordings upload, and its summary afterwards."],
  ["recordingsUpload.failures.", "The list of recordings that couldn't upload: its title, or why one failed. A full sentence."],
  ["recordingsUpload.join.", "The 'Join into one recording' action on a recording made of pieces."],
]

/** Placeholders a message uses, across its plural forms. */
function placeholderNames(value: MessageValue): string[] {
  const forms = typeof value === "string" ? [value] : Object.values(value.forms).filter((v): v is string => typeof v === "string")
  return [...new Set(forms.flatMap((form) => [...form.matchAll(/\{(\w+)\}/g)].map((m) => m[1])))]
}

/** A context entry for every key that has placeholders, so each is documented. */
function placeholderContexts<K extends string>(keys: Record<K, MessageValue>, own: Partial<Record<K, ContextEntry>>): Partial<Record<K, ContextEntry>> {
  const out: Partial<Record<K, ContextEntry>> = { ...own }
  for (const key of Object.keys(keys) as K[]) {
    const names = placeholderNames(keys[key])
    if (names.length === 0) continue
    const note = SURFACE_NOTES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? "Text in the recordings upload."
    out[key] = {
      description: own[key]?.description ?? note,
      ...own[key],
      placeholders: Object.fromEntries(names.map((n) => [n, PLACEHOLDERS[n] ?? n])),
    }
  }
  return out
}

const KEYS = {
    // Entry points
    "recordingsUpload.intent.title": "Recordings",
    "recordingsUpload.intent.description": "Audio for lines already here. Each file finds its line by its name.",
    "recordingsUpload.intent.noFiles": "Add a source text first. Recordings go onto lines that are already here.",
    "recordingsUpload.intent.laneArchived": "{lane} has been archived and is read-only. Switch to another language to upload recordings.",
    "recordingsUpload.menuItem": "Upload recordings…",
    "recordingsUpload.title": "Upload recordings",
    "recordingsUpload.titleInto": "Upload recordings into {fileName}",
    // Choosing files
    "recordingsUpload.pick.intro": "Choose the recordings, or a folder of them. Each file finds its book and verse by its name, across as many books as you like.",
    "recordingsUpload.pick.introFile": "Choose the recordings for {fileName}, or a folder of them. Each file finds its line by its name.",
    "recordingsUpload.pick.safe": "Nothing uploads until you've checked where each recording goes.",
    "recordingsUpload.pick.dragDrop": "Drag recordings or a folder here, or",
    "recordingsUpload.pick.language": "They go into {language}, the language you're working in.",
    "recordingsUpload.pick.languageDefault": "They go into the language you're working in.",
    "recordingsUpload.pick.formats": "WAV, MP3, M4A, OGG, FLAC and other audio files.",
    // The matching rule, behind the (i)
    "recordingsUpload.rules.label": "How each recording finds its line",
    "recordingsUpload.rules.byName":
      "By name: a name with a book, chapter and verse goes to that verse, such as “Genesis 1-1”, “Gen 1.1”, “1Sam_3_4”, “GEN_001_001” or the project's own name for the book. When the name has no book, the folder's name is used.",
    "recordingsUpload.rules.byNumber":
      "By number: inside one file, numbers are enough. In a Bible book, “1-1” or “001_001” is chapter 1, verse 1. In any other file, “012”, “line 12” or “part_003” is that line, counted from the top.",
    "recordingsUpload.rules.range":
      "“Genesis 1:1-3” or “1-1-3” is one recording for verses 1 to 3, and each of them counts as recorded. A name with a chapter and no verse is one recording for the whole chapter.",
    "recordingsUpload.rules.parts":
      "A verse in several files, such as “1-1a” and “1-1b”, “part 1” and “part 2”, “_1” and “_2”, or “beginning” and “end”, becomes the pieces of one recording, in that order. You can join them into one recording afterwards.",
    "recordingsUpload.rules.order":
      "By order: when no file in a folder has a verse or line number in its name (phone recordings such as “IMG_4521”, or no numbers at all), the files go onto the lines in folder order, sorted so that 2 comes before 10. A folder named for a chapter starts at that chapter.",
    "recordingsUpload.rules.existing":
      "A line that already has a recording keeps it in its take list, and the new recording becomes the one that plays.",
    "recordingsUpload.rules.unmatched": "A file that can't be placed is listed with the reason, and it is not uploaded.",
    // Loading
    "recordingsUpload.loading.reading": plural({
      one: "Reading the name of {count} file…",
      other: "Reading the names of {count} files…",
    }),
    "recordingsUpload.loading.lines": "Loading the lines of {name}…",
    "recordingsUpload.loading.failed": "Couldn't load the lines of {name}. Check your connection and try again.",
    // Preview
    "recordingsUpload.preview.summary": "{recordings} will go onto {lines}.",
    "recordingsUpload.preview.recordings": plural({ one: "{count} recording", other: "{count} recordings" }),
    "recordingsUpload.preview.lines": plural({ one: "{count} line", other: "{count} lines" }),
    "recordingsUpload.preview.instructions": "Check where each recording goes, and change a line if one is wrong. Nothing uploads until you confirm.",
    "recordingsUpload.preview.recordedCount": plural({
      one: "{count} of those lines already has a recording. The new one will play, and the old one stays in the take list.",
      other: "{count} of those lines already have a recording. The new ones will play, and the old ones stay in the take list.",
    }),
    "recordingsUpload.preview.notUploaded": plural({
      one: "{count} file won't be uploaded",
      other: "{count} files won't be uploaded",
    }),
    "recordingsUpload.preview.nothing": "None of these files can be placed on a line.",
    "recordingsUpload.preview.byName": "by name",
    "recordingsUpload.preview.byNumber": "by number",
    "recordingsUpload.preview.byOrder": "by order",
    "recordingsUpload.preview.chosen": "chosen by you",
    "recordingsUpload.preview.fromFolder": "from the folder “{folder}”",
    "recordingsUpload.preview.range": plural({ one: "one recording for {count} line", other: "one recording for {count} lines" }),
    "recordingsUpload.preview.part": "part {n} of {total}",
    "recordingsUpload.preview.lonePart": "named as a part, but it's the only one",
    "recordingsUpload.preview.take": "take {n}",
    "recordingsUpload.preview.hasRecording": "already recorded",
    "recordingsUpload.preview.change": "Change",
    "recordingsUpload.preview.changeLabel": "Change the line for {name}",
    "recordingsUpload.preview.chooseLine": "Choose a line",
    "recordingsUpload.preview.chooseLineLabel": "Choose a line for {name}",
    "recordingsUpload.preview.searchLines": "Search lines",
    "recordingsUpload.preview.noLines": "No line matches",
    "recordingsUpload.preview.dontUpload": "Don't upload",
    "recordingsUpload.preview.orderNote": plural({
      one: "{count} file in {folder} has no verse or line number in its name, so it goes onto the lines in folder order, starting at {first}.",
      other: "{count} files in {folder} have no verse or line numbers in their names, so they go onto the lines in folder order, starting at {first}.",
    }),
    "recordingsUpload.preview.orderEarlier": "Start one line earlier",
    "recordingsUpload.preview.orderLater": "Start one line later",
    "recordingsUpload.preview.orderStartAt": "Start at…",
    "recordingsUpload.preview.topFolder": "the chosen files",
    "recordingsUpload.preview.confirm": plural({ one: "Upload {count} recording", other: "Upload {count} recordings" }),
    // Why a file is not uploaded
    "recordingsUpload.reason.notAudio": "This isn't an audio file.",
    "recordingsUpload.reason.systemFile": "This is a hidden system file, not a recording.",
    "recordingsUpload.reason.empty": "This file is empty.",
    "recordingsUpload.reason.tooLarge": "This file is {mb} MB. The limit is {limit} MB.",
    "recordingsUpload.reason.noBook": "Neither its name nor its folder names a book or a file in this project.",
    "recordingsUpload.reason.bookNotInProject": "It names {book}, which isn't in this project.",
    "recordingsUpload.reason.otherBook": "It names {book}, but this file is {fileName}.",
    "recordingsUpload.reason.noSuchChapter": "{book} has no chapter {chapter} in this project.",
    "recordingsUpload.reason.noSuchVerse": "{ref} isn't a line in this file.",
    "recordingsUpload.reason.noVerseChapter": "It names verse {verse} but no chapter.",
    "recordingsUpload.reason.noSuchLine": "This file has {count} lines, so there is no line {line}.",
    "recordingsUpload.reason.noNumber": "Its name has no verse or line number, and the other files' names do.",
    "recordingsUpload.reason.tooManyNumbers": "Its name has too many numbers to tell which line it is.",
    "recordingsUpload.reason.pastLastLine": "There are more files than lines. This file has {count} lines.",
    "recordingsUpload.reason.beforeFirstLine": "Starting the order earlier left this file before the first line.",
    "recordingsUpload.reason.duplicate": "{other} already goes to {target}.",
    "recordingsUpload.reason.skipped": "You chose not to upload it.",
    // Progress banner
    "recordingsUpload.banner.uploading": "Uploading recordings",
    "recordingsUpload.banner.waiting": "Waiting for a connection. The upload carries on when you're back online.",
    "recordingsUpload.banner.stop": "Stop uploading",
    "recordingsUpload.banner.done": plural({ one: "{count} recording uploaded.", other: "{count} recordings uploaded." }),
    "recordingsUpload.banner.failedSummary": plural({
      one: "{failed} of {total} recordings couldn't upload.",
      other: "{failed} of {total} recordings couldn't upload.",
    }, "failed"),
    "recordingsUpload.banner.stoppedSummary": "Stopped. {done} of {total} recordings uploaded, and {notStarted} were not.",
    "recordingsUpload.banner.showFailures": "Show which",
    "recordingsUpload.banner.tryAgain": "Try them again",
    "recordingsUpload.failures.title": "Recordings that couldn't upload",
    "recordingsUpload.failures.description": "Each was meant for the line shown. Nothing else in the upload was affected.",
    "recordingsUpload.failures.offline": "You went offline before it uploaded.",
    "recordingsUpload.failures.network": "The connection dropped while it uploaded, even after trying again.",
    "recordingsUpload.failures.server": "The server didn't accept it, even after trying again.",
    "recordingsUpload.failures.refused": "The server refused it, so it wasn't tried again. It said: {message}",
    "recordingsUpload.failures.tooShort": "One of its parts is too short to be a piece of its own.",
    "recordingsUpload.failures.decode": "One of its parts couldn't be read as audio, so the parts couldn't be joined.",
    "recordingsUpload.failures.other": "It couldn't be uploaded: {message}",
    // Joining pieces
    "recordingsUpload.join.button": "Join into one recording",
    "recordingsUpload.join.tooltip": "Make one recording of these pieces, in order. The pieces stay in the take list.",
    "recordingsUpload.join.joining": "Joining…",
    "recordingsUpload.join.failed": "Couldn't join these pieces: {message}",
} satisfies Record<string, MessageValue>

type Key = keyof typeof KEYS

const OWN_NOTES: Partial<Record<Key, ContextEntry>> = {
  "recordingsUpload.intent.title": { description: "Title of the third card in the Import dialog's 'What are you importing?' choice: audio recordings for lines already in the project. Short noun.", maxLength: 24 },
  "recordingsUpload.menuItem": { description: "Item in a file's ⋯ menu in the sidebar that opens the upload of many recordings into that file.", maxLength: 32 },
  "recordingsUpload.preview.byName": { description: "Small grey text in a preview row: this recording's line was found from the book and verse in its name.", maxLength: 20 },
  "recordingsUpload.preview.byNumber": { description: "Small grey text in a preview row: the line was found from numbers alone in the name.", maxLength: 20 },
  "recordingsUpload.preview.byOrder": { description: "Small grey text in a preview row: the line was given by the file's place in the folder order.", maxLength: 20 },
  "recordingsUpload.preview.topFolder": { description: "Stands in for a folder name in 'files in {folder}' when the person chose files rather than a folder." },
  "recordingsUpload.banner.stop": { description: "Tooltip and accessible name of the X button on the upload progress banner; stops the upload." },
  "recordingsUpload.join.button": { description: "Button on a recording that was uploaded or cut into pieces: makes one new recording of all the pieces, in order.", maxLength: 32 },
}

/**
 * `recordingsUpload` namespace (AQU-981): uploading many recordings at once —
 * from Import → Recordings for the whole project, or a file's ⋯ menu for one
 * file — the preview of where each recording will land, the progress banner,
 * and "Join into one recording" on a recording uploaded in parts.
 */
export const recordingsUpload = defineNamespace({
  keys: KEYS,
  context: {
    _context: {
      description:
        "Uploading many audio recordings at once (an oral Bible team uploading a whole book of verse " +
        "recordings, or any team uploading recordings for a document or subtitles). Each audio FILE is " +
        "matched to a LINE (a verse, a sentence, a subtitle) of a file already in the project, from the " +
        "file's name. A preview lists every recording and the line it will go onto before anything uploads; " +
        "a banner then shows progress. A 'take' is one recording of a line; a line can hold several takes, " +
        "and one of them plays. 'Pieces' are parts of one recording. Write plain, full sentences.",
    },
    keys: placeholderContexts(KEYS, OWN_NOTES),
  },
  surfaces: [],
})
