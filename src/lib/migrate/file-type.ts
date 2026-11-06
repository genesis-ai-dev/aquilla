// Which Aquilla file type a legacy Codex notebook is (AQU-2211).
//
// Every file the migrator brought over used to land as `codex` (or `idml`),
// whatever it had been in Codex: a USFM book, a subtitle file, a spreadsheet
// and a Word document all became the same generic file, and every type-keyed
// feature in the app — export formats, subtitle and dubbing handling,
// Scripture detection, starting layouts — had to be taught about `codex` one
// predicate at a time (AQU-997, AQU-2210). Codex records the origin on the
// notebook itself: `metadata.importerType` names the importer that produced
// it, and the uploaded file's name survives in `originalName` (and, on newer
// notebooks, `originalFileName`). Across ~100 local Codex projects
// `originalFileName` is almost never set while `originalName` carries the
// extension ("TheChosen_101_en_5&2.vtt", "README.md", "test-example.tmx"),
// so both names are read.
//
// The rule, in order:
//   1. `importerType`, through IMPORTER_FILE_TYPES. An importer with no
//      Aquilla counterpart (`pdf`, `smart-segmenter`, `macula`, `biblica`, or
//      one this table has never heard of) resolves to nothing ON PURPOSE: the
//      importer is the stronger signal and says the file is not one of
//      Aquilla's formats, so the file name is not consulted and the caller
//      keeps `codex`. `indesign` resolves to nothing here too — IDML is
//      detected structurally (`isIdmlPair`) and takes its own path in map.ts.
//   2. Only when the notebook names no importer at all (older notebooks): the
//      extension of `originalFileName`, then of `originalName`.
//   3. Otherwise nothing, and the caller keeps `codex`.
//
// Shared with scripts/neon-backfill-file-kinds.ts so the migrator's rule and
// the backfill's rule cannot drift apart — the same arrangement as
// `legacyBookCodeFor`.
import type { CodexNotebookFile } from "../codex-editor/types"
import type { FileType } from "../parsers/types"

/** The Aquilla types a Codex notebook can resolve to. Never `idml` (see above). */
export type LegacyFileType = Extract<
  FileType,
  "usfm" | "ebible" | "obs" | "vtt" | "srt" | "sbv" | "audio" | "md" | "txt" | "csv" | "tsv" | "xlsx" | "tmx" | "docx"
>

/**
 * What a Codex notebook records about its own origin, carried verbatim into
 * `files.meta.legacyCodex` so nothing is lost even where no mapping has been
 * decided. Strings are trimmed; absent and blank fields are omitted.
 */
export interface LegacyCodexFileMeta {
  importerType?: string
  originalFileName?: string
  originalName?: string
  audioOnly?: true
  videoUrl?: string
}

type SubtitleFileType = Extract<LegacyFileType, "vtt" | "srt" | "sbv">

/** Codex `importerType` → Aquilla type. `subtitle` is resolved by file name. */
const IMPORTER_FILE_TYPES: ReadonlyMap<string, LegacyFileType | "subtitle"> = new Map<
  string,
  LegacyFileType | "subtitle"
>([
  ["usfm", "usfm"],
  ["usfm-experimental", "usfm"],
  ["paratext", "usfm"],
  ["ebible", "ebible"],
  ["ebibleCorpus", "ebible"],
  ["obs", "obs"],
  ["subtitles", "subtitle"],
  ["audio", "audio"],
  ["markdown", "md"],
  ["plaintext", "txt"],
  ["spreadsheet", "xlsx"],
  ["spreadsheet-csv", "csv"],
  ["spreadsheet-tsv", "tsv"],
  ["tms", "tmx"],
  ["docx", "docx"],
])

const SUBTITLE_TYPES_BY_EXT: ReadonlyMap<string, SubtitleFileType> = new Map<string, SubtitleFileType>([
  ["vtt", "vtt"],
  ["srt", "srt"],
  ["sbv", "sbv"],
])

/** File-name extension → Aquilla type, for a notebook that names no importer. */
const FILE_TYPES_BY_EXT: ReadonlyMap<string, LegacyFileType> = new Map<string, LegacyFileType>([
  ["usfm", "usfm"],
  ["sfm", "usfm"],
  ["usf", "usfm"],
  ["vtt", "vtt"],
  ["srt", "srt"],
  ["sbv", "sbv"],
  ["md", "md"],
  ["markdown", "md"],
  ["txt", "txt"],
  ["csv", "csv"],
  ["tsv", "tsv"],
  ["xlsx", "xlsx"],
  ["tmx", "tmx"],
  ["docx", "docx"],
  ["mp3", "audio"],
  ["wav", "audio"],
  ["m4a", "audio"],
  ["ogg", "audio"],
  ["flac", "audio"],
  ["aac", "audio"],
])

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Lower-cased extension of a file name, without the dot; undefined when it has none. */
export function fileExtensionOf(name: string | undefined): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/.exec(name ?? "")
  return match ? match[1].toLowerCase() : undefined
}

/** The first name that carries an extension, else the first name at all —
 *  the names are read FOR their extension, so a bare one must not shadow a
 *  telling one on the other notebook. */
function namedFirst(a: string | undefined, b: string | undefined): string | undefined {
  if (fileExtensionOf(a)) return a
  if (fileExtensionOf(b)) return b
  return a ?? b
}

/**
 * The origin facts of one source/target pair. The target notebook is read
 * first and the source fills what it lacks: Codex stamps `importerType` on the
 * source at import and copies it onto the `.codex`, so the two agree whenever
 * both exist, and a target-only file still answers.
 */
export function legacyCodexFileMeta(pair: {
  source?: CodexNotebookFile
  target?: CodexNotebookFile
}): LegacyCodexFileMeta | undefined {
  const t = pair.target?.metadata
  const s = pair.source?.metadata
  const importerType = text(t?.importerType) ?? text(s?.importerType)
  const originalFileName = namedFirst(text(t?.originalFileName), text(s?.originalFileName))
  const originalName = namedFirst(text(t?.originalName), text(s?.originalName))
  const audioOnly = t?.audioOnly === true || s?.audioOnly === true
  const videoUrl = text(t?.videoUrl) ?? text(s?.videoUrl)
  const meta: LegacyCodexFileMeta = {
    ...(importerType ? { importerType } : {}),
    ...(originalFileName ? { originalFileName } : {}),
    ...(originalName ? { originalName } : {}),
    ...(audioOnly ? { audioOnly: true as const } : {}),
    ...(videoUrl ? { videoUrl } : {}),
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

function subtitleTypeOf(name: string | undefined): SubtitleFileType | undefined {
  const ext = fileExtensionOf(name)
  return ext ? SUBTITLE_TYPES_BY_EXT.get(ext) : undefined
}

/** The Aquilla type the facts resolve to, or undefined to keep `codex`. */
export function legacyFileTypeFor(meta: LegacyCodexFileMeta | undefined): LegacyFileType | undefined {
  if (!meta) return undefined
  if (meta.importerType) {
    const mapped = IMPORTER_FILE_TYPES.get(meta.importerType)
    if (mapped !== "subtitle") return mapped
    // Codex's one subtitle importer takes VTT, SRT and SBV alike; the name says
    // which, and VTT — what the Chosen projects are — when it does not.
    return subtitleTypeOf(meta.originalFileName) ?? subtitleTypeOf(meta.originalName) ?? "vtt"
  }
  const ext = fileExtensionOf(meta.originalFileName) ?? fileExtensionOf(meta.originalName)
  return ext ? FILE_TYPES_BY_EXT.get(ext) : undefined
}
