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
 */

import { DEV_PROJECT, IDENTITY_BASE, SYNC_BASE } from "./shared"

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
function seededId(kind: 0 | 1 | 2, index: number): string {
  return `019f900${kind}-0000-7000-8000-${index.toString(16).padStart(12, "0")}`
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
  const res = await fetch(`${IDENTITY_BASE}/__dev__/login`, { method: "POST" })
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
  const res = await fetch(`${IDENTITY_BASE}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ projectId: DEV_PROJECT, fileId }),
  })
  if (!res.ok) throw new Error(`sync-token failed: HTTP ${res.status} — ${await res.text()}`)
  return ((await res.json()) as { token: string }).token
}

async function listFiles(token: string): Promise<FileSummary[]> {
  const res = await fetch(`${SYNC_BASE}/api/v1/projects/${DEV_PROJECT}/files`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`files read failed: HTTP ${res.status} — ${await res.text()}`)
  return ((await res.json()) as { files: FileSummary[] }).files
}

async function postImport(token: string, body: unknown, operation: string): Promise<void> {
  const res = await fetch(`${SYNC_BASE}/import`, {
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
 * Idempotent: a file already carrying cells is reused untouched.
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
  if (
    existing &&
    !existing.deletedAt &&
    existing.cellCount >= LINES.length &&
    existing.filledCount >= wantTargets
  ) {
    return { fileId: SHOTS_FILE_ID, fileName: SHOTS_FILE_NAME, cellIds }
  }

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

  return { fileId: SHOTS_FILE_ID, fileName: SHOTS_FILE_NAME, cellIds }
}
