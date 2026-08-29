/**
 * agent-mode.ts — the per-project autonomy dial and the react watcher's
 * bookmark, both read out of the project-settings JSON blob.
 * (docs/superpowers/specs/2026-08-28-agent-social-workspace-design.md §v3.)
 *
 *   agentMode: { initiative, react, scope }
 *   agentReactState: { cursor, lastReactionAt }
 *
 * Settings are an unvalidated `Record<string, unknown>` — the PATCH/PUT route
 * takes `z.record(z.string(), z.unknown())` and passes unknown keys straight
 * through, so ANY client (or an older build, or a hand-edited row) can put an
 * arbitrary shape under these keys. Every reader here therefore parses
 * defensively and falls back to the documented default rather than trusting
 * the blob; a malformed `agentMode` reads as "all off", which is the safe
 * answer for a switch that spends model budget.
 *
 * Note on `initiative`: it is NOT enforced anywhere server-side this round.
 * "Initiative" names the EXISTING manual/autopilot start behaviour (POST
 * /contextual/runs, project-wide fan-out) which is already gated by the
 * CONTRIBUTOR role floor and by a human pressing the button; the field is
 * read by the UI to render the mode control. Only `react` and `scope` have
 * server-side consequences today — `react` selects the projects the watcher
 * sweeps, `scope` chooses the auto-steering wording.
 */

/** What work a reaction (or, later, initiative) may do. */
export type AgentScope = "full" | "qa" | "draft"

export interface AgentMode {
  /** The autopilot loop may pick up new work on its own. UI-only for now. */
  initiative: boolean
  /** Watch project events and respond to human expert input. */
  react: boolean
  scope: AgentScope
}

/** Absent/malformed settings mean every switch is off — so merging this
 *  feature with "flags off" is just the default. */
export const AGENT_MODE_DEFAULT: AgentMode = {
  initiative: false,
  react: false,
  scope: "full",
}

const AGENT_SCOPES: readonly AgentScope[] = ["full", "qa", "draft"]

export const AGENT_MODE_KEY = "agentMode"
export const AGENT_REACT_STATE_KEY = "agentReactState"

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Strictly boolean: a stringy "true" is a client bug, not consent to spend
 *  model budget on a project the operator never switched on. */
function asBool(value: unknown): boolean {
  return value === true
}

function asScope(value: unknown): AgentScope {
  return AGENT_SCOPES.includes(value as AgentScope)
    ? (value as AgentScope)
    : AGENT_MODE_DEFAULT.scope
}

/**
 * The project's autonomy mode, with defaults for everything absent.
 * Never throws and never returns a partial object — callers can read all
 * three fields unconditionally.
 */
export function readAgentMode(settings: Record<string, unknown> | null | undefined): AgentMode {
  const raw = asRecord(settings?.[AGENT_MODE_KEY])
  if (!raw) return { ...AGENT_MODE_DEFAULT }
  return {
    initiative: asBool(raw.initiative),
    react: asBool(raw.react),
    scope: asScope(raw.scope),
  }
}

/**
 * The react watcher's durable bookmark, kept in the same settings blob.
 *
 *   cursor         — epoch millis. Every `events.server_ts <= cursor` has been
 *                    CONSIDERED (acted on, or deliberately skipped). Absent
 *                    means "never swept"; the watcher seeds it from a bounded
 *                    lookback rather than the beginning of the project.
 *   lastReactionAt — fileId → ISO timestamp of the last reaction started on
 *                    that file, the input to the per-file cooldown.
 */
export interface AgentReactState {
  cursor: number | null
  lastReactionAt: Record<string, string>
}

export const AGENT_REACT_STATE_EMPTY: AgentReactState = {
  cursor: null,
  lastReactionAt: {},
}

export function readAgentReactState(
  settings: Record<string, unknown> | null | undefined,
): AgentReactState {
  const raw = asRecord(settings?.[AGENT_REACT_STATE_KEY])
  if (!raw) return { cursor: null, lastReactionAt: {} }
  const cursorValue = Number(raw.cursor)
  const cursor = Number.isFinite(cursorValue) && cursorValue > 0 ? Math.floor(cursorValue) : null
  const reactions = asRecord(raw.lastReactionAt)
  const lastReactionAt: Record<string, string> = {}
  if (reactions) {
    for (const [fileId, at] of Object.entries(reactions)) {
      if (typeof at === "string" && at.length > 0) lastReactionAt[fileId] = at
    }
  }
  return { cursor, lastReactionAt }
}

/** Serialize back into the settings blob's shape. Kept next to the reader so
 *  the two cannot drift. */
export function agentReactStateValue(state: AgentReactState): Record<string, unknown> {
  return {
    cursor: state.cursor,
    lastReactionAt: state.lastReactionAt,
  }
}
