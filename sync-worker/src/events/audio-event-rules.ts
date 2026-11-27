/**
 * AQU-2682 / AQU-2685: the audio rules a `cell.audio.*` event is held to, in
 * one place. `authorize()` applies them to every audio event on the events
 * route, and POST /import's finish applies them to each media attachment it
 * writes, so an attachment cannot do through Import what the same attach is
 * refused on the events route (whatever role it names).
 *
 *  - A `role: 'source'` attach needs Project Lead.
 *  - Below Maintainer, a re-attach of an existing source clip may only add
 *    words or choose it: the same url, slot and trims.
 *  - A take is never named as a `.peaks` sidecar.
 *  - The caller's file limits, then language limits: a source attach needs
 *    every language; any other event is checked in each language it acts in.
 */

import type { SyncTokenClaims } from '../auth'
import type { EventKind, RawEvent } from './types'
import { ROLE } from './role-policy'
import { laneOfAudioEvent } from './event-projection'
import { audioLaneLimited, coversEveryLanguage } from './source-audio-access'
import type { LaneIdentity } from '../../../src/lib/lanes/read-wall'
import { fileScopeRefusal, laneRefusal, namesSidecar } from '../audio-write-guard'

/** The audio event kinds held to file and language limits. */
export const AUDIO_SCOPE_KINDS = new Set<string>([
  'cell.audio.attach',
  'cell.audio.select',
  'cell.audio.remove',
  'cell.audio.rename',
  'cell.audio.trim',
  'cell.audio.gain',
  'cell.audio.place',
  'cell.audio.cut',
  'cell.audio.uncut',
  'cell.audio.measure',
  'cell.audio.validate',
  'cell.audio.unvalidate',
])

/** A stored take, as these rules read it. */
export interface StoredTake {
  url: string | null
  slot: string
  trim_start_ms: number | null
  trim_end_ms: number | null
  role: string
  /** Its language's tag ('' when it has none). */
  tag: string
}

/** One stored take's row for (cell, audio id), or null. */
export type StoredTakeLookup = (cellId: string, audioId: string) => Promise<StoredTake | null>

export const STORED_TAKE_COLUMNS = `a.url, a.slot, a.trim_start_ms, a.trim_end_ms, a.role,
  COALESCE(l.legacy_tag, '') AS tag`

/** The default lookup: one indexed read per take. */
export function storedTakeQuery(db: AquillaDb, projectId: string, fileId: string): StoredTakeLookup {
  return (cellId, audioId) =>
    db
      .prepare(
        `SELECT ${STORED_TAKE_COLUMNS} FROM cell_audio a
           LEFT JOIN lanes l ON l.id = a.lane_id
          WHERE a.project_id = ? AND a.file_id = ? AND a.cell_id = ? AND a.audio_id = ?`,
      )
      .bind(projectId, fileId, cellId, audioId)
      .first<StoredTake>()
      .then((row) => row ?? null)
}

type Claims = Pick<SyncTokenClaims, 'role' | 'username' | 'scopes' | 'laneGrants'> & { src?: string }

export async function audioEventRefusal(input: {
  db: AquillaDb | undefined
  claims: Claims
  raw: RawEvent<EventKind>
  wallOn: boolean
  laneReadWall: string | undefined
  /** The event's role floor (the lane checks sum grants against it). */
  requiredRole: number
  loadLanes: () => Promise<LaneIdentity[]>
  /** Defaults to one read per take; Import passes rows it loaded at once. */
  storedTake?: StoredTakeLookup
  /** Defaults to `fileScopeRefusal`; Import passes the one answer for its file. */
  fileRefusal?: () => Promise<string | null>
}): Promise<{ status: 403 | 422; reason: string } | null> {
  const { db, claims, raw, wallOn, laneReadWall, requiredRole, loadLanes } = input
  const ap = raw.payload as {
    audioId?: unknown; url?: unknown; slot?: unknown; trimStartMs?: unknown; trimEndMs?: unknown
    role?: unknown; pieceOf?: unknown; wordsOnly?: unknown
  } | null
  const isAttach = raw.kind === 'cell.audio.attach'
  const audioId = typeof ap?.audioId === 'string' && ap.audioId ? ap.audioId : null

  // AQU-1565 follow-up: marking a clip as the file's SOURCE audio needs
  // PROJECT_LEAD. `cell.audio.attach` sits at CONTRIBUTOR for takes, but a
  // `role: 'source'` clip is the shared programme recording every media row
  // plays: it is never counted as recorded and never waits on validation. A
  // contributor able to stamp that on their own take would take it out of
  // review. Reads nothing but the payload.
  if (isAttach && ap?.role === 'source' && claims.role < ROLE.PROJECT_LEAD) {
    return { status: 403, reason: 'marking a clip as source audio requires project lead' }
  }

  // The stored take this event names, read at most once.
  let takePromise: Promise<StoredTake | null> | undefined
  const lookup = db != null && raw.fileId
    ? input.storedTake ?? storedTakeQuery(db, raw.projectId, raw.fileId)
    : null
  const storedTake = () => {
    if (!lookup || !audioId || !raw.cellId) return Promise.resolve(null)
    takePromise ??= lookup(raw.cellId, audioId)
    return takePromise
  }

  // AQU-2682: the shared source clip is what every language hears. Below
  // Maintainer, a re-attach of it may only add words or choose it: the same
  // url, the same slot, and no new trim window (an attach's trims overwrite
  // the stored ones; echoing them unchanged is fine). Transcription and
  // transcript save send the stored url and slot back, so they still land.
  // Whatever role the attach names: the row is matched on (cell, audio id),
  // and a 'dub' re-attach keeps it the source clip. The choice itself is held
  // to the language rules below.
  if (isAttach && claims.role < ROLE.MAINTAINER) {
    const existing = await storedTake()
    if (existing && existing.role === 'source') {
      const movesTrim = (sent: unknown, stored: number | null) =>
        sent != null && Number(sent) !== (stored == null ? null : Number(stored))
      if (
        existing.url !== (typeof ap?.url === 'string' ? ap.url : null) ||
        existing.slot !== ap?.slot ||
        movesTrim(ap?.trimStartMs, existing.trim_start_ms) ||
        movesTrim(ap?.trimEndMs, existing.trim_end_ms)
      ) {
        return { status: 403, reason: 'changing the source audio requires maintainer; others may only add words to it or choose it' }
      }
    }
  }

  // AQU-2682: a take is never named as a `.peaks` sidecar. The audio route
  // lets a sidecar be rewritten (it is drawn, never heard), so a take named
  // like one would escape the write-once rule for recordings.
  if (isAttach && namesSidecar(audioId, typeof ap?.url === 'string' ? ap.url : null)) {
    return { status: 422, reason: 'a take cannot be named as a waveform sidecar (.peaks)' }
  }

  // AQU-2685: audio events are held to the same file and language limits as
  // text. The file: the caller's file scopes, a cue file counting as part of
  // the file it belongs to (so a scoped performer still records heard
  // lines). The language: an existing take's own (many re-attaches and trims
  // name none, AQU-1978), else the one the event names; the shared source
  // clip has none. Same lane rules as text: the wall's grants when it is on
  // (Maintainer+ and platform pass), else the token's lane scopes.
  if (db == null || !AUDIO_SCOPE_KINDS.has(raw.kind) || !raw.fileId) return null
  const fileRefused = input.fileRefusal
    ? await input.fileRefusal()
    : await fileScopeRefusal(db, claims, raw.projectId, raw.fileId)
  if (fileRefused) return { status: 403, reason: fileRefused }
  // Only look anything up when a language limit can apply at all: below
  // Maintainer under the wall, or a token with language scopes.
  if (!audioLaneLimited(wallOn, claims)) return null
  // Source audio acts in every language at once, so declaring it needs
  // access to every language (source-audio-access.ts; the app asks the
  // same question through GET .../source-audio-access before it offers
  // "Upload a recording" or attaching media).
  const coveredSource = isAttach && ap?.role === 'source'
  if (coveredSource) {
    const covers = await coversEveryLanguage({ wallOn, claims, requiredRole, loadLanes })
    if (!covers) {
      return { status: 403, reason: 'marking a clip as source audio requires access to every language' }
    }
  }
  const take = await storedTake()
  const eventLane = laneOfAudioEvent(raw.payload)
  // Every language the event acts in:
  //   - an existing take: its own language. The shared source clip has
  //     none of its own; choosing it (a select, or an attach that is not
  //     words-only) un-chooses the dubs of the language the event names,
  //     so a choice of it is checked there, and other edits of it are no
  //     language's.
  //   - a NEW take or piece: the language its attach names, always (being
  //     chosen there un-chooses that language's take), and, for a piece,
  //     the language of the take it is a piece of too (the projection
  //     gives it its root's lane). A piece of the source clip adds none.
  //   - a source attach (role 'source') passed the every-language check
  //     above, which covers any language its tag can name, so its tag is
  //     not checked again. It names none in practice (the app sends no
  //     targetLang), and '' resolves to no lane in a project whose
  //     languages all carry their own tag, which refused every Project
  //     Lead the check had just let through.
  const lanes = new Set<string>()
  if (take) {
    if (take.role !== 'source') lanes.add(take.tag)
    else if (raw.kind === 'cell.audio.select' || (isAttach && ap?.wordsOnly !== true && !coveredSource)) lanes.add(eventLane)
  } else {
    if (!coveredSource) lanes.add(eventLane)
    if (isAttach && typeof ap?.pieceOf === 'string' && ap.pieceOf && raw.cellId && lookup) {
      const root = await lookup(raw.cellId, ap.pieceOf)
      if (root && root.role !== 'source') lanes.add(root.tag)
    }
  }
  for (const laneTag of lanes) {
    const laneRefused = await laneRefusal(db, claims, raw.projectId, laneTag, laneReadWall, requiredRole, loadLanes)
    if (laneRefused) return { status: 403, reason: laneRefused }
  }
  return null
}
