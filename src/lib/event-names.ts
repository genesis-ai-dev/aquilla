/**
 * AQU-267: Funnel instrumentation — canonical event-name constants.
 *
 * All events flow through posthog.capture() which is already consent-gated
 * at the posthog.ts module level (opt_out_capturing_by_default=true until the
 * user explicitly enables analytics in the Privacy step / Preferences page).
 * These constants are the single source of truth for event names so a typo
 * in one call site cannot silently diverge from the PostHog funnel definition.
 *
 * Naming convention: lowercase, space-separated, matching the existing events
 * in the codebase (e.g. "project created", "ai translation completed").
 */

// ── Onboarding wizard ─────────────────────────────────────────────────────

/** User advanced to a new step in the onboarding wizard (fresh-signup path). */
export const ONBOARDING_STEP_VIEWED = "onboarding step viewed"

/** Returning user was skipped directly to the dashboard (already onboarded). */
export const ONBOARDING_RETURNING_USER_SKIP = "onboarding returning user skip"

// ── Import funnel ─────────────────────────────────────────────────────────

/** User opened the ImportDialog and chose an import type. */
export const IMPORT_STARTED = "import started"

/** Import completed with all files accepted (no skipped books / no collisions). */
export const IMPORT_SUCCEEDED = "import succeeded"

/** Import completed but some books were skipped (partial Paratext import). */
export const IMPORT_PARTIAL = "import partial"

/** Import aborted due to an error (file parse, network, etc.). */
export const IMPORT_FAILED = "import failed"

/** Collision detected — user was shown the collision resolution prompt. */
export const IMPORT_COLLISION_DETECTED = "import collision detected"

/** User chose to skip colliding files in the collision resolution prompt. */
export const IMPORT_COLLISION_SKIPPED = "import collision skipped"

/** User chose to overwrite/duplicate colliding files in the collision resolution prompt. */
export const IMPORT_COLLISION_DUPLICATED = "import collision duplicated"

// ── Editor — first commit + validation ───────────────────────────────────

/**
 * First cell commit in this browser session (once per session, not per keystroke).
 * Emitted at the events-emit seam, not per cell.
 */
export const FIRST_CELL_COMMIT = "first cell commit"

/**
 * User toggled cell validation on for the first time in this browser session.
 * Emitted at the events-emit seam, not per cell.
 */
export const FIRST_CELL_VALIDATE = "first cell validate"

// ── Org creation (high-value team signal) ─────────────────────────────────

/**
 * User created a NON-personal organization. Creating an org (beyond the
 * auto-provisioned personal workspace) signals an incoming multi-person
 * translation project — the cohort we most want to support and measure.
 */
export const ORG_CREATED = "org created"

// ── Sharing / invitations ─────────────────────────────────────────────────

/** User minted a project share/invite link (sharing velocity). */
export const INVITE_SENT = "invite sent"

// ── Activation: setup checklist ───────────────────────────────────────────

/** A project's setup checklist reached 100% (all actionable items done). */
export const SETUP_CHECKLIST_COMPLETED = "setup checklist completed"

// ── Invite redemption ─────────────────────────────────────────────────────

/** User successfully redeemed an invite link and joined a project. */
export const INVITE_REDEEMED = "invite redeemed"

// ── Outbox quarantine ─────────────────────────────────────────────────────

/**
 * An outbox record transitioned to the permanent `failed` status — either
 * because it exceeded the retry cap (markOutboxAttempt) or because the server
 * returned an irrecoverable 403 (quarantineOutboxEvents).
 */
export const OUTBOX_QUARANTINED = "outbox record quarantined"

// ── TTS provider cutover (AQU-1189) ───────────────────────────────────────

/**
 * Legacy OmniVoice project settings were rewritten onto Inworld and persisted.
 * Fired once per project open that actually writes (localStorage + server
 * mirror), not on the runtime remap that still covers unread copies.
 */
export const OMNIVOICE_VOICES_MIGRATED = "omnivoice voices migrated"

// ── Batch text validation (AQU-1503) ──────────────────────────────────────

/**
 * A bulk text-validation was ATTEMPTED — from the selection toolbar's
 * "Validate text" button or the "Batch validate text…" workspace action.
 *
 * Fires on EVERY attempt, including the ones that validate nothing. That is
 * the whole point: the surface used to bail silently on four branches, and the
 * only way the 2026-09-30 repro could be characterised at all was by the
 * *absence* of events, which cannot distinguish "the click did nothing" from
 * "nobody clicked". Properties carry the cell count and an outcome class
 * (`batchValidateTelemetry` in lib/review/batch-validate-summary.ts).
 */
export const BATCH_VALIDATE_ATTEMPTED = "batch validate attempted"

// ── Cell validation + audio actions (AQU-1572) ────────────────────────────

/**
 * A cell was validated. Unlike `FIRST_CELL_VALIDATE` (a once-per-session
 * milestone) this fires on EVERY validation gesture, and carries `medium`
 * (`text` | `audio`) so the review loop and the dubbing loop can be counted
 * apart. Before this existed, a user toggling validation or working the Audio
 * view left no trace at all — AQU-1571 had to be characterised by screenshot
 * because PostHog had nothing to query.
 */
export const CELL_VALIDATED = "cell validated"

/** Mirror of `CELL_VALIDATED` for the un-validate gesture. */
export const CELL_UNVALIDATED = "cell unvalidated"

/**
 * A clip the user supplied was attached to a cell — an upload, a LinkMedia
 * file, or a linked media URL. Only the *originating* gesture emits; the
 * derived re-attaches (denoise, the transcription's timings write-back,
 * diarization, the recorder's heal path) deliberately do not, or one clip
 * would count several times.
 */
export const AUDIO_ATTACHED = "audio attached"

/** A clip was synthesized for a cell (TTS / voice conversion). */
export const AUDIO_GENERATED = "audio generated"

/** A clip was recorded for a cell through the in-app recorder. */
export const AUDIO_RECORDED = "audio recorded"
