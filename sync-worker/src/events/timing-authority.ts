// AQU-646: the project-wide timing lock.
//
// Sam, 2026-08-20, on importing a subtitle VTT into an empty project: "I can
// technically go into the timeline and the chips have handlebars and I can
// totally mess up the timings… It needs to be a very active decision to go
// mess around with subtitle VTT timings."
//
// The imported timings are the client's own work and the one thing in a project
// nobody here should be adjusting by accident: a stray drag moves a line for
// everybody, and there is no second copy to compare against. So `cell.retime`
// and `cell.lane.retime` keep their static CONTRIBUTOR floor
// (role-policy.ts) only while the project is UNLOCKED; while it is locked the
// floor rises to MAINTAINER.
//
// A RAISED FLOOR RATHER THAN A FLAT REFUSAL, for one concrete reason. Sam:
// "importing and the timing changes that come with importing and re-importing
// should not be blocked if the project timing is locked." Re-importing an audio
// VTT retimes every cue through ordinary `cell.retime` events that are
// byte-identical to a drag — there is nothing in the payload to tell them
// apart, and any marker we invented could be forged by the same client we are
// guarding against. But re-import is itself maintainer-gated, so "locked means
// maintainer" separates the two exactly, with no new event kind and nothing to
// trust. The CEREMONY Sam wants lives in the UI, which hides the handles from a
// maintainer too until they unlock; this is the backstop, not the interaction.
//
// Mirrors assignment-authority.ts in shape and in fail-safe discipline — with
// the sign flipped. That one defaults to `false` (no carve-out) so a missing
// setting preserves the old behaviour; this one defaults to LOCKED, because a
// safeguard against accidents that has to be switched on protects nothing until
// somebody remembers to switch it on.

/**
 * Is this project's timeline locked?
 *
 * Returns `true` (locked — the safe answer) when the project has no settings
 * row, the blob will not parse, or `timingLocked` is anything other than
 * exactly `false`. Keep in lock-step with `resolveTimingLocked` in
 * src/lib/sync/project-settings.ts, which the client reads from the same blob.
 */
export async function resolveTimingLocked(
  db: AquillaDb,
  projectId: string,
): Promise<boolean> {
  // THE QUERY IS INSIDE THE TRY, not just the parse. This runs on the event
  // perimeter: an exception here does not degrade to a 403, it escapes
  // `authorize` and 500s the whole batch — and a 500 on the event route can
  // wedge the durable outbox with a poisoned event, which is the exact failure
  // the role mirror exists to prevent. An unreachable settings row must read as
  // LOCKED (nothing moves) rather than as an outage.
  try {
    const row = await db
      .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ settings: string | null }>()

    if (!row?.settings) return true

    const parsed = JSON.parse(row.settings) as { timingLocked?: unknown }
    return parsed?.timingLocked !== false
  } catch {
    return true
  }
}

/**
 * Did a person add this line here, rather than it arriving in the client's
 * file? Sam's exemption: a line someone added carries no imported timing to
 * corrupt, so the lock leaves it draggable.
 *
 * The marker is `metadata.aquillaOrigin.kind === 'user-insert'`, written on the
 * create event — the SAME single signal the client's `isUserAddedLine` uses
 * (src/lib/timeline/user-lines.ts), and for the reason documented there:
 * inferring "a person must have made it" from a missing import envelope would
 * be wrong about every file imported before the normalized manifest.
 *
 * Returns `false` (no exemption — the safe answer) for a cell that cannot be
 * found or whose metadata will not parse.
 */
export async function isUserInsertedCell(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellId: string,
): Promise<boolean> {
  // Same discipline as above: the read is inside the try. A failure here must
  // withhold the exemption rather than escape into a 500.
  try {
    const row = await db
      .prepare(
        `SELECT metadata FROM cells
         WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
      )
      .bind(projectId, fileId, cellId)
      .first<{ metadata: unknown }>()

    if (!row?.metadata) return false

    // jsonb comes back parsed on one driver and as text on another; both shapes
    // reach here, so normalize rather than assuming either.
    const meta = (typeof row.metadata === 'string'
      ? JSON.parse(row.metadata)
      : row.metadata) as { aquillaOrigin?: { kind?: unknown } } | null
    return meta?.aquillaOrigin?.kind === 'user-insert'
  } catch {
    return false
  }
}

/**
 * Does this event move one of the timings the lock protects?
 *
 * `cell.retime` always does — it moves a line's own span.
 *
 * `cell.lane.retime` CARRIES TWO UNRELATED THINGS through one kind, and only
 * one of them is the client's work:
 *
 *   - `subtitleStartMs` / `subtitleEndMs` — where a subtitle sits. Imported
 *     from her file, and what the lock exists for.
 *   - `targetOffsetMs` / `targetStartMs` — where a dub take sits against the
 *     line it performs. That is the RECORDIST'S OWN work, produced here, and
 *     nudging it is ordinary contributor business. Locking it would stop people
 *     placing their own takes, which is the opposite of protecting her file.
 *
 * So this reads the payload rather than the kind. An event touching a subtitle
 * key is covered even if it also carries a target key; one carrying only target
 * keys is not covered at all.
 *
 * Re-pairing (`cell.link.set`) is deliberately absent — Sam scoped the lock to
 * chip timings, and the pairings keep their own PROJECT_LEAD floor.
 */
export function isLockedTimingEvent(kind: string, payload: unknown): boolean {
  if (kind === 'cell.retime') return true
  if (kind !== 'cell.lane.retime') return false
  const p = payload as { subtitleStartMs?: unknown; subtitleEndMs?: unknown } | null | undefined
  return p?.subtitleStartMs !== undefined || p?.subtitleEndMs !== undefined
}
