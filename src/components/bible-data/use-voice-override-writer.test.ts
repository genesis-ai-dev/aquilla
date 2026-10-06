// AQU-1692 — saving a voice correction.
//
// The settings hook re-sends the whole `bibleVoiceOverrides` map, and its
// version check cannot catch a map built from stale state (it writes against
// the version it has just read). So two maintainers correcting different
// speeches would lose one correction silently, unless the writer builds the
// map from the latest settings. These tests pin that it does, that it changes
// only the speech it was asked to, and that it stamps who and when.

import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectSettingsResponse, ProjectWideSettings } from "@/lib/sync/project-settings"
import { useVoiceOverrideWriter } from "./use-voice-override-writer"

const theirs = { speaker: "person:Naomi", note: "Theirs.", by: "olive", at: "2026-10-05T09:00:00.000Z" }
const stale = { speaker: "person:Orpah", note: "Old.", by: "mara", at: "2026-10-01T09:00:00.000Z" }

function response(settings: ProjectWideSettings): ProjectSettingsResponse {
  return { version: 7, updatedAt: "2026-10-05T09:00:00Z", updatedBy: 2, settings }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("useVoiceOverrideWriter", () => {
  it("keeps a correction another maintainer saved since this tab last read the settings", async () => {
    const refresh = vi.fn(async () => response({ bibleVoiceOverrides: { "sp:b-c": theirs } }))
    const patch = vi.fn(async (_partial: ProjectWideSettings) => ({ kind: "ok" as const }))
    // This tab still holds a map without their correction.
    const { result } = renderHook(() => useVoiceOverrideWriter(refresh, patch, { "sp:a-b": stale }, "mara"))

    await result.current("sp:a-b", { speaker: "person:Ruth", note: "Ours." })

    expect(patch).toHaveBeenCalledWith({
      bibleVoiceOverrides: {
        "sp:b-c": theirs,
        "sp:a-b": { speaker: "person:Ruth", note: "Ours.", by: "mara", at: "2026-10-06T12:00:00.000Z" },
      },
    })
  })

  it("removes only the speech it was asked to", async () => {
    const refresh = vi.fn(async () => response({ bibleVoiceOverrides: { "sp:a-b": stale, "sp:b-c": theirs } }))
    const patch = vi.fn(async (_partial: ProjectWideSettings) => ({ kind: "ok" as const }))
    const { result } = renderHook(() => useVoiceOverrideWriter(refresh, patch, undefined, "mara"))

    await result.current("sp:a-b", null)

    expect(patch).toHaveBeenCalledWith({ bibleVoiceOverrides: { "sp:b-c": theirs } })
  })

  it("falls back to this tab's map when the latest cannot be read, and returns the save's outcome", async () => {
    // Offline: refresh reads nothing, and patch says so; the dialog shows it.
    const refresh = vi.fn(async () => null)
    const patch = vi.fn(async (_partial: ProjectWideSettings) => ({ kind: "blocked" as const, reason: "offline" as const }))
    const { result } = renderHook(() => useVoiceOverrideWriter(refresh, patch, { "sp:b-c": theirs }, "mara"))

    const outcome = await result.current("sp:a-b", { addressee: "person:Naomi", note: "Ours." })

    expect(outcome).toEqual({ kind: "blocked", reason: "offline" })
    expect(Object.keys(patch.mock.calls[0][0].bibleVoiceOverrides ?? {})).toEqual(["sp:b-c", "sp:a-b"])
  })
})
