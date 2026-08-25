/**
 * Content seeding for the localization capture run (AQU-511).
 *
 * `auth-worker`'s `/__dev__/seed` creates the dev user, org and `dev-project`
 * but — by its own source comment — seeds NO files and NO cells. So every
 * surface that needs translation content on screen (the editing table, the
 * cell editor, the search dock, the assign modal's file picker) used to land on
 * `CellAreaPlaceholder`'s no-file-selected branch, which deliberately renders
 * neither cells nor the "Import a file" CTA the old drivers waited on.
 *
 * Rather than drive the real import dialog (slow, and the CTA it starts from
 * isn't reachable from that state), this seeds the same server state the UI
 * import produces over HTTP — one `file.create` plus N `source.cell.create`
 * events, with a few `target.cell.commit`s so the target column isn't empty.
 * Same approach as `e2e/helpers/seed-project.ts`, but pointed at the dev stack
 * (identity :8788, sync :8789) and at the existing `dev-project` rather than a
 * fresh one, so `DEV_PROJECT` deep links keep working.
 *
 * Every id is DETERMINISTIC, which makes the seed idempotent: the events insert
 * is `INSERT OR IGNORE` and the cells projection is an upsert, so re-running a
 * capture reuses the same file instead of piling up duplicates in the shared
 * local Postgres.
 *
 * The first three verses also get a short generated WAV take (`cell.audio.attach`
 * + R2 PUT) so the editor-table play button is present on a fresh local DB.
 * Ids are deterministic and the PUT is overwritten in place, so a wiped
 * Wrangler R2 cache rehydrates without duplicating `cell_audio` rows. A cell
 * that already has a *different* recording (the user recorded over the seed)
 * is left alone.
 */

import { DEV_PROJECT } from "./shared"

function identityBase(): string {
  return process.env.I18N_SHOTS_IDENTITY_BASE || "http://127.0.0.1:8788"
}

function syncBase(): string {
  return process.env.I18N_SHOTS_SYNC_BASE || "http://127.0.0.1:8789"
}

/** Stable file the capture drivers deep-link into. */
export const SHOTS_FILE_ID = "019f9000-0000-7000-8000-000000000001"
export const SHOTS_FILE_NAME = "Genesis 1 (i18n sample).md"

/** First source cell's text — drivers settle on it, so keep it distinctive. */
export const FIRST_SOURCE_TEXT = "In the beginning God created the heavens and the earth."

/** First target cell's text. Clicking it is how a driver enters edit mode. */
export const FIRST_TARGET_TEXT = "En el principio creó Dios los cielos y la tierra."

interface SeedLine {
  ref: string
  source: string
  /** Present → also seeded as a target commit, so the target column has text. */
  target?: string
}

/**
 * Deliberately mundane public-domain source text with a couple of Spanish
 * targets: enough rows to fill the 900px-tall viewport, short enough that the
 * shot stays readable, and bilingual enough to show both columns of the table.
 */
const LINES: readonly SeedLine[] = [
  {
    ref: "GEN 1:1",
    source: FIRST_SOURCE_TEXT,
    target: FIRST_TARGET_TEXT,
  },
  {
    ref: "GEN 1:2",
    source:
      "Now the earth was formless and empty, darkness was over the surface of the deep, " +
      "and the Spirit of God was hovering over the waters.",
    target:
      "Y la tierra estaba desordenada y vacía, y las tinieblas estaban sobre la faz del abismo.",
  },
  {
    ref: "GEN 1:3",
    source: "And God said, Let there be light: and there was light.",
    target: "Y dijo Dios: Sea la luz; y fue la luz.",
  },
  { ref: "GEN 1:4", source: "And God saw the light, that it was good: and God divided the light from the darkness." },
  { ref: "GEN 1:5", source: "And God called the light Day, and the darkness he called Night." },
  { ref: "GEN 1:6", source: "And God said, Let there be a firmament in the midst of the waters." },
  { ref: "GEN 1:7", source: "And God made the firmament, and divided the waters which were under the firmament." },
  { ref: "GEN 1:8", source: "And God called the firmament Heaven. And the evening and the morning were the second day." },
  { ref: "GEN 1:9", source: "And God said, Let the waters be gathered together unto one place, and let the dry land appear." },
  { ref: "GEN 1:10", source: "And God called the dry land Earth; and the gathering together of the waters called he Seas." },
  { ref: "GEN 1:11", source: "And God said, Let the earth bring forth grass, the herb yielding seed after his kind." },
  { ref: "GEN 1:12", source: "And the earth brought forth grass, and herb yielding seed after his kind." },
  { ref: "GEN 1:13", source: "And the evening and the morning were the third day." },
  { ref: "GEN 1:14", source: "And God said, Let there be lights in the firmament of the heaven to divide the day from the night." },
  { ref: "GEN 1:15", source: "And let them be for lights in the firmament of the heaven to give light upon the earth." },
]

/** Deterministic well-formed UUIDv7-shaped id, distinct per (kind, index). */
function seededId(kind: 0 | 1 | 2 | 3, index: number): string {
  return `019f900${kind}-0000-7000-8000-${index.toString(16).padStart(12, "0")}`
}

/** How many leading verses receive a playable recording take. */
export const SEEDED_AUDIO_LINE_COUNT = 3

/** Playback length of each seeded take (ms). */
export const SEEDED_AUDIO_DURATION_MS = 800

const SEEDED_AUDIO_SAMPLE_RATE = 16_000
const SEEDED_AUDIO_FREQUENCIES_HZ = [440, 554, 659] as const

/**
 * Take id for a seeded recording. Mirrors `buildAudioId` so
 * `audioIdSeededWith(id, cellId)` recognises these as per-cell takes (not a
 * shared source clip).
 */
export function seededAudioId(cellId: string): string {
  const normalised = cellId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)
  return `audio-${normalised}-1700000000000-seedtake`
}

/** Mono 16-bit PCM WAV of a sine tone. No encoder dependency — seed-only. */
export function toneWavBytes(
  freqHz: number,
  durationMs: number = SEEDED_AUDIO_DURATION_MS,
  sampleRate: number = SEEDED_AUDIO_SAMPLE_RATE,
): Uint8Array<ArrayBuffer> {
  const n = Math.max(1, Math.round((sampleRate * durationMs) / 1000))
  const dataBytes = n * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, "RIFF")
  view.setUint32(4, 36 + dataBytes, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, "data")
  view.setUint32(40, dataBytes, true)
  const twoPiF = (2 * Math.PI * freqHz) / sampleRate
  for (let i = 0; i < n; i++) {
    const sample = Math.sin(twoPiF * i) * 0.35
    view.setInt16(44 + i * 2, Math.round(sample * 0x7fff), true)
  }
  return new Uint8Array(buffer)
}

interface FileSummary {
  fileId: string
  cellCount: number
  /** Target-side cells carrying text — the reuse check needs it, see below. */
  filledCount: number
  deletedAt: number | null
}

export interface DevSession {
  jwt: string
  orgId: number
}

/** Seed + sign in as the dev user, returning the JWT and the real org id. */
export async function devSession(): Promise<DevSession> {
  const res = await fetch(`${identityBase()}/__dev__/login`, { method: "POST" })
  if (!res.ok) {
    throw new Error(
      `dev login failed: HTTP ${res.status} — ${await res.text()}. ` +
        "Is the dev stack running with WRANGLER_LOCAL=1 (pnpm dev)?",
    )
  }
  const body = (await res.json()) as { access_token: string; org: { id: number } }
  return { jwt: body.access_token, orgId: body.org.id }
}

async function syncToken(jwt: string, fileId: string): Promise<string> {
  const res = await fetch(`${identityBase()}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ projectId: DEV_PROJECT, fileId }),
  })
  if (!res.ok) throw new Error(`sync-token failed: HTTP ${res.status} — ${await res.text()}`)
  return ((await res.json()) as { token: string }).token
}

async function listFiles(token: string): Promise<FileSummary[]> {
  const res = await fetch(`${syncBase()}/api/v1/projects/${DEV_PROJECT}/files`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`files read failed: HTTP ${res.status} — ${await res.text()}`)
  return ((await res.json()) as { files: FileSummary[] }).files
}

async function postImport(token: string, body: unknown, operation: string): Promise<void> {
  const res = await fetch(`${syncBase()}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${operation} failed: HTTP ${res.status} — ${await res.text()}`)
}

export interface SeededShotsFile {
  fileId: string
  fileName: string
  /** Cell refs in document order — index-aligned with editor rows. */
  cellIds: string[]
}

/**
 * Ensure `dev-project` holds the capture sample file, and return its ids.
 * Idempotent: a file already carrying cells is reused; audio takes are
 * attached (or re-PUT) afterwards.
 */
export async function seedShotsFile(jwt: string): Promise<SeededShotsFile> {
  const token = await syncToken(jwt, SHOTS_FILE_ID)
  const cellIds = LINES.map((line) => line.ref)

  // Reuse only a file that is complete on BOTH sides. Checking cellCount alone
  // would call a source-only file "already seeded" and leave every target row
  // blank in the shot — which is exactly what a half-applied earlier seed
  // leaves behind.
  const wantTargets = LINES.filter((line) => line.target).length
  const existing = (await listFiles(token)).find((f) => f.fileId === SHOTS_FILE_ID)
  const reusable =
    existing &&
    !existing.deletedAt &&
    existing.cellCount >= LINES.length &&
    existing.filledCount >= wantTargets

  if (!reusable) {
    let anchor: string | null = null
    const cells = LINES.map((line, i) => {
      const cell = {
        id: seededId(1, i),
        cellId: line.ref,
        anchorCellId: anchor,
        value: line.source,
        type: "text",
        canonicalRef: line.ref,
        sequenceIndex: i,
      }
      anchor = line.ref
      return cell
    })
    const targets = LINES.flatMap((line, i) =>
      line.target
        ? [
            {
              id: seededId(2, i),
              cellId: line.ref,
              parentId: seededId(1, i),
              value: line.target,
              // No `targetLang`: the editor renders one lane at a time and the
              // dev project has no configured lanes, so its active lane is the
              // default `''`. A target tagged "Spanish" lands in a lane the UI
              // never displays — the rows read as untranslated (see laneOf() in
              // src/hooks/useCells.ts).
            },
          ]
        : [],
    )

    await postImport(
      token,
      {
        projectId: DEV_PROJECT,
        fileId: SHOTS_FILE_ID,
        file: {
          id: seededId(0, 0),
          name: SHOTS_FILE_NAME,
          fileType: "md",
          role: "source",
          kind: "md",
          importFormat: "md",
          parserVersion: "i18n-shots-seed-v1",
          sourceLanguage: "English",
          targetLanguage: "Spanish",
          orderedBy: "sequence",
        },
        cells,
        targets,
        clientTs: Date.now(),
      },
      "i18n-shots bulk import",
    )
    await postImport(
      token,
      { projectId: DEV_PROJECT, fileId: SHOTS_FILE_ID, cells: [], complete: true },
      "i18n-shots import finalize",
    )
  }

  await seedShotsAudio(token, cellIds)
  return { fileId: SHOTS_FILE_ID, fileName: SHOTS_FILE_NAME, cellIds }
}

interface CellAudioEntry {
  selectedAudioId: string | null
}

async function readAudioAttachments(
  token: string,
): Promise<Record<string, CellAudioEntry>> {
  const res = await fetch(
    `${syncBase()}/api/v1/projects/${DEV_PROJECT}/files/${SHOTS_FILE_ID}/audio-attachments`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) {
    throw new Error(`audio-attachments read failed: HTTP ${res.status} — ${await res.text()}`)
  }
  const body = (await res.json()) as { cells?: Record<string, CellAudioEntry> }
  return body.cells ?? {}
}

/**
 * PUT a short WAV onto the first N verses and attach it as the selected
 * recording take. Skips a cell whose selected recording is already a
 * different (user-made) take.
 */
async function seedShotsAudio(token: string, cellIds: string[]): Promise<void> {
  const existing = await readAudioAttachments(token)
  const events: unknown[] = []

  for (let i = 0; i < SEEDED_AUDIO_LINE_COUNT; i++) {
    const cellId = cellIds[i]
    if (!cellId) break
    const audioId = seededAudioId(cellId)
    const selected = existing[cellId]?.selectedAudioId
    if (selected && selected !== audioId) continue

    const bytes = toneWavBytes(SEEDED_AUDIO_FREQUENCIES_HZ[i] ?? 440)
    const put = await fetch(
      `${syncBase()}/audio/${encodeURIComponent(DEV_PROJECT)}/${encodeURIComponent(SHOTS_FILE_ID)}/${encodeURIComponent(`${audioId}.wav`)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "audio/wav",
        },
        body: bytes,
      },
    )
    if (!put.ok) {
      throw new Error(`audio PUT ${cellId} failed: HTTP ${put.status} — ${await put.text()}`)
    }

    if (selected === audioId) continue
    events.push({
      id: seededId(3, i),
      schemaVersion: 1,
      kind: "cell.audio.attach",
      projectId: DEV_PROJECT,
      fileId: SHOTS_FILE_ID,
      cellId,
      parentId: null,
      author: "dev",
      payload: {
        audioId,
        url: `frontier-audio://${audioId}.wav`,
        slot: "recording",
        mimeType: "audio/wav",
        durationMs: SEEDED_AUDIO_DURATION_MS,
        label: "Take 1",
      },
      clientTs: Date.now(),
    })
  }

  if (events.length === 0) return
  const res = await fetch(`${syncBase()}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ events }),
  })
  if (!res.ok) throw new Error(`audio attach events failed: HTTP ${res.status} — ${await res.text()}`)
  const { rejected } = (await res.json()) as { rejected: unknown[] }
  if (rejected.length) {
    throw new Error(`audio attach events rejected: ${JSON.stringify(rejected)}`)
  }
}

/** Login as `dev` and ensure the sample file + audio takes exist. */
export async function seedDevWorkspaceContent(): Promise<SeededShotsFile> {
  const session = await devSession()
  return seedShotsFile(session.jwt)
}
