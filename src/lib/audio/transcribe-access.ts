// AQU-2426: who may transcribe a recording brought in, and why not (Sam, Nov 5:
// "both of those, whichever is stricter").
//
// A person may transcribe when ALL of these hold:
//   1. they can import files in this project (Project settings › Who can import
//      files; Project lead by default, raised by the org to Maintainer);
//   2. they clear the hosted transcription floor (Contributor,
//      auth-worker/src/routes/transcription.ts TRANSCRIBE_MIN_ROLE) — with
//      today's defaults (1) is the stricter;
//   3. the organization can pay: its AI credits are not used up for today or
//      this week (an enforced cap). On this device (Whisper in the browser)
//      nothing is paid, so the credits never stop it.
// Otherwise Transcribe… is shown greyed, with a click (i) saying why. Split at
// pauses is free and never asks.

import { ROLE } from "@/lib/frontier/roles"
import { canImportSourceFiles, importDenialFloor } from "@/lib/sync/role-policy"
import type { OrgCredits } from "@/lib/sync/credits"

/** The hosted route's floor (auth-worker TRANSCRIBE_MIN_ROLE). */
export const TRANSCRIBE_MIN_ROLE = ROLE.CONTRIBUTOR

export type TranscribeBlock =
  | { kind: "import"; floor: number }
  | { kind: "creditsToday" }
  | { kind: "creditsWeek" }

/** Why this person can't transcribe here, or null when they can. */
export function transcribeBlock(args: {
  /** The person's role in the project; null = unknown (a local project): fail open. */
  level: number | null | undefined
  /** The org's import floor (`importMinRole`), when it has one. */
  importMinRole?: number | null
  /** Transcribing on this device: nothing is paid. */
  onDevice: boolean
  /** The org's credits, when this person may read them; null = not known. */
  credits?: Pick<OrgCredits, "config" | "remaining"> | null
}): TranscribeBlock | null {
  const floorRole = args.importMinRole ?? undefined
  if (!canImportSourceFiles(args.level, floorRole) || (args.level != null && args.level < TRANSCRIBE_MIN_ROLE)) {
    return { kind: "import", floor: Math.max(importDenialFloor(floorRole), TRANSCRIBE_MIN_ROLE) }
  }
  if (args.onDevice || !args.credits?.config.enforce) return null
  if (args.credits.remaining.daily <= 0) return { kind: "creditsToday" }
  if (args.credits.remaining.weekly <= 0) return { kind: "creditsWeek" }
  return null
}
