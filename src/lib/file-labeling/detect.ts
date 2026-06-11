import type { ProjectRecord, FileReference } from "@/lib/parsers/types"
import { getBookName, isKnownBookCode } from "./bible-book-names"
import { getTestament } from "@/lib/codex-editor/bible-books"

export interface RenameSuggestion {
  fileId: string
  currentName: string
  suggestedName: string
  currentCorpus?: string
  suggestedCorpus?: string
  source: "bible-book" | "season-episode" | "numbered-family"
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

function detectBibleBook(file: FileReference): RenameSuggestion | null {
  if (file.type !== "usfm" && file.type !== "ebible") return null
  const stem = stripExt(file.name)

  // Try to extract a 3-char book code from the stem.
  // Check end first (handles "40-MAT"), then front (handles "gen", "Genesis").
  // A candidate is only accepted if it is a known book code.
  const endCandidate = stem.match(/([A-Za-z0-9]{3})$/)?.[1]
  const frontCandidate = stem.match(/^([A-Za-z0-9]{3})/)?.[1]
  const codeMatch =
    (endCandidate && isKnownBookCode(endCandidate) ? endCandidate : undefined)
    ?? (frontCandidate && isKnownBookCode(frontCandidate) ? frontCandidate : undefined)

  if (!codeMatch) return null

  const name = getBookName(codeMatch)!
  const corpus = getTestament(codeMatch)!

  // Friendly label already applied. corpusMarker is client-local (not on the
  // server projection) and is often missing after reload — don't re-prompt.
  if (file.name === name) return null

  return {
    fileId: file.id,
    currentName: file.name,
    suggestedName: name,
    currentCorpus: file.corpusMarker,
    suggestedCorpus: corpus,
    source: "bible-book",
  }
}

function detectSeasonEpisode(file: FileReference): RenameSuggestion | null {
  if (file.type !== "vtt" && file.type !== "srt") return null
  const stem = stripExt(file.name)
  let season: number | null = null
  let episode: number | null = null

  const sxEx = stem.match(/[Ss](\d{1,2})[Ee](\d{1,3})/)
  if (sxEx) {
    season = parseInt(sxEx[1], 10)
    episode = parseInt(sxEx[2], 10)
  } else {
    // Match a bare 3-4 digit run (not part of a longer digit sequence)
    const bare = stem.match(/(?<!\d)(\d{3,4})(?!\d)/)
    if (bare) {
      const digits = bare[1]
      if (digits.length === 3) {
        season = parseInt(digits[0], 10)
        episode = parseInt(digits.slice(1), 10)
      } else {
        // 4 digits: SS EE
        season = parseInt(digits.slice(0, 2), 10)
        episode = parseInt(digits.slice(2), 10)
      }
    }
  }

  if (season == null || episode == null || season === 0) return null

  const suggestedName = `Season ${season} \u00b7 Episode ${episode}`
  const suggestedCorpus = `Season ${season}`

  if (file.name === suggestedName && file.corpusMarker === suggestedCorpus) return null

  return {
    fileId: file.id,
    currentName: file.name,
    suggestedName,
    currentCorpus: file.corpusMarker,
    suggestedCorpus,
    source: "season-episode",
  }
}

function detectNumberedFamily(files: FileReference[]): RenameSuggestion[] {
  interface Entry { file: FileReference; stem: string; num: string }
  const parsed: Entry[] = []

  for (const file of files) {
    const stem = stripExt(file.name)
    const m = stem.match(/^(.+?)[-_\s]?(\d+)$/)
    if (!m) continue
    const base = m[1].trim().replace(/[-_\s]+$/, "")
    if (!base) continue
    parsed.push({ file, stem: base, num: m[2] })
  }

  const byStem = new Map<string, Entry[]>()
  for (const e of parsed) {
    const key = e.stem.toLowerCase()
    const arr = byStem.get(key) ?? []
    arr.push(e)
    byStem.set(key, arr)
  }

  const out: RenameSuggestion[] = []
  for (const [, group] of byStem) {
    if (group.length < 2) continue
    const width = Math.max(...group.map((g) => g.num.length), 2)
    for (const e of group) {
      const padded = e.num.padStart(width, "0")
      if (e.file.name === padded && e.file.corpusMarker === e.stem) continue
      out.push({
        fileId: e.file.id,
        currentName: e.file.name,
        suggestedName: padded,
        currentCorpus: e.file.corpusMarker,
        suggestedCorpus: e.stem,
        source: "numbered-family",
      })
    }
  }
  return out
}

export function detectSuggestions(project: ProjectRecord): RenameSuggestion[] {
  const out: RenameSuggestion[] = []
  const claimed = new Set<string>()

  for (const file of project.files) {
    try {
      const bible = detectBibleBook(file)
      if (bible) { out.push(bible); claimed.add(file.id); continue }
      const se = detectSeasonEpisode(file)
      if (se) { out.push(se); claimed.add(file.id); continue }
    } catch (e) {
      console.warn(`[detect] error on file ${file.id}:`, e)
    }
  }

  const remainder = project.files.filter((f) => !claimed.has(f.id))
  try {
    out.push(...detectNumberedFamily(remainder))
  } catch (e) {
    console.warn(`[detect] numbered-family error:`, e)
  }

  return out
}
