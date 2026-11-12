/**
 * release-gate.ts — the SERVER side of the AI-team / Autopilot release flag.
 *
 * AQU-1246 moved the gate off the device-local browser switch and onto
 * `project_settings.autopilotEnabled`: a project-wide, server-stored opt-in
 * that only project_lead(500)+ may write. What it did NOT do is make the
 * server read it. Until this module, `autopilotEnabled` was consulted in
 * exactly two places — the write floor in routes/project-settings.ts, and
 * `isAutopilotVisible` in the BROWSER — so the flag hid the surface without
 * closing the door behind it: any CONTRIBUTOR could POST
 * /contextual/runs (or /steering, or /react-check) straight at a project
 * that had never opted in, and spend its org's model budget on work nobody
 * switched on.
 *
 * AQU-1050 applies the flag server-side at the four points its description
 * names:
 *
 *   admission          POST /contextual/runs
 *   subsequent AI work the 5-minute cron (stranded-run sweep + react sweep)
 *   retries            POST /contextual/runs/:runId/resume|continue|continue-all
 *   mutations          POST /contextual/steering, /react-check, team messages
 *
 * …under one rule, which is the other half of the ticket: **disabling stops
 * new work while preserving history.** So this gate is deliberately NOT a
 * 404 over the whole surface (the shape the pre-dev donor used). Reads stay
 * open at every level — runs, activity, drafts, decisions, the team channel's
 * message history — because a project that switches Autopilot off still owns
 * everything the agent already did and must be able to read, audit and export
 * it. The same reasoning keeps `pause` and `terminate` ungated (they stop
 * work, they do not start it) and keeps draft review ungated (a human
 * resolving proposals that are already staged is winding the work down, and
 * stranding them behind the flag would make disabling destructive).
 *
 * Default is CLOSED. An absent or malformed value reads as off, matching the
 * client's `isAutopilotVisible({}) === false` exactly: a project that never
 * opted in is not opted in, and the two gates must not disagree about that.
 */

import type { AquillaDb } from "../../../../db/shim/postgres"
import { loadProjectSettings } from "../../../../db/shared/projects"

/** The project-settings key AQU-1246 defined. Mirrors `AUTOPILOT_SETTING_KEY`
 *  in src/lib/features/flags.ts — the client and the server read one name. */
export const AUTOPILOT_RELEASE_KEY = "autopilotEnabled"

/**
 * Has this project opted in?
 *
 * Strictly `=== true`, for the same reason `readAgentMode` is strict about
 * its switches: the settings blob is an unvalidated `Record<string, unknown>`
 * that any client can write any shape into, and a stringy `"true"` is a
 * client bug rather than a lead's consent to spend model budget.
 */
export function readAutopilotReleased(
  settings: Record<string, unknown> | null | undefined,
): boolean {
  return settings?.[AUTOPILOT_RELEASE_KEY] === true
}

/** One settings read, for callers that have a db and a projectId. */
export async function isAutopilotReleased(
  db: AquillaDb,
  projectId: string,
): Promise<boolean> {
  const stored = await loadProjectSettings(db, projectId)
  return readAutopilotReleased(stored.settings)
}

/**
 * The message every gated surface returns, so a client sees one explanation
 * wherever it hits the flag rather than guessing per route.
 */
export const AUTOPILOT_DISABLED_MESSAGE =
  "Autopilot is switched off for this project. A project lead can turn it on in Project settings → Experimental. Existing runs and their history stay readable."
