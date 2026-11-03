// A stand-in for useProjectSettings whose writes show on the page, for client
// tests (AQU-2262).
//
// Project settings save the moment they change, and every control shows the
// SAVED value, so a test that changes two things in a row ("Set for this
// project", then the switch) needs the first write to have landed on screen.
// The real hook does that with its optimistic overlay; this does the same:
// each write that `patch` answers "ok" is laid over the settings the test
// supplies, the way the real hook lays its overlay over the server's copy.
//
// Use it inside a `vi.mock` factory (it must not import the hook it replaces):
//
//   vi.mock("@/hooks/useProjectSettings", async (importOriginal) => {
//     const actual = await importOriginal<typeof import("@/hooks/useProjectSettings")>()
//     const { useLiveProjectSettings } = await import("@/test-utils/live-project-settings")
//     return { ...actual, useProjectSettings: () => useLiveProjectSettings(() => ({ settings, patch })) }
//   })
import { useState } from "react"

type Settings = Record<string, unknown>
type Patch = (partial: Settings, opts?: { mergeKeys?: string[] }) => Promise<{ kind: string } | undefined>

export interface LiveProjectSettingsSource {
  /** The server's copy, as the test wants it now. */
  settings: object
  /** What the page's writes go to; its answer decides whether they land. */
  patch: Patch
  /** Anything else the hook returns that the test sets (canEdit, orgMediaDefaults…). */
  [extra: string]: unknown
}

/** `partial` laid over `base`, merging the objects under `mergeKeys`, as the real patch does. */
function laid(base: Settings, partial: Settings, mergeKeys: readonly string[] = []): Settings {
  const next: Settings = { ...base, ...partial }
  for (const key of mergeKeys) {
    const had = base[key]
    const add = partial[key]
    if (!add || typeof add !== "object") continue
    next[key] = { ...(had && typeof had === "object" ? (had as Settings) : {}), ...(add as Settings) }
  }
  return next
}

export function useLiveProjectSettings(source: () => LiveProjectSettingsSource) {
  const now = source()
  const [written, setWritten] = useState<{ partial: Settings; mergeKeys?: string[] }[]>([])
  const settings = written.reduce((s, w) => laid(s, w.partial, w.mergeKeys), now.settings as Settings)
  const patch: Patch = async (partial, opts) => {
    const out = await source().patch(partial, opts)
    if (out?.kind === "ok") setWritten((w) => [...w, { partial, mergeKeys: opts?.mergeKeys }])
    return out
  }
  return {
    canEdit: true,
    reasonCannotEdit: null,
    version: 1,
    updatedAt: null,
    updatedBy: null,
    conflict: false,
    dismissConflict: () => {},
    hasFetched: true,
    isOnline: true,
    refresh: () => {},
    ...now,
    settings,
    patch,
  }
}
