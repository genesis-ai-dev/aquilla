// AQU-1845 — the Autopilot wave's per-model-call checkpoint.
//
// Why this exists: `runOneTick` advances the run cursor past a wave in ONE
// guarded write, so a driver killed mid-wave replays that whole wave. Every
// model call the dead attempt had already finished gets re-issued and re-paid
// for, and its first output is thrown away. This table is the handover between
// the two attempts: the output of each call is written the moment it returns,
// and the replay reads it back instead of dialing the provider.
//
// Lives in db/shared/ (beside contextual-runs.ts) so the driver and any future
// executor share the same parameterized SQL. Rows are ephemeral coordination
// state — the driver clears a run's rows after every COMPLETED wave, because
// the cursor has moved and those spans will never replay; a span that was
// re-enqueued (blocked) therefore starts cold on its next attempt, which is
// deliberate: "blocked" means the world moved under it, and reusing the old
// reply would stage a draft against stale input.

import type { AquillaDb } from "../shim/postgres"

/** Rows older than this are abandoned checkpoints — their driver died and
 *  nothing ever replayed the wave. Swept by the retention cron, same contract
 *  as contextual_run_traces. Deliberately short: a checkpoint is only useful
 *  to the replay that follows within the sweeper's adoption window. */
export const CONTEXTUAL_RUN_STEP_TTL_HOURS = 24

/** Longest reply this cache will store, in characters. A reply past it is
 *  simply not checkpointed (the replay re-issues that one call) rather than
 *  bloating the table — drafts are span-sized, so this is a ceiling, not a
 *  budget, and counting characters rather than encoded bytes is close enough
 *  for that job. */
export const CONTEXTUAL_RUN_STEP_MAX_OUTPUT_CHARS = 256 * 1024

/** The stable identity of one model call inside a run. Everything that can
 *  change the reply is in here; see `contextualStepKey`. */
export interface ContextualStepIdentity {
  /** SpanSeed.id the call belongs to; "" outside a span. */
  spanId: string
  /** Pipeline node that issued it (construe / summarize / draft / verify). */
  label: string
  tier: string
  /** Model actually requested, when the caller knows it. The decorator in
   *  auth-worker does not — makeLlmCall resolves the model from the tier
   *  inside itself — so `tier` carries the discriminator there. A model
   *  swapped by a redeploy between two attempts of the same wave therefore
   *  reads back the old model's reply, which is a valid reply to the same
   *  prompt and strictly cheaper than re-issuing it. */
  model?: string
  /** Hash of the prompt pair + sampling parameters. */
  promptHash: string
  /** Which occurrence of this otherwise-identical call it is within the
   *  attempt, counted from 0. A node that legitimately issues the same prompt
   *  twice (a redraft loop that did not change its input) must get two
   *  separate checkpoints, or the second call would read back the first
   *  reply. */
  occurrence: number
}

export function contextualStepKey(id: ContextualStepIdentity): string {
  // `|` is safe as a separator: spanId and label are internal identifiers and
  // the hash is hex, so none of the fields can contain one.
  return [id.spanId, id.label, id.tier, id.model ?? "", id.promptHash, String(id.occurrence)].join("|")
}

/** FNV-1a over the prompt pair. Not a security hash — it only has to make a
 *  changed prompt miss the cache, and it has to be cheap on the hot path and
 *  available in a Worker without WebCrypto's async ceremony. */
export function contextualPromptHash(parts: {
  system: string
  user: string
  maxTokens: number
  temperature: number
}): string {
  const text = `${parts.maxTokens}\u0000${parts.temperature}\u0000${parts.system}\u0000${parts.user}`
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  // Fold the length in as well: FNV-1a on 32 bits collides often enough that a
  // prompt edit of the same length is worth a second discriminator.
  return `${hash.toString(16).padStart(8, "0")}${text.length.toString(16)}`
}

/** The checkpointed reply for this call, or null if there is none. */
export async function readContextualRunStep(
  db: AquillaDb,
  runId: string,
  stepKey: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT output FROM contextual_run_steps WHERE run_id = ? AND step_key = ?")
    .bind(runId, stepKey)
    .first<{ output: string }>()
  return row?.output ?? null
}

/** Checkpoint one reply. Idempotent: a racing writer for the same key wins and
 *  this is a no-op, because either reply is equally valid.
 *
 *  `projectId` is written for the table's RLS policy (0158), which scopes it
 *  exactly as its sibling contextual tables are scoped; nothing reads it. */
export async function writeContextualRunStep(
  db: AquillaDb,
  runId: string,
  projectId: string,
  stepKey: string,
  output: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO contextual_run_steps (run_id, project_id, step_key, output)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (run_id, step_key) DO NOTHING`,
    )
    .bind(runId, projectId, stepKey, output)
    .run()
}

/** Drop a run's checkpoints. Called after every wave that completed (the
 *  cursor has moved past it) and when the run settles. */
export async function clearContextualRunSteps(db: AquillaDb, runId: string): Promise<void> {
  await db.prepare("DELETE FROM contextual_run_steps WHERE run_id = ?").bind(runId).run()
}

/** Retention sweep for checkpoints whose driver never returned. */
export async function sweepContextualRunSteps(
  db: AquillaDb,
  ttlHours: number = CONTEXTUAL_RUN_STEP_TTL_HOURS,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM contextual_run_steps
        WHERE created_at < now() - make_interval(hours => ?)`,
    )
    .bind(ttlHours)
    .run()
}
