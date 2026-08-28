/**
 * compose-send.ts — the one place that turns composer output into an
 * `AgentSendOptions` for the shared project session store.
 *
 * Extracted from AgentDockView so the Team tab's main-channel composer talks
 * to the SAME conversation with the SAME semantics: slash commands expand
 * into vetted prompts (while the bubble keeps the typed command, CLI-style),
 * chip messages skip expansion because a chip is already a specific ask, and
 * the translator profile is read at send time so a stale render can't send an
 * outdated one. Two composers drifting apart here would mean the same typed
 * text behaved differently depending on which tab it was typed in.
 */

import { serializeWithChips, type ContextChip } from "./context-chip"
import { expandSlashCommand } from "./slash-commands"
import { getTranslatorProfile, profileForPrompt } from "@/lib/translator-profile"
import type { AgentSendOptions } from "./session-store"

export interface ComposeAgentSendInput {
  text: string
  chips?: ContextChip[]
  /** Frontier session JWT; null/empty → nothing is sent. */
  jwt: string | null
  projectId: string
  /** Current file/cell location, sent as run context when present. */
  context?: { fileId?: string; cellId?: string }
  /** Artifacts uploaded alongside this message. */
  artifacts?: { artifactId: string; fileName: string }[]
}

/** Returns null when there is nothing to send (empty prompt, or signed out). */
export function composeAgentSend({
  text,
  chips = [],
  jwt,
  projectId,
  context = {},
  artifacts = [],
}: ComposeAgentSendInput): AgentSendOptions | null {
  if ((!text.trim() && chips.length === 0) || !jwt) return null
  const expanded = chips.length === 0 ? expandSlashCommand(text) : null
  // `display` (with [ref] chips) shows in the bubble; `wire` (tokens + legend)
  // is what the model receives.
  const { wire, display } = expanded
    ? { wire: expanded, display: text.trim() }
    : serializeWithChips(text, chips)
  // The server re-caps every profile field; this just avoids sending an empty
  // object.
  const translatorProfile = profileForPrompt(getTranslatorProfile())
  return {
    wire,
    display,
    jwt,
    request: {
      projectId,
      ...(context.fileId || context.cellId ? { context: { ...context } } : {}),
      ...(translatorProfile ? { translatorProfile } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    },
  }
}
