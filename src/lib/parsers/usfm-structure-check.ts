// USFM structure checks — Paratext parity for the "Chapter/Verse Numbers" and
// "Markers" rows (AQU-1731).
//
// In Paratext these two checks run FIRST, because every other check depends on
// a file whose refs and markers are sound. Before this module the app had
// neither: duplicate verse refs only reached a `console.warn` at import
// (`parse-text-formats.ts`) and an unrecognized marker degraded silently
// (`usfm-markers.ts`). Both now surface as findings, each carrying the ref it
// came from, so a broken file is reported before anyone translates it.
//
// Scope note — versification. "Extra" or "missing" relative to a *canon*
// (does PSA 151 exist? does GEN 1 end at 31?) needs the versification
// resolver being ported in AQU-1284 and hosted in AQU-1287. Until that lands,
// these checks are grounded in the file's own refs, exactly as the ticket
// specifies: a gap, a repeat, or a backwards step inside the file's own
// numbering is unambiguous without any scheme. When the resolver arrives, the
// canon comparison joins the numbering codes below rather than replacing them.
//
// Two exemptions keep real-world files clean (verified against the aligned
// unfoldingWord fixtures in `__fixtures__/`, which must produce zero findings):
//
//   1. **Milestones** (`\zaln-s …\*`, `\qt-s`, `\ts\*`, `\cat`) close with a
//      bare `\*`, which `tokenizeUsfm` deliberately leaves inside a text token
//      (`MARKER_RE` requires a letter after the backslash). They therefore take
//      no part in the paired-marker stack, and their names are never reported
//      unknown.
//   2. **The `z` namespace** is project-defined extension space in USFM 3.x and
//      must be tolerated, so `\zaln-s`, `\zpa-xb`, `\zwhatever` are custom, not
//      unknown. This is the same tolerance the lossless parser already relies on
//      to round-trip markers it does not model.

import { tokenizeUsfm, type UsfmMarkerToken, type UsfmToken } from "./usfm-tokenize"
import { classifyMarker } from "./usfm-markers"

export type UsfmStructureCode =
  | "chapter-duplicate"
  | "chapter-missing"
  | "chapter-out-of-order"
  | "chapter-invalid"
  | "verse-duplicate"
  | "verse-missing"
  | "verse-out-of-order"
  | "verse-invalid"
  | "verse-outside-chapter"
  | "marker-unknown"
  | "marker-unclosed"
  | "marker-unopened"
  | "marker-level-mixed"
  | "marker-after-chapter"

export type UsfmStructureSeverity = "error" | "warning"

export interface UsfmStructureFinding {
  code: UsfmStructureCode
  severity: UsfmStructureSeverity
  /** Where it was found: `"GEN 1:3"`, `"GEN 1"`, or `"GEN"` in the header
   *  region before the first `\c`. Empty when the file carries no `\id`. */
  ref: string
  /** The offending marker or number, for the report line. */
  detail: string
  /** Character offset of the offending token in the input. */
  offset: number
}

/** Duplicate / out-of-order / unopened-marker problems are unambiguous breakage;
 *  a numbering GAP is a warning because a translation may legitimately omit a
 *  verse its source lacks (Paratext treats those as waivable findings too). */
const SEVERITY: Record<UsfmStructureCode, UsfmStructureSeverity> = {
  "chapter-duplicate": "error",
  "chapter-missing": "warning",
  "chapter-out-of-order": "error",
  "chapter-invalid": "error",
  "verse-duplicate": "error",
  "verse-missing": "warning",
  "verse-out-of-order": "error",
  "verse-invalid": "error",
  "verse-outside-chapter": "error",
  "marker-unknown": "warning",
  "marker-unclosed": "error",
  "marker-unopened": "error",
  "marker-level-mixed": "warning",
  "marker-after-chapter": "warning",
}

/** Identification markers that are legal anywhere in a book, unlike the rest
 *  of the header block. Translators and publishers scatter `\\rem` notes and
 *  `\\sts` status lines mid-chapter routinely, so flagging them after the
 *  first `\\c` would fire on most real Paratext files. */
const POSITION_FREE: ReadonlySet<string> = new Set(["rem", "sts"])

/** USFM 3 milestone naming: `\xx-s …\*` / `\xx-e\*`. */
const MILESTONE_SUFFIX = /-[se]$/

/** Project-defined extension space (USFM 3.x §"custom markers"). */
const isCustomNamespace = (name: string): boolean => name.startsWith("z")

/** Markers that never participate in the paired-marker stack: their closing
 *  token is a bare `\*` the tokenizer does not emit as a marker. */
function isMilestone(token: UsfmMarkerToken): boolean {
  if (MILESTONE_SUFFIX.test(token.name)) return true
  return classifyMarker(token.raw)?.category === "milestone"
}

/** A marker whose name the taxonomy does not model AND that is not in the
 *  tolerated custom/milestone space. */
function isUnknownMarker(token: UsfmMarkerToken): boolean {
  if (classifyMarker(token.raw)) return false
  return !isCustomNamespace(token.name) && !MILESTONE_SUFFIX.test(token.name)
}

/** `\c`/`\v` numbers sit in the text run immediately after the marker.
 *  Returns the first number, the end of a `\v 1-2` bridge, and whether the
 *  run began with something numeric at all. */
interface ParsedNumber {
  first: number
  last: number
  raw: string
  numeric: boolean
}

const NUMBER_RUN = /^\s*(\d+)(?:\s*[-–]\s*(\d+))?([a-zA-Z]?)/

function parseNumberAfter(tokens: UsfmToken[], index: number): ParsedNumber {
  const next = tokens[index + 1]
  const text = next?.type === "text" ? next.text : ""
  const m = NUMBER_RUN.exec(text)
  if (!m) {
    return { first: 0, last: 0, raw: text.trim().split(/\s+/)[0] ?? "", numeric: false }
  }
  const first = Number(m[1])
  const last = m[2] ? Number(m[2]) : first
  return { first, last, raw: `${m[1]}${m[2] ? `-${m[2]}` : ""}${m[3]}`, numeric: true }
}

const bookIdOf = (tokens: UsfmToken[], index: number): string => {
  const next = tokens[index + 1]
  if (next?.type !== "text") return ""
  return next.text.trim().split(/\s+/)[0]?.toUpperCase() ?? ""
}

/** Marker families that may legitimately be written bare or numbered; mixing
 *  `\q` with `\q1` (or `\s` with `\s1`) in one file is the near-duplicate
 *  Paratext's Markers check flags. */
const LEVELLED_FAMILY = /^([a-z]+)(\d+)$/

/** A single numbering gap is reported per missing number, so a nonsense jump
 *  (`\\c 1` then `\\c 9999`) would otherwise produce thousands of findings from
 *  one defect. Past this many, the gap is reported up to the cap and the rest
 *  is left to the one out-of-range finding the jump itself produces. */
const MAX_GAP_REPORTED = 25

export function checkUsfmStructure(raw: string): UsfmStructureFinding[] {
  const tokens = tokenizeUsfm(raw)
  const findings: UsfmStructureFinding[] = []
  const add = (code: UsfmStructureCode, ref: string, detail: string, offset: number): void => {
    findings.push({ code, severity: SEVERITY[code], ref, detail, offset })
  }

  let bookId = ""
  let chapter = 0
  let highestChapter = 0
  let verse = 0
  let highestVerse = 0
  let sawChapter = false
  const chaptersSeen = new Set<number>()
  let versesSeen = new Set<number>()
  /** Open paired markers, outermost first. */
  const openPairs: { token: UsfmMarkerToken; ref: string }[] = []
  /** family base → whether a bare and/or a numbered variant was seen. */
  const levels = new Map<string, { bare: boolean; numbered: boolean }>()

  const chapterRef = (): string => (bookId ? `${bookId} ${chapter}` : `${chapter}`)
  const verseRef = (): string =>
    chapter === 0 ? bookId : verse === 0 ? chapterRef() : `${chapterRef()}:${verse}`

  /** A new block ends any still-open inline/note marker. Report the OUTERMOST
   *  one — the cascade above it is note-content markers (`\ft`, `\xt`) the
   *  parent implicitly terminates, not separate defects. */
  const flushOpenPairs = (): void => {
    const outermost = openPairs[0]
    if (outermost) {
      add("marker-unclosed", outermost.ref, outermost.token.raw, outermost.token.start)
    }
    openPairs.length = 0
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type !== "marker") continue
    const spec = classifyMarker(token.raw)

    if (isUnknownMarker(token)) {
      add("marker-unknown", chapter === 0 ? bookId : verseRef(), token.raw, token.start)
    }

    // `token.name` is digit-stripped, so compare the RAW name to tell \q from \q1.
    const bare = token.raw.replace(/^\\\+?/, "").replace(/\*$/, "")
    const family = LEVELLED_FAMILY.exec(bare)
    if (family) {
      const entry = levels.get(family[1]) ?? { bare: false, numbered: false }
      entry.numbered = true
      levels.set(family[1], entry)
    } else if (/^[a-z]+$/.test(bare)) {
      const entry = levels.get(bare) ?? { bare: false, numbered: false }
      entry.bare = true
      levels.set(bare, entry)
    }

    // ── paired-marker balance ───────────────────────────────────────────
    if (spec?.paired && !isMilestone(token) && !isCustomNamespace(token.name)) {
      if (token.isEnd) {
        const at = openPairs.map((p) => p.token.name).lastIndexOf(token.name)
        if (at === -1) {
          add("marker-unopened", verseRef(), token.raw, token.start)
        } else {
          // Anything above the match is note content the parent closes.
          openPairs.length = at
        }
      } else {
        openPairs.push({ token, ref: verseRef() })
      }
    }

    if (spec?.structural && !token.isEnd && !token.nested) {
      flushOpenPairs()
    }

    // ── chapter / verse numbering ───────────────────────────────────────
    if (token.name === "id" && !token.isEnd) {
      bookId = bookIdOf(tokens, i)
      continue
    }

    if (token.name === "c" && !token.isEnd && token.raw.replace(/^\\/, "") === "c") {
      const parsed = parseNumberAfter(tokens, i)
      if (!parsed.numeric) {
        add("chapter-invalid", bookId, parsed.raw || "(blank)", token.start)
        continue
      }
      const next = parsed.first
      if (chaptersSeen.has(next)) {
        add("chapter-duplicate", bookId ? `${bookId} ${next}` : `${next}`, String(next), token.start)
      } else if (next < highestChapter) {
        add("chapter-out-of-order", bookId ? `${bookId} ${next}` : `${next}`, `${next} follows ${highestChapter}`, token.start)
      } else {
        const lastReported = Math.min(next - 1, highestChapter + MAX_GAP_REPORTED)
        for (let missing = highestChapter + 1; missing <= lastReported; missing++) {
          add("chapter-missing", bookId ? `${bookId} ${missing}` : `${missing}`, String(missing), token.start)
        }
      }
      chaptersSeen.add(next)
      chapter = next
      highestChapter = Math.max(highestChapter, next)
      sawChapter = true
      versesSeen = new Set<number>()
      verse = 0
      highestVerse = 0
      continue
    }

    if (token.name === "v" && !token.isEnd && token.raw.replace(/^\\/, "") === "v") {
      const parsed = parseNumberAfter(tokens, i)
      if (!parsed.numeric || parsed.first === 0) {
        add("verse-invalid", sawChapter ? chapterRef() : bookId, parsed.raw || "(blank)", token.start)
        continue
      }
      if (!sawChapter) {
        add("verse-outside-chapter", bookId, `\\v ${parsed.raw}`, token.start)
      }
      if (versesSeen.has(parsed.first)) {
        add("verse-duplicate", `${chapterRef()}:${parsed.first}`, parsed.raw, token.start)
      } else if (parsed.first < highestVerse) {
        add(
          "verse-out-of-order",
          `${chapterRef()}:${parsed.first}`,
          `${parsed.raw} follows ${highestVerse}`,
          token.start,
        )
      } else {
        const lastReported = Math.min(parsed.first - 1, highestVerse + MAX_GAP_REPORTED)
        for (let missing = highestVerse + 1; missing <= lastReported; missing++) {
          add("verse-missing", `${chapterRef()}:${missing}`, String(missing), token.start)
        }
      }
      for (let n = parsed.first; n <= parsed.last; n++) versesSeen.add(n)
      verse = parsed.first
      highestVerse = Math.max(highestVerse, parsed.last)
      continue
    }

    // Identification / introduction markers belong to the header region; after
    // the first \c they are misplaced (Paratext "marker in invalid position").
    if (
      sawChapter &&
      !token.isEnd &&
      !POSITION_FREE.has(token.name) &&
      (spec?.category === "identification" || spec?.category === "introduction")
    ) {
      add("marker-after-chapter", verseRef(), token.raw, token.start)
    }
  }

  flushOpenPairs()

  for (const [base, seen] of levels) {
    if (seen.bare && seen.numbered) {
      add("marker-level-mixed", bookId, `\\${base} and \\${base}1`, 0)
    }
  }

  return findings
}

/** Marker-only subset, for a single cell's text (the live editor check). Cell
 *  text carries no `\c`/`\v`, so numbering findings never apply there. */
const MARKER_CODES: ReadonlySet<UsfmStructureCode> = new Set<UsfmStructureCode>([
  "marker-unknown",
  "marker-unclosed",
  "marker-unopened",
])

export function checkUsfmMarkers(raw: string): UsfmStructureFinding[] {
  return checkUsfmStructure(raw).filter((f) => MARKER_CODES.has(f.code))
}

/** True when the text carries at least one marker the taxonomy models — the
 *  guard that keeps the live check off non-scripture content, where a literal
 *  `\n` in a software string would otherwise read as an unknown marker. */
export function looksLikeUsfm(raw: string): boolean {
  if (!raw.includes("\\")) return false
  return tokenizeUsfm(raw).some((t) => t.type === "marker" && classifyMarker(t.raw) !== undefined)
}
