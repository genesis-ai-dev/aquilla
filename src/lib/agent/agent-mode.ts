/**
 * agent-mode.ts — the agent's autonomy dial (v3 of the 2026-08-28
 * social-workspace design).
 *
 * The team's autonomy is not a single on/off: it is two independent loops and
 * a scope. `initiative` lets the team pick up new work by itself; `react`
 * lets it respond to human edits it sees land in the project; `scope` bounds
 * what either loop is allowed to do. ALL OFF is the default, deliberately —
 * a project that merges this change behaves exactly as it did before, and
 * every autonomous behaviour is something a human switched on.
 *
 * The presets below are the five combinations worth naming. They are UI over
 * the same three fields, never a fourth stored value: `presetFor()` reads the
 * stored mode back and reports which preset it happens to be (or "custom"),
 * so a mode hand-edited into an unnamed combination still renders honestly.
 *
 * Storage is `ProjectWideSettings.agentMode` — the ordinary shared
 * project-settings row, patched through the same PATCH path every other
 * synced setting uses (`lib/sync/project-settings.ts`). That is what makes it
 * project-wide rather than per-device: autonomy that only one collaborator
 * could see would be autonomy nobody had agreed to.
 */

import type { MessageKey } from "@/lib/i18n/messages/en"
import {
  PROJECT_SETTINGS_VERSION_INITIAL,
  fetchProjectSettingsResult,
  patchProjectSettings,
} from "@/lib/sync/project-settings"

/** What autonomous work the team may do. */
export type AgentModeScope = "full" | "qa" | "draft"

export interface AgentMode {
  /** The autopilot loop may pick up new work on its own. */
  initiative: boolean
  /** Watch project events and respond to human expert input. */
  react: boolean
  /** What work reactions/initiative may do. */
  scope: AgentModeScope
}

/** Everything off, full scope — the behaviour of a project that never opted in. */
export const DEFAULT_AGENT_MODE: AgentMode = {
  initiative: false,
  react: false,
  scope: "full",
}

export const AGENT_MODE_SCOPES: readonly AgentModeScope[] = ["full", "qa", "draft"]

export type AgentModePresetId =
  | "fullAutopilot"
  | "reactOnly"
  | "qaOnly"
  | "draftOnly"
  | "off"

export interface AgentModePreset {
  id: AgentModePresetId
  mode: AgentMode
  nameKey: MessageKey
  descriptionKey: MessageKey
}

/** Ordered most-autonomous to least — the chip row reads as a dial. */
export const AGENT_MODE_PRESETS: readonly AgentModePreset[] = [
  {
    id: "fullAutopilot",
    mode: { initiative: true, react: true, scope: "full" },
    nameKey: "agent.mode.preset.fullAutopilot",
    descriptionKey: "agent.mode.preset.fullAutopilotDescription",
  },
  {
    id: "reactOnly",
    mode: { initiative: false, react: true, scope: "full" },
    nameKey: "agent.mode.preset.reactOnly",
    descriptionKey: "agent.mode.preset.reactOnlyDescription",
  },
  {
    id: "qaOnly",
    mode: { initiative: false, react: true, scope: "qa" },
    nameKey: "agent.mode.preset.qaOnly",
    descriptionKey: "agent.mode.preset.qaOnlyDescription",
  },
  {
    id: "draftOnly",
    mode: { initiative: true, react: false, scope: "draft" },
    nameKey: "agent.mode.preset.draftOnly",
    descriptionKey: "agent.mode.preset.draftOnlyDescription",
  },
  {
    id: "off",
    mode: DEFAULT_AGENT_MODE,
    nameKey: "agent.mode.preset.off",
    descriptionKey: "agent.mode.preset.offDescription",
  },
]

/** Short label for whatever mode is stored — the popover trigger's whole text. */
export const AGENT_MODE_CUSTOM_NAME_KEY: MessageKey = "agent.mode.preset.custom"
export const AGENT_MODE_CUSTOM_DESCRIPTION_KEY: MessageKey =
  "agent.mode.preset.customDescription"

export function agentModeEquals(a: AgentMode, b: AgentMode): boolean {
  return a.initiative === b.initiative && a.react === b.react && a.scope === b.scope
}

/**
 * Which named preset `mode` IS, or "custom" when it is a combination we chose
 * not to name. Deliberately derived rather than stored: the switches can
 * always be moved individually, so a stored preset id would go stale the
 * moment someone flipped one of them.
 */
export function presetFor(mode: AgentMode): AgentModePresetId | "custom" {
  const match = AGENT_MODE_PRESETS.find((preset) => agentModeEquals(preset.mode, mode))
  return match ? match.id : "custom"
}

/** The name key for the mode's current preset, including the custom fallback. */
export function agentModeNameKey(mode: AgentMode): MessageKey {
  const match = AGENT_MODE_PRESETS.find((preset) => agentModeEquals(preset.mode, mode))
  return match ? match.nameKey : AGENT_MODE_CUSTOM_NAME_KEY
}

/** The one-line explanation for the mode's current preset. */
export function agentModeDescriptionKey(mode: AgentMode): MessageKey {
  const match = AGENT_MODE_PRESETS.find((preset) => agentModeEquals(preset.mode, mode))
  return match ? match.descriptionKey : AGENT_MODE_CUSTOM_DESCRIPTION_KEY
}

function isScope(value: unknown): value is AgentModeScope {
  return value === "full" || value === "qa" || value === "draft"
}

/**
 * Coerce whatever the settings row holds into a usable mode. Anything missing
 * or malformed falls back to the default field-by-field, so a partially
 * written row (an older server, a half-applied patch) can never read as MORE
 * autonomy than was actually stored.
 */
export function normalizeAgentMode(value: unknown): AgentMode {
  if (!value || typeof value !== "object") return DEFAULT_AGENT_MODE
  const row = value as Record<string, unknown>
  return {
    initiative: row.initiative === true,
    react: row.react === true,
    scope: isScope(row.scope) ? row.scope : DEFAULT_AGENT_MODE.scope,
  }
}

// ── Read / patch over the shared project-settings row ────────────────────────

export interface AgentModeState {
  mode: AgentMode
  /** Settings-row version, required by the PATCH's optimistic-concurrency check. */
  version: number
}

export type AgentModePatchOutcome =
  | { kind: "ok"; state: AgentModeState }
  /** Below PROJECT_LEAD — the settings route refuses the write. */
  | { kind: "forbidden" }
  | { kind: "error"; message: string }

/**
 * Read the project's agent mode. `null` means the request itself failed and
 * the mode is UNKNOWN — callers must not render that as "everything is off",
 * which would claim the agent is idle when it may not be.
 */
export async function fetchAgentMode(
  jwt: string,
  projectId: string,
): Promise<AgentModeState | null> {
  const result = await fetchProjectSettingsResult(jwt, projectId)
  if (!result.ok) return null
  if (!result.value) {
    // The server answered "no settings row" — that IS the default mode.
    return { mode: DEFAULT_AGENT_MODE, version: PROJECT_SETTINGS_VERSION_INITIAL }
  }
  return {
    mode: normalizeAgentMode(result.value.settings.agentMode),
    version: result.value.version,
  }
}

/**
 * Write a new mode. The settings row is shared, so a collaborator saving an
 * unrelated key between our read and our write is ordinary rather than
 * exceptional: one conflict is retried against the version the server just
 * handed back, and only a second failure is reported.
 */
export async function patchAgentMode(
  jwt: string,
  projectId: string,
  mode: AgentMode,
  ifMatchVersion: number,
): Promise<AgentModePatchOutcome> {
  let version = ifMatchVersion
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await patchProjectSettings(jwt, projectId, { agentMode: mode }, version)
    if (result.kind === "ok") {
      return {
        kind: "ok",
        state: {
          mode: normalizeAgentMode(result.value.settings.agentMode),
          version: result.value.version,
        },
      }
    }
    if (result.kind === "forbidden") return { kind: "forbidden" }
    if (result.kind === "conflict") {
      version = result.latest.version
      continue
    }
    return { kind: "error", message: result.message }
  }
  return { kind: "error", message: "settings version conflict" }
}
