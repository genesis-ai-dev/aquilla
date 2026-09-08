// Client-side export: one continuous WAV per chapter, verses concatenated
// in verse order. (AQU-1201)
//
// The THIRD audio shape, and the one the Pattani Malay community-check needed.
// `audio-by-character.ts` lays takes onto a mix timeline. `audio-per-line.ts`
// zips one file per verse. Neither lets a reviewer press play once and hear a
// chapter. This concatenates the takes they already have, in verse order, and
// hands back a file they can play outside the editor.
//
// Keep it small. Skip verses with nothing recorded. Do not invent silence for
// the gaps, do not report mixed takes, do not change the other two exports.
// Decode + concat + WAV — the same primitives the character export already
// uses, minus the timeline placement.

import JSZip from "jszip"

import { resolvePcmWindow } from "@/lib/audio/pcm-window"
import { concatPcm, TARGET_RATE } from "@/lib/audio/decode-mono"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"
import { parseFrontierAudioUrl } from "@/lib/audio/upload"
import type { CellData } from "@/hooks/useCells"
import { parseCanonicalRef } from "@/lib/progress/canonical-rollup"
import { characterKey } from "./audio-by-character"

export interface ChapterClip {
  cellId: string
  audioId: string
  url: string
  book: string | null
  chapter: string | null
  verse: string | null
  /** First number in the verse label, so "1-2" sorts with verse 1. */
  verseSort: number
  documentIndex: number
  trimStartMs?: number | null
  trimEndMs?: number | null
}

export interface ChapterGroup {
  /** "MAT 1" when the cells carry canonical refs; "__file__" otherwise. */
  key: string
  book: string | null
  chapter: string | null
  clips: ChapterClip[]
}

export interface ChapterPreview {
  chapterCount: number
  clipCount: number
  /** Verses/lines in the file that still have nothing recorded. */
  missingCount: number
}

const FILE_GROUP_KEY = "__file__"

function bestAudioId(cell: CellData): string | null {
  return cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId ?? null
}

function canonicalOf(cell: CellData) {
  return parseCanonicalRef(cell.group) ?? parseCanonicalRef(cell.context) ?? parseCanonicalRef(cell.section)
}

function verseSortNumber(verse: string): number {
  const n = parseInt(verse, 10)
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

function chapterSortValue(group: ChapterGroup): number {
  if (group.chapter == null) return Number.POSITIVE_INFINITY
  const n = parseInt(group.chapter, 10)
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
}

/**
 * Recorded takes, bucketed by chapter, each bucket in verse order.
 *
 * Verses with no take are omitted — a gap is a skip, not a pad of silence.
 * Cells without a parseable BOOK CH:V ref (a subtitle file, a notes dump)
 * collect into one group so the same export still produces a continuous listen.
 */
export function groupAudioByChapter(cells: CellData[]): ChapterGroup[] {
  const order: string[] = []
  const byKey = new Map<string, ChapterGroup>()

  cells.forEach((cell, documentIndex) => {
    const audioId = bestAudioId(cell)
    if (!audioId) return
    const attachment = cell.attachments?.[audioId]
    if (!attachment?.url) return

    const ref = canonicalOf(cell)
    const key = ref ? `${ref.book} ${ref.chapter}` : FILE_GROUP_KEY
    let group = byKey.get(key)
    if (!group) {
      group = {
        key,
        book: ref?.book ?? null,
        chapter: ref?.chapter ?? null,
        clips: [],
      }
      byKey.set(key, group)
      order.push(key)
    }
    group.clips.push({
      cellId: cell.id,
      audioId,
      url: attachment.url,
      book: ref?.book ?? null,
      chapter: ref?.chapter ?? null,
      verse: ref?.verse ?? null,
      verseSort: ref ? verseSortNumber(ref.verse) : documentIndex,
      documentIndex,
      trimStartMs: attachment.trimStartMs ?? null,
      trimEndMs: attachment.trimEndMs ?? null,
    })
  })

  const groups = order.map((k) => byKey.get(k)!)
  for (const group of groups) {
    group.clips.sort((a, b) => a.verseSort - b.verseSort || a.documentIndex - b.documentIndex)
  }
  return groups.sort((a, b) => {
    if (a.book && b.book && a.book !== b.book) return a.book.localeCompare(b.book)
    return chapterSortValue(a) - chapterSortValue(b)
  })
}

/** Cheap read of who would be in the zip, before any fetch/decode. */
export function previewAudioByChapter(cells: CellData[]): ChapterPreview {
  const groups = groupAudioByChapter(cells)
  const recorded = new Set(groups.flatMap((g) => g.clips.map((c) => c.cellId)))
  let missingCount = 0
  for (const cell of cells) {
    if (!recorded.has(cell.id) && !bestAudioId(cell)) missingCount += 1
  }
  return {
    chapterCount: groups.length,
    clipCount: groups.reduce((n, g) => n + g.clips.length, 0),
    missingCount,
  }
}

/** Filesystem-safe entry name for one chapter: `MAT_1.wav`. */
export function chapterFileName(group: ChapterGroup): string {
  if (group.key === FILE_GROUP_KEY) return "stitched.wav"
  return `${characterKey(group.key)}.wav`
}

export interface ExportChapterArgs {
  cells: CellData[]
  projectId: string
  fetchBytes: (args: { projectId: string; fileId: string; audioId: string; ext: string }) => Promise<Uint8Array>
  decode: (bytes: Uint8Array) => Promise<Float32Array>
  onProgress?: (done: number, total: number) => void
}

export interface ExportChapterResult {
  blob: Blob
  /** `.wav` when the file holds one chapter; `.zip` when it holds several. */
  extension: "wav" | "zip"
  /** Filename suffix the dialog appends to the user-chosen stem. */
  downloadSuffix: string
  chapters: number
  clips: number
  skipped: number
}

export async function exportAudioByChapter(args: ExportChapterArgs): Promise<ExportChapterResult> {
  const groups = groupAudioByChapter(args.cells)
  const cellById = new Map(args.cells.map((c) => [c.id, c]))
  const totalClips = groups.reduce((n, g) => n + g.clips.length, 0)
  const pcmByClip = new Map<string, Promise<Float32Array | null>>()
  const chapterWavs: { name: string; blob: Blob }[] = []
  let done = 0
  let skipped = 0

  for (const group of groups) {
    const pcmClips: Float32Array[] = []
    for (const clip of group.clips) {
      const cell = cellById.get(clip.cellId)!
      const parsed = parseFrontierAudioUrl(clip.url)
      if (!parsed) {
        skipped += 1
        done += 1
        args.onProgress?.(done, totalClips)
        continue
      }
      const clipKey = `${parsed.audioId}.${parsed.ext}`
      let pcmPromise = pcmByClip.get(clipKey)
      if (!pcmPromise) {
        pcmPromise = (async () => {
          const generated = clip.audioId === cell.selectedGeneratedVoiceAudioId
          let bytes: Uint8Array | null = null
          if (generated && parsed.ext === "webm") {
            bytes = await args
              .fetchBytes({ projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: "wav" })
              .catch(() => null)
          }
          if (bytes == null || bytes.length === 0) {
            bytes = await args.fetchBytes({
              projectId: args.projectId,
              fileId: cell.fileId,
              audioId: parsed.audioId,
              ext: parsed.ext,
            })
          }
          return bytes.length > 0 ? await args.decode(bytes) : null
        })()
        pcmByClip.set(clipKey, pcmPromise)
      }
      try {
        const pcm = await pcmPromise
        if (!pcm) {
          skipped += 1
        } else {
          const win = resolvePcmWindow(pcm.length, TARGET_RATE, {
            trimStartMs: clip.trimStartMs,
            trimEndMs: clip.trimEndMs,
          })
          pcmClips.push(win.isFull ? pcm : pcm.subarray(win.start, win.end))
        }
      } catch (err) {
        console.warn(`[audio-chapter] skipping clip ${clip.audioId} (${clip.cellId}):`, err)
        skipped += 1
      }
      done += 1
      args.onProgress?.(done, totalClips)
    }
    if (pcmClips.length === 0) continue
    const joined = concatPcm(pcmClips)
    chapterWavs.push({ name: chapterFileName(group), blob: encodeWavPcm16(joined, TARGET_RATE) })
  }

  if (chapterWavs.length === 0) {
    return {
      blob: new Blob([], { type: "audio/wav" }),
      extension: "wav",
      downloadSuffix: "_stitched.wav",
      chapters: 0,
      clips: totalClips,
      skipped,
    }
  }

  if (chapterWavs.length === 1) {
    const only = chapterWavs[0]!
    const stem = only.name.replace(/\.wav$/i, "")
    return {
      blob: only.blob,
      extension: "wav",
      downloadSuffix: `_${stem}.wav`,
      chapters: 1,
      clips: totalClips,
      skipped,
    }
  }

  const zip = new JSZip()
  const used = new Set<string>()
  for (const entry of chapterWavs) {
    let name = entry.name
    if (used.has(name.toLowerCase())) {
      const dot = name.lastIndexOf(".")
      let n = 2
      let candidate = `${name.slice(0, dot)}_${n}${name.slice(dot)}`
      while (used.has(candidate.toLowerCase())) {
        n += 1
        candidate = `${name.slice(0, dot)}_${n}${name.slice(dot)}`
      }
      name = candidate
    }
    used.add(name.toLowerCase())
    zip.file(name, entry.blob)
  }
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" })
  return {
    blob,
    extension: "zip",
    downloadSuffix: "_audio-chapters.zip",
    chapters: chapterWavs.length,
    clips: totalClips,
    skipped,
  }
}
