// AQU-646 stage 2: the SECOND gate on restructuring a timeline.
//
// `allowTrackEditing` (project settings; the write route is maintainer-gated)
// decides whether a project's timelines may be restructured at all — tracks
// added and deleted, grouped into folders, recoloured. It is the sibling of
// line-creation-authority.ts and timing-authority.ts, and it fails safe to OFF
// for the same reason the first one does: the affordance is the liability the
// setting exists to contain.
//
// BUT IT IS A DIFFERENT SHAPE FROM BOTH, AND THE DIFFERENCE IS THE POINT.
// `allowLineCreation` is a conditional floor RAISE: `source.cell.create` was
// lowered to CONTRIBUTOR in the static table, and authorize puts PROJECT_LEAD
// back when the setting is off. There is no such move available here.
// `file.track.set` is ALREADY floored at MAINTAINER (role-policy.ts), so there
// is no lower floor to raise from — this setting answers *whether*, not *who*.
// The consequence, stated plainly because it looks like a bug otherwise: with
// the setting off, a gated write is refused to an OWNER. Two gates means two
// gates. Do not add a `role < X` term to the check in authorize.ts to make it
// resemble its neighbours; both of them carry one and neither reason applies.
//
// AND THE GATING IS PER FIELD, BECAUSE ONE EVENT KIND CARRIES EVERY OPERATION.
// `file.track.set` is how a reorder, a rename, a creation, a deletion, a folder
// move and a recolour are all expressed. Splitting them by payload is the only
// way to keep drag-to-reorder and rename working — which they must, since both
// already ship and a new setting defaulting to off must not take an existing
// capability away from every project that has one.

/**
 * Does this patch REQUIRE the setting, or is it ordinary maintainer work?
 *
 * Exported and pure so the rule can be tested without minting a JWT or faking
 * a database — the seam line-creation-authority.ts never got, and the reason
 * its own test has to stand up a whole fake DB to assert a policy decision.
 *
 * Three clauses, and the first is NOT a special case of the second:
 *
 *   1. `patch === null` is gated, ALWAYS.
 *   2. A patch naming any key outside {name, order} is gated.
 *   3. Everything else is ungated.
 *
 * Clause 1 has to be written out because the tempting one-liner — "ungated iff
 * the keys are a subset of {name, order}" — is wrong in the PERMISSIVE
 * direction: null has no keys, so it is vacuously a subset and a delete would
 * sail straight through the gate that exists to stop it.
 *
 * And null must be gated even on a RESERVED (derived) track id, where it reads
 * innocently as "reset this row to its defaults". The projection implements it
 * as `meta #- ARRAY['trackOverrides', <id>]` — it deletes the whole entry — so
 * resetting the target-audio row also clears its colour, its group and its
 * rename in one write. Three of those four are gated fields.
 *
 * Unknown keys are gated rather than ignored, which is the safe direction: the
 * handler rejects them a moment later anyway (its PATCH_KEYS allow-list), so
 * the only thing this decides is whether an unknown key could ever slip through
 * as "ordinary maintainer work" during a version skew. It cannot.
 */
/**
 * The RESERVED track ids — a derived track's id IS its kind string.
 *
 * THIS USED TO BE AN ALIAS OF TRACK_KINDS AND MUST NEVER BE ONE AGAIN. The two
 * sets were identical while every kind was derived; stage 2 added kinds a USER
 * makes ('folder', 'audio'), which are not derived by anything and therefore
 * reserve no id. Aliasing them now would reserve 'folder' as a track id and
 * make a track that happened to be handed that id permanently unbuildable.
 *
 * Reserved rather than "default" because which of them a given file actually
 * draws depends on the file: a dubbing file has no target-subtitles row, but
 * the id stays spoken for.
 *
 * MOVED HERE from the handler (2026-08-27) so the projection can share it
 * without importing a handler — the handler already imports the projection,
 * and the other direction would close a cycle.
 *
 * HAND-MIRRORED with DEFAULT_TRACK_IDS in src/lib/timeline/tracks.ts.
 */
export const DEFAULT_TRACK_IDS = new Set([
  'source-subtitles',
  'source-audio',
  'target-subtitles',
  'target-audio',
])

/**
 * Must this write find the track already there?
 *
 * A patch carrying `kind` is the only thing that brings a track INTO being, so
 * every other patch is meaningless against an id that does not exist — and
 * worse than meaningless: it merged a kind-less entry into
 * `files.meta.trackOverrides` that `mergeTrackOverrides` then skipped when
 * rendering, leaving something invisible in the UI, untargetable by any
 * control, and unremovable, because removal is `patch: null` and that IS
 * gated. Creation ungated, deletion gated, on a blob read on every file
 * listing.
 *
 * The derived rows are exempt because their FIRST reorder or rename legitimately
 * has no entry yet — and drag-to-reorder is deliberately left working when the
 * setting is off, so requiring an entry there would take away a shipped
 * capability.
 *
 * Broader than the bare `{order}` case that was reported: `{name}` is ungated
 * too and had exactly the same hole, and the gated kind-less keys could write
 * the same junk with the setting on. One rule covers the class.
 */
export function trackPatchRequiresExisting(trackId: string, patch: unknown): boolean {
  if (patch === null || patch === undefined) return false // a delete, gated elsewhere
  if (typeof patch !== 'object' || Array.isArray(patch)) return false
  if ('kind' in (patch as Record<string, unknown>)) return false
  return !DEFAULT_TRACK_IDS.has(trackId)
}

const UNGATED_PATCH_KEYS = new Set(['name', 'order'])

export function isGatedTrackPatch(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return true
  const patch = (payload as { patch?: unknown }).patch
  // Clause 1. Also catches a missing `patch` key: the handler will refuse that
  // as a non-object patch, and until it does, gated is the safe reading.
  if (patch === null || patch === undefined) return true
  if (typeof patch !== 'object' || Array.isArray(patch)) return true
  // Clause 2.
  for (const key of Object.keys(patch)) {
    if (!UNGATED_PATCH_KEYS.has(key)) return true
  }
  // Clause 3. An empty patch lands here as ungated; the handler rejects it as
  // meaningless either way, and refusing it HERE would report the wrong reason.
  return false
}

/**
 * Has this project opted into restructuring its timelines?
 *
 * Returns `false` (the restrictive answer) when the project has no settings
 * row, the blob will not parse, or `allowTrackEditing` is anything other than
 * exactly `true`. Keep in lock-step with the client's read of the same key
 * (`project?.allowTrackEditing ?? false`).
 */
export async function resolveAllowTrackEditing(
  db: AquillaDb,
  projectId: string,
): Promise<boolean> {
  // THE QUERY IS INSIDE THE TRY — same perimeter discipline as its two
  // siblings: an exception here does not degrade to a 403, it escapes
  // `authorize` and 500s the whole batch, which can wedge a durable outbox on
  // one poisoned event. An unreachable settings row reads as OFF.
  try {
    const row = await db
      .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ settings: string | null }>()

    if (!row?.settings) return false

    const parsed = JSON.parse(row.settings) as { allowTrackEditing?: unknown }
    return parsed?.allowTrackEditing === true
  } catch {
    return false
  }
}
