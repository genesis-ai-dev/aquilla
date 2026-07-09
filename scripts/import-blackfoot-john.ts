#!/usr/bin/env tsx
// One-off importer: Blackfoot Gospel of John (USFM) + per-chapter audio +
// per-chapter Audacity label tracks → one Aquilla source file whose verse
// cells each carry the matching audio, sliced per verse.
//
// Why a standalone HTTP script (not the client import.ts): the client modules
// read import.meta.env at module-eval and crash under plain Node. This talks
// to the sync-worker HTTP API directly, the same pattern as
// scripts/paratext-import-e2e.ts. The only shared code is the pure, tested
// label-track parser.
//
// Alignment is exact: every USFM \v id (including ranges like 32-34) has one
// matching label-track verse window per chapter — verified across all 21
// chapters. We join by canonical ref "JHN <chapter>:<verseId>".
//
// Audio model: each verse is cut from its chapter MP3 at the label window and
// uploaded as its OWN R2 object, attached whole (slot 'recording', no trim
// window). The Text-lens per-cell player ignores trim windows, so a shared
// clip + trim would play the whole chapter; a per-verse clip plays the verse.
//
// Run (with `pnpm dev` up):
//   npx tsx scripts/import-blackfoot-john.ts [/path/to/John]
//   LIMIT_CHAPTERS=1 npx tsx scripts/import-blackfoot-john.ts   # verify one chapter first

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { parseLabelTrack, groupSegmentsByVerse } from "../src/lib/parsers/label-track"

const AUTH = process.env.AUTH_BASE ?? "http://127.0.0.1:8788"
const SYNC = process.env.SYNC_BASE ?? "http://127.0.0.1:8789"
const PROJECT_ID = process.env.PROJECT_ID ?? "dev-project"
const PROJECT_NAME = process.env.PROJECT_NAME ?? "Dev Project"
// Prod: paste a real identity access token (JWT). Dev: leave unset → /__dev__/login.
const ACCESS_TOKEN = process.env.ACCESS_TOKEN
const BASE_DIR = process.argv[2] ?? "/Users/ryderwishart/Downloads/John"
const BOOK = "JHN"
const SOURCE_LANG = "bla" // Blackfoot (ISO 639-3)
const LIMIT_CHAPTERS = process.env.LIMIT_CHAPTERS ? parseInt(process.env.LIMIT_CHAPTERS, 10) : 21

interface Verse {
  chapter: number
  verseId: string // "1" or "32-34"
  canonicalRef: string // "JHN 1:1"
  text: string
}

interface AttachEvent {
  id: string
  schemaVersion: 1
  kind: "cell.audio.attach"
  projectId: string
  fileId: string
  cellId: string
  parentId: null
  author: string
  payload: {
    audioId: string
    url: string
    slot: "recording"
    mimeType: string
    durationMs: number
  }
  clientTs: number
}

/** Prod: use the provided identity access token. Dev: mint one via /__dev__/login. */
async function getUserJwt(): Promise<string> {
  if (ACCESS_TOKEN) return ACCESS_TOKEN
  const res = await fetch(`${AUTH}/__dev__/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) {
    throw new Error(`dev login HTTP ${res.status} — set ACCESS_TOKEN for non-dev targets`)
  }
  return ((await res.json()) as { access_token: string }).access_token
}

async function mintToken(userJwt: string, fileId: string): Promise<string> {
  const res = await fetch(`${AUTH}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userJwt}` },
    body: JSON.stringify({ projectId: PROJECT_ID, fileId, projectName: PROJECT_NAME }),
  })
  if (!res.ok) throw new Error(`sync-token HTTP ${res.status}`)
  return ((await res.json()) as { token: string }).token
}

/** Extract verses from USFM. Text runs from the `\v` line to the next
 *  backslash marker (so trailing \p paragraph markers are excluded). */
function parseUsfmVerses(usfm: string): Verse[] {
  const verses: Verse[] = []
  let chapter = 0
  let current: Verse | null = null
  const flush = () => {
    if (current) {
      current.text = current.text.replace(/\s+/g, " ").trim()
      verses.push(current)
      current = null
    }
  }
  for (const raw of usfm.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/\r$/, "")
    const mc = line.match(/^\\c\s+(\d+)/)
    if (mc) {
      flush()
      chapter = Number(mc[1])
      continue
    }
    const mv = line.match(/^\\v\s+(\d+(?:-\d+)?)\s*(.*)$/)
    if (mv) {
      flush()
      const verseId = mv[1]
      current = { chapter, verseId, canonicalRef: `${BOOK} ${chapter}:${verseId}`, text: mv[2] ?? "" }
      continue
    }
    if (line.startsWith("\\")) {
      // any other marker (\p, \nb, section heads, …) terminates the verse text
      flush()
      continue
    }
    if (current) current.text += " " + line
  }
  flush()
  return verses
}

function buildAudioId(cellId: string): string {
  const norm = cellId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
  return `audio-${norm}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

/** Cut [startMs,endMs) from an MP3 and return the encoded bytes (piped, no temp
 *  file). Fast input seek + re-encode is frame-accurate enough for verse
 *  boundaries that already sit on punctuation. */
function sliceMp3(inputPath: string, startMs: number, endMs: number): Buffer {
  const startSec = (startMs / 1000).toFixed(3)
  const durSec = ((endMs - startMs) / 1000).toFixed(3)
  return execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-ss", startSec, "-i", inputPath,
      "-t", durSec, "-c:a", "libmp3lame", "-q:a", "4", "-f", "mp3", "pipe:1"],
    { maxBuffer: 64 * 1024 * 1024 },
  )
}

async function postJson(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${SYNC}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

async function main() {
  console.log(`Blackfoot John importer → ${SYNC} (project ${PROJECT_ID})`)
  console.log(`  data: ${BASE_DIR}   chapters: ${LIMIT_CHAPTERS}`)

  const usfm = readFileSync(join(BASE_DIR, "44JHNBLA.SFM"), "utf8")
  const allVerses = parseUsfmVerses(usfm)
  const verses = allVerses.filter((v) => v.chapter >= 1 && v.chapter <= LIMIT_CHAPTERS)
  console.log(`  parsed ${allVerses.length} verses; importing ${verses.length} (chapters 1–${LIMIT_CHAPTERS})`)

  const jwt = await getUserJwt()
  const fileId = randomUUID()
  const token = await mintToken(jwt, fileId)

  // ── 1. Create the book file + verse cells ────────────────────────────────
  const cellIdByRef = new Map<string, string>()
  let prev: string | null = null
  const cells = verses.map((v, i) => {
    const cellId = randomUUID()
    cellIdByRef.set(v.canonicalRef, cellId)
    const cell = {
      id: randomUUID(),
      cellId,
      anchorCellId: prev,
      value: v.text,
      type: "verse",
      canonicalRef: v.canonicalRef,
      sequenceIndex: i,
    }
    prev = cellId
    return cell
  })

  const importRes = await postJson("/import", token, {
    projectId: PROJECT_ID,
    fileId,
    file: {
      id: randomUUID(),
      name: "John (Blackfoot)",
      fileType: "usfm",
      role: "source",
      kind: "usfm",
      importFormat: "usfm",
      parserVersion: "blackfoot-john-v1",
      sourceLanguage: SOURCE_LANG,
      bookCode: BOOK,
    },
    cells,
    clientTs: Date.now(),
  })
  if (!importRes.ok) throw new Error(`/import HTTP ${importRes.status}: ${await importRes.text()}`)
  console.log(`  file ${fileId}: ${(await importRes.json() as { accepted: number }).accepted} cells imported`)

  // ── 2. Slice + upload + attach audio per verse, one chapter at a time ─────
  let attached = 0
  let missing = 0
  for (let chapter = 1; chapter <= LIMIT_CHAPTERS; chapter++) {
    const nn = String(chapter).padStart(2, "0")
    const mp3Path = join(BASE_DIR, "audio", `JHN_0${nn}.mp3`)
    const timingPath = join(BASE_DIR, "timings", `C01-01-JHN-${nn}-timing.txt`)
    const windows = groupSegmentsByVerse(parseLabelTrack(readFileSync(timingPath, "utf8")))

    const events: AttachEvent[] = []
    for (const w of windows) {
      const ref = `${BOOK} ${chapter}:${w.verseId}`
      const cellId = cellIdByRef.get(ref)
      if (!cellId) {
        console.warn(`  ⚠ no cell for ${ref} — skipping audio`)
        missing++
        continue
      }
      const bytes = sliceMp3(mp3Path, w.startMs, w.endMs)
      const audioId = buildAudioId(cellId)
      const putRes = await fetch(`${SYNC}/audio/${PROJECT_ID}/${fileId}/${audioId}.mp3`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "audio/mpeg" },
        body: bytes,
      })
      if (!putRes.ok) throw new Error(`audio PUT ${ref} HTTP ${putRes.status}: ${await putRes.text()}`)
      events.push({
        id: randomUUID(),
        schemaVersion: 1,
        kind: "cell.audio.attach",
        projectId: PROJECT_ID,
        fileId,
        cellId,
        parentId: null,
        author: "dev",
        payload: {
          audioId,
          url: `frontier-audio://${audioId}.mp3`,
          slot: "recording",
          mimeType: "audio/mpeg",
          durationMs: w.endMs - w.startMs,
        },
        clientTs: Date.now(),
      })
    }

    // POST attach events in chunks of 200 (server commit-chunk size).
    for (let i = 0; i < events.length; i += 200) {
      const chunk = events.slice(i, i + 200)
      const res = await postJson("/events", token, { events: chunk })
      if (!res.ok) throw new Error(`/events ch${chapter} HTTP ${res.status}: ${await res.text()}`)
      const { rejected } = (await res.json()) as { accepted: unknown[]; rejected: unknown[] }
      if (rejected.length) console.warn(`  ⚠ ch${chapter}: ${rejected.length} events rejected`)
    }
    attached += events.length
    console.log(`  chapter ${chapter}: ${events.length} verse clips attached`)
  }

  // ── 3. Verify: read attachments back ─────────────────────────────────────
  const verifyRes = await fetch(
    `${SYNC}/api/v1/projects/${PROJECT_ID}/files/${fileId}/audio-attachments`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const verifyNote = verifyRes.ok
    ? `${((await verifyRes.json()) as { attachments?: unknown[] }).attachments?.length ?? "?"} attachments on server`
    : `read-back HTTP ${verifyRes.status}`

  console.log(`\nDONE`)
  console.log(`  file id:      ${fileId}`)
  console.log(`  verse cells:  ${cells.length}`)
  console.log(`  audio attached: ${attached}${missing ? ` (${missing} missing cells)` : ""}`)
  console.log(`  verify:       ${verifyNote}`)
  console.log(`  open:         ${AUTH.replace(":8788", ":5173")}/__dev/login then project ${PROJECT_ID}, file ${fileId}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
