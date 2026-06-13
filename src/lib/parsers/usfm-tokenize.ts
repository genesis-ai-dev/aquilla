// USFM tokenizer + byte-level run classifier.
//
// This is the proof engine behind the promise to a skeptical consultant:
// "every translatable run is reachable, and nothing is lost." It partitions
// a USFM file into a sequence of runs that EXACTLY cover every byte:
//
//   marker     — a backslash marker (\v, \f, \nd*, \+xt)         [scaffolding]
//   translatable — natural-language text a translator localizes  [reachable]
//   reference  — a verse/chapter ref or origin (\fr, \xo body)   [scaffolding]
//   number     — a verse or chapter number after \v / \c          [scaffolding]
//   whitespace — runs of only whitespace between content          [preserved]
//   metadata   — \id / \ide / \rem body (not localized)           [preserved]
//
// Because the runs exactly partition the file, reassembling them reproduces
// the original byte-for-byte (round-trip). Because every translatable run is
// attributed to a unit (a verse, a heading, a note), we can prove there is no
// orphaned translatable text.
//
// Decisions follow the taxonomy in usfm-markers.ts so they're auditable.

import {
  classifyMarker,
  normalizeMarker,
  isEndMarker,
  isNestedMarker,
} from "./usfm-markers"

export interface UsfmMarkerToken {
  type: "marker"
  /** Full marker text incl. backslash, e.g. "\\v", "\\f*", "\\+xt". */
  raw: string
  /** Normalized base name: "v", "f", "nd", "xt". */
  name: string
  start: number
  end: number
  isEnd: boolean
  nested: boolean
}
export interface UsfmTextToken {
  type: "text"
  text: string
  start: number
  end: number
}
export type UsfmToken = UsfmMarkerToken | UsfmTextToken

// Marker names are mostly lowercase ASCII, but usfm.sty also defines mixed-case
// (\xtSee, \xtSeeAlso) and hyphenated z-namespace markers (\zpa-xb).
const MARKER_RE = /\\\+?[a-zA-Z]+(?:-[a-zA-Z]+)*\d*\*?/g

/** Split raw USFM into marker + text tokens that EXACTLY partition the input
 *  (concatenating token substrings reproduces the original). */
export function tokenizeUsfm(raw: string): UsfmToken[] {
  const tokens: UsfmToken[] = []
  let last = 0
  let m: RegExpExecArray | null
  MARKER_RE.lastIndex = 0
  while ((m = MARKER_RE.exec(raw)) !== null) {
    if (m.index > last) {
      tokens.push({ type: "text", text: raw.slice(last, m.index), start: last, end: m.index })
    }
    const rawMarker = m[0]
    tokens.push({
      type: "marker",
      raw: rawMarker,
      name: normalizeMarker(rawMarker),
      start: m.index,
      end: m.index + rawMarker.length,
      isEnd: isEndMarker(rawMarker),
      nested: isNestedMarker(rawMarker),
    })
    last = m.index + rawMarker.length
  }
  if (last < raw.length) {
    tokens.push({ type: "text", text: raw.slice(last), start: last, end: raw.length })
  }
  return tokens
}

export type RunKind =
  | "marker"
  | "translatable"
  | "reference"
  | "number"
  | "whitespace"
  | "metadata"

export interface ClassifiedRun {
  kind: RunKind
  start: number
  end: number
  text: string
  /** Taxonomy role or a synthetic label ("verse-number", "marker:f", …). */
  role: string
  /** Grouping id for translatable runs: verse ref, heading ref, or note id.
   *  Empty for scaffolding/whitespace. */
  unit: string
}

const WS_RE = /^\s*$/

function pushText(
  runs: ClassifiedRun[],
  kind: RunKind,
  role: string,
  unit: string,
  text: string,
  start: number,
): void {
  if (text.length === 0) return
  // Peel leading/trailing whitespace into their own runs so translatable runs
  // carry only real content (keeps coverage honest + serialization clean).
  if (kind === "translatable" || kind === "reference" || kind === "number" || kind === "metadata") {
    const lead = text.match(/^\s*/)![0]
    // All-whitespace: emit a single whitespace run (lead === text), otherwise
    // lead and trail would both capture the whole string and double-count.
    if (lead.length === text.length) {
      runs.push({ kind: "whitespace", role: "whitespace", unit: "", text, start, end: start + text.length })
      return
    }
    const trail = text.slice(lead.length).match(/\s*$/)![0]
    const coreStart = start + lead.length
    const core = text.slice(lead.length, text.length - trail.length)
    if (lead) runs.push({ kind: "whitespace", role: "whitespace", unit: "", text: lead, start, end: coreStart })
    runs.push({ kind, role, unit, text: core, start: coreStart, end: coreStart + core.length })
    if (trail) {
      const ts = coreStart + core.length
      runs.push({ kind: "whitespace", role: "whitespace", unit: "", text: trail, start: ts, end: ts + trail.length })
    }
    return
  }
  runs.push({ kind, role, unit, text, start, end: start + text.length })
}

/** Classify every byte of a USFM document. Runs exactly partition the input. */
export function classifyRuns(raw: string): ClassifiedRun[] {
  const tokens = tokenizeUsfm(raw)
  const runs: ClassifiedRun[] = []

  let bookId = ""
  let chapter = 0
  let verseNum = ""
  let verseRef = ""
  let pendingVerseNumber = false
  let pendingChapterNumber = false
  let pendingMetadata = false
  // Current line-level translatable context (heading/title/intro), if any.
  let blockRole = "" // "" | taxonomy role of the current translatable block
  let blockUnit = ""
  // Note context (footnote / endnote / cross-reference).
  let inNote = false
  let noteId = ""
  let noteInner = "" // last inner marker name within the note (ft/fr/xt/xo…)
  const noteCounts = new Map<string, number>()

  // First pass: resolve bookId from the first \id body so refs are correct.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.type === "marker" && t.name === "id") {
      const nxt = tokens[i + 1]
      if (nxt && nxt.type === "text") {
        const tok = nxt.text.trim().split(/\s+/)[0]
        if (tok) bookId = tok.toUpperCase()
      }
      break
    }
  }

  for (const tok of tokens) {
    if (tok.type === "marker") {
      runs.push({
        kind: "marker",
        role: `marker:${tok.name}`,
        unit: inNote ? noteId : verseRef,
        text: tok.raw,
        start: tok.start,
        end: tok.end,
      })
      const spec = classifyMarker(tok.raw)

      if (tok.isEnd) {
        // Close a note context when its container ends.
        if (tok.name === "f" || tok.name === "fe" || tok.name === "x") {
          inNote = false
          noteInner = ""
        }
        continue
      }
      if (tok.nested) continue // \+xt etc. — inner content classified by base below via noteInner? keep simple: treat as note-inner if in note

      if (tok.name === "id" || tok.name === "ide" || tok.name === "rem" || tok.name === "sts") {
        pendingMetadata = true
        blockRole = ""
        continue
      }
      if (tok.name === "c") {
        pendingChapterNumber = true
        blockRole = ""
        verseRef = ""
        verseNum = ""
        continue
      }
      if (tok.name === "v") {
        pendingVerseNumber = true
        blockRole = "verse"
        continue
      }
      if (tok.name === "f" || tok.name === "fe" || tok.name === "x") {
        inNote = true
        const n = (noteCounts.get(tok.name) ?? 0) + 1
        noteCounts.set(tok.name, n)
        noteId = `${verseRef || `${bookId} ${chapter}`}#${tok.name}${n}`
        noteInner = ""
        continue
      }
      if (inNote) {
        noteInner = tok.name
        continue
      }
      // Line-level block markers outside a note.
      if (spec?.structural) {
        if (spec.translatable && spec.category !== "verse") {
          blockRole = spec.role
          blockUnit = `${verseRef || (chapter > 0 ? `${bookId} ${chapter}` : bookId)}:${tok.name}`
        } else if (
          spec.category === "paragraph" ||
          spec.category === "poetry" ||
          spec.category === "list" ||
          spec.category === "table"
        ) {
          // Flows within the current verse; keep blockRole as "verse" if set.
          if (verseRef) blockRole = "verse"
        } else {
          blockRole = "" // non-translatable structural (\b, \sd, \c handled above)
        }
      }
      continue
    }

    // ── text token ──────────────────────────────────────────────────────
    const text = tok.text
    if (WS_RE.test(text)) {
      runs.push({ kind: "whitespace", role: "whitespace", unit: "", text, start: tok.start, end: tok.end })
      continue
    }

    if (pendingChapterNumber) {
      // "{num} {maybe label}" — number is first token; rest (rare) is label text.
      const mm = text.match(/^(\s*)(\S+)/)!
      const numStart = tok.start + mm[1].length
      chapter = parseInt(mm[2], 10) || chapter
      if (mm[1]) runs.push({ kind: "whitespace", role: "whitespace", unit: "", text: mm[1], start: tok.start, end: numStart })
      runs.push({ kind: "number", role: "chapter-number", unit: "", text: mm[2], start: numStart, end: numStart + mm[2].length })
      const rest = text.slice(mm[0].length)
      if (rest) pushText(runs, "whitespace", "whitespace", "", rest, numStart + mm[2].length)
      pendingChapterNumber = false
      continue
    }

    if (pendingVerseNumber) {
      const mm = text.match(/^(\s*)(\S+)/)!
      const numStart = tok.start + mm[1].length
      verseNum = mm[2]
      verseRef = `${bookId} ${chapter}:${verseNum}`.trim()
      if (mm[1]) runs.push({ kind: "whitespace", role: "whitespace", unit: "", text: mm[1], start: tok.start, end: numStart })
      runs.push({ kind: "number", role: "verse-number", unit: "", text: mm[2], start: numStart, end: numStart + mm[2].length })
      pendingVerseNumber = false
      const rest = text.slice(mm[0].length)
      if (rest) pushText(runs, "translatable", "verse", verseRef, rest, numStart + mm[2].length)
      continue
    }

    if (pendingMetadata) {
      pushText(runs, "metadata", "metadata", "", text, tok.start)
      pendingMetadata = false
      continue
    }

    if (inNote) {
      const innerSpec = noteInner ? classifyMarker(noteInner) : undefined
      const translatable = innerSpec?.translatable ?? false
      if (translatable) {
        pushText(runs, "translatable", innerSpec!.role, noteId, text, tok.start)
      } else {
        // \fr / \xo / caller "+ " / \fv numbers → reference scaffolding.
        pushText(runs, "reference", noteInner ? classifyMarker(noteInner)?.role ?? "note-ref" : "note-caller", noteId, text, tok.start)
      }
      continue
    }

    if (blockRole === "verse" && verseRef) {
      pushText(runs, "translatable", "verse", verseRef, text, tok.start)
      continue
    }
    if (blockRole && blockUnit) {
      pushText(runs, "translatable", blockRole, blockUnit, text, tok.start)
      continue
    }

    // Text with no translatable owner (e.g. stray text before \id). Treat as
    // metadata/preserved so it round-trips; flagged as non-translatable.
    pushText(runs, "metadata", "unattributed", "", text, tok.start)
  }

  return runs
}

export interface CoverageReport {
  totalBytes: number
  bytesByKind: Record<RunKind, number>
  /** Every translatable run, grouped unit + role + text. */
  translatableRuns: ClassifiedRun[]
  /** Translatable runs not attributed to any unit (should always be empty). */
  orphanedTranslatable: ClassifiedRun[]
  /** True iff concatenating runs reproduces the input exactly. */
  roundTrips: boolean
  /** True iff runs exactly partition the input (no gaps/overlaps). */
  partitions: boolean
}

export function analyzeCoverage(raw: string): CoverageReport {
  const runs = classifyRuns(raw)
  const bytesByKind: Record<RunKind, number> = {
    marker: 0, translatable: 0, reference: 0, number: 0, whitespace: 0, metadata: 0,
  }
  let cursor = 0
  let partitions = true
  const reassembled: string[] = []
  for (const r of runs) {
    if (r.start !== cursor) partitions = false
    bytesByKind[r.kind] += r.end - r.start
    reassembled.push(r.text)
    cursor = r.end
  }
  if (cursor !== raw.length) partitions = false
  const translatableRuns = runs.filter((r) => r.kind === "translatable")
  return {
    totalBytes: raw.length,
    bytesByKind,
    translatableRuns,
    orphanedTranslatable: translatableRuns.filter((r) => !r.unit),
    roundTrips: reassembled.join("") === raw,
    partitions,
  }
}
