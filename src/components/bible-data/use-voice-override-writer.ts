// Voice corrections (AQU-1692): saving one.
//
// The settings hook's `patch` merges per top-level key: it re-reads the server
// blob, then sends it with the patch's keys on top. So the whole
// `bibleVoiceOverrides` map in a patch replaces the stored one, and a map built
// from what this tab last saw would silently drop a correction another
// maintainer saved since; no 409 says so, because `patch` always writes
// against the version it just read. This writer re-reads the latest settings
// first and changes only the one speech it was asked to. The window left is
// between that read and `patch`'s own, a moment rather than the time a
// maintainer spends in the dialog.

import { useCallback } from "react"
import type { PatchOutcome } from "@/hooks/useProjectSettings"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ProjectSettingsResponse, ProjectWideSettings } from "@/lib/sync/project-settings"
import {
  readBibleVoiceOverrides,
  type BibleVoiceOverride,
  type BibleVoiceOverrides,
} from "../../../db/shared/bible-voice-overrides"

/** What the maintainer chooses; who and when are stamped on saving. */
export type VoiceOverrideChange = Pick<BibleVoiceOverride, "speaker" | "addressee" | "note">

/** Save (or, with null, remove) the correction of one speech. */
export type SaveVoiceOverride = (speechId: string, change: VoiceOverrideChange | null) => Promise<PatchOutcome>

const FAILURE_KEYS: Readonly<Record<Exclude<PatchOutcome["kind"], "ok">, MessageKey>> = {
  blocked: "bibleVoices.override.failed.role",
  conflict: "bibleVoices.override.failed.conflict",
  error: "bibleVoices.override.failed.error",
}

/** What to tell the maintainer when a save did not go through. */
export function voiceOverrideFailureKey(outcome: Exclude<PatchOutcome, { kind: "ok" }>): MessageKey {
  if (outcome.kind === "blocked" && outcome.reason === "offline") return "bibleVoices.override.failed.offline"
  return FAILURE_KEYS[outcome.kind]
}

/** The map with one speech's correction set, or removed with null. */
export function withVoiceOverride(
  overrides: BibleVoiceOverrides,
  speechId: string,
  entry: BibleVoiceOverride | null,
): BibleVoiceOverrides {
  const next = { ...overrides }
  if (entry) next[speechId] = entry
  else delete next[speechId]
  return next
}

export function useVoiceOverrideWriter(
  /** The latest server settings, or null offline or when the read fails. */
  refresh: () => Promise<ProjectSettingsResponse | null>,
  patch: (partial: ProjectWideSettings) => Promise<PatchOutcome>,
  /** The map this tab has, used only when the latest cannot be read. */
  current: BibleVoiceOverrides | undefined,
  username: string,
): SaveVoiceOverride {
  return useCallback<SaveVoiceOverride>(
    async (speechId, change) => {
      const latest = await refresh()
      const base = readBibleVoiceOverrides(latest ? latest.settings.bibleVoiceOverrides : current)
      const entry = change ? { ...change, by: username, at: new Date().toISOString() } : null
      return patch({ bibleVoiceOverrides: withVoiceOverride(base, speechId, entry) })
    },
    [refresh, patch, current, username],
  )
}
