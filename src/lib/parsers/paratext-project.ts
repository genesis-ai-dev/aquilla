// Assemble a Paratext project (folder or unzipped archive) into an import plan
// that "feels like home" to a consultant: books named in their own language,
// in canonical order, OT/NT grouped, with the project's language + direction
// captured — and the original bytes kept for round-trip export.

import {
  parseParatextSettings,
  parseBookNames,
  bookDisplayName,
  looksRightToLeft,
  type ParatextSettings,
  type ParatextBookName,
} from "./paratext"
import { parseUsfmLossless } from "./usfm-lossless"
import { getBookName, getBookOrdinal } from "../file-labeling/bible-book-names"

/** Index of MAT in the canonical table — first NT book. Books at or after
 *  this ordinal are NT, before it are OT. */
const NT_START_ORDINAL = 39

/** A file entry abstracted over its source (browser File, JSZip entry, fs). */
export interface ProjectEntry {
  /** Basename or relative path within the project. */
  name: string
  /** Read the entry as UTF-8 text. */
  text(): Promise<string>
  /** Exact member bytes when the browser adapter can provide them. */
  bytes?(): Promise<ArrayBuffer>
}

export interface ProjectSourceArtifact {
  name: string
  format: "paratext-project"
  /** Exact selected ZIP, or a deterministic ZIP of every selected folder member. */
  bytes(): Promise<ArrayBuffer>
}

export type ProjectEntryCollection = ProjectEntry[] & {
  sourceArtifact?: ProjectSourceArtifact
}

export interface ParatextBook {
  /** Original SFM filename (preserved for export naming). */
  fileName: string
  /** Book code from the file's \id line, uppercased. */
  bookId: string
  /** Localized display name (BookNames short → English fallback → code). */
  displayName: string
  /** "OT" | "NT" | undefined (unknown/deuterocanon/peripheral). */
  corpusMarker: "OT" | "NT" | undefined
  /** Canonical sort ordinal (unknown books sort last). */
  order: number
  /** Raw SFM bytes — the side-car source of truth for round-trip. */
  rawSource: string
  /** Verse + heading counts (a quick "is this book substantial?" signal). */
  verseCount: number
}

export interface ParatextProject {
  settings: ParatextSettings
  bookNames: Map<string, ParatextBookName>
  /** Books in canonical order. */
  books: ParatextBook[]
}

function basename(p: string): string {
  return p.split("/").pop() ?? p
}

export interface DetectedParatext {
  /** Present for a full project; absent for a partial bundle (BookNames + SFM
   *  only) — common for exported/low-resource projects. */
  settingsEntry?: ProjectEntry
  bookNamesEntry?: ProjectEntry
  sfmEntries: ProjectEntry[]
}

/** Identify a Paratext project (or partial bundle) within a set of entries. A
 *  project is recognized when there's at least one SFM/USFM file AND either a
 *  Settings.xml (or legacy .ssf) or a BookNames.xml — so exported bundles that
 *  ship only BookNames + books (no Settings) still get the localized-name,
 *  ordered-import treatment. Returns null otherwise (plain per-file import). */
export function detectParatextProject(entries: ProjectEntry[]): DetectedParatext | null {
  let settingsEntry: ProjectEntry | undefined
  let bookNamesEntry: ProjectEntry | undefined
  const sfmEntries: ProjectEntry[] = []
  for (const e of entries) {
    const b = basename(e.name).toLowerCase()
    if (b === "settings.xml" || b.endsWith(".ssf")) {
      // Prefer Settings.xml over a legacy .ssf if both are present.
      if (!settingsEntry || b === "settings.xml") settingsEntry = e
    } else if (b === "booknames.xml") {
      bookNamesEntry = e
    } else if (b.endsWith(".sfm") || b.endsWith(".usfm")) {
      sfmEntries.push(e)
    }
  }
  if (sfmEntries.length === 0) return null
  if (!settingsEntry && !bookNamesEntry) return null
  return { settingsEntry, bookNamesEntry, sfmEntries }
}

/** Settings for a partial bundle with no Settings.xml — language/versification
 *  unknown; direction is inferred from content downstream. */
function defaultSettings(): ParatextSettings {
  return {
    name: "",
    fullName: "",
    language: "",
    languageIsoCode: "",
    versification: "",
    encoding: "",
    rightToLeft: false,
    naming: { prePart: "", postPart: "", bookNameForm: "" },
  }
}

function corpusOf(order: number): "OT" | "NT" | undefined {
  if (order < 0) return undefined
  return order >= NT_START_ORDINAL ? "NT" : "OT"
}

/** Parse a detected Paratext project into an ordered, named import plan. */
export async function assembleParatextProject(
  entries: ProjectEntry[],
): Promise<ParatextProject | null> {
  const detected = detectParatextProject(entries)
  if (!detected) return null

  const settings = detected.settingsEntry
    ? parseParatextSettings(await detected.settingsEntry.text())
    : defaultSettings()
  const bookNames = detected.bookNamesEntry
    ? parseBookNames(await detected.bookNamesEntry.text())
    : new Map<string, ParatextBookName>()

  const books: ParatextBook[] = []
  let rtlVotes = 0
  let sampled = 0

  for (const e of detected.sfmEntries) {
    const raw = await e.text()
    const doc = parseUsfmLossless(raw)
    const bookId = (doc.bookId || basename(e.name).replace(/\.(sfm|usfm)$/i, "")).toUpperCase()
    const order = getBookOrdinal(bookId)
    books.push({
      fileName: basename(e.name),
      bookId,
      displayName: bookDisplayName(bookId, bookNames, getBookName(bookId)),
      corpusMarker: corpusOf(order),
      order: order < 0 ? 9999 : order,
      rawSource: raw,
      verseCount: doc.verses.length,
    })
    sampled++
    if (looksRightToLeft(raw.slice(0, 3000))) rtlVotes++
  }

  // Stable canonical order; unknown books keep input order after the knowns.
  books.sort((a, b) => a.order - b.order)

  // RTL: trust the ISO-derived flag, but if the script is clearly RTL by
  // content and settings didn't say so (common for older/derived settings),
  // believe the content.
  if (!settings.rightToLeft && sampled > 0 && rtlVotes / sampled > 0.5) {
    settings.rightToLeft = true
  }

  return { settings, bookNames, books }
}
